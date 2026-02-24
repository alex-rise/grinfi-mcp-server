#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${CYAN}${BOLD}========================================${NC}"
echo -e "${CYAN}${BOLD}   Grinfi MCP Server - Quick Install    ${NC}"
echo -e "${CYAN}${BOLD}        for macOS / Linux                ${NC}"
echo -e "${CYAN}${BOLD}========================================${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ----- Node.js -----
install_node_mac() {
    # Try Homebrew first
    if command -v brew &> /dev/null; then
        echo -e "${YELLOW}Installing Node.js via Homebrew...${NC}"
        brew install node
        return $?
    fi

    # Install Homebrew, then Node.js
    echo -e "${YELLOW}Homebrew not found. Installing Homebrew first...${NC}"
    echo -e "  (This is the official macOS package manager - ${CYAN}https://brew.sh${NC})"
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Homebrew may need to be added to PATH after install
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi

    echo -e "${YELLOW}Installing Node.js via Homebrew...${NC}"
    brew install node
}

install_node_linux() {
    echo -e "${YELLOW}Installing Node.js...${NC}"
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
    elif command -v pacman &> /dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    else
        echo -e "${RED}Could not detect package manager.${NC}"
        echo -e "Please install Node.js 18+ manually from ${CYAN}https://nodejs.org${NC}"
        exit 1
    fi
}

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "${GREEN}OK${NC} Node.js $(node -v) detected"
    else
        echo -e "${YELLOW}Node.js $(node -v) is too old (need 18+). Updating...${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            install_node_mac
        else
            install_node_linux
        fi
        echo -e "${GREEN}OK${NC} Node.js $(node -v) installed"
    fi
else
    echo -e "${YELLOW}Node.js not found. Installing automatically...${NC}"
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        install_node_mac
    else
        install_node_linux
    fi
    echo ""
    echo -e "${GREEN}OK${NC} Node.js $(node -v) installed"
fi

# ----- API Key -----
echo ""
echo -e "${BOLD}Enter your Grinfi API key${NC}"
echo -e "  Get it from: ${CYAN}https://leadgen.grinfi.io/settings/api-keys${NC}"
echo ""
read -rp "  API Key: " GRINFI_API_KEY

if [ -z "$GRINFI_API_KEY" ]; then
    echo -e "${RED}API key cannot be empty.${NC}"
    exit 1
fi

echo -e "${GREEN}OK${NC} API key saved"

# ----- Install & Build -----
echo ""
echo -e "${BOLD}Installing dependencies...${NC}"
npm install --silent 2>&1 | tail -1
echo -e "${GREEN}OK${NC} Dependencies installed"

echo -e "${BOLD}Building server...${NC}"
npm run build --silent 2>&1
echo -e "${GREEN}OK${NC} Server built"

# ----- Configure Claude Desktop -----
echo ""
echo -e "${BOLD}Configuring Claude Desktop...${NC}"

if [[ "$OSTYPE" == "darwin"* ]]; then
    CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CLAUDE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
else
    CLAUDE_CONFIG_DIR=""
fi

SERVER_PATH="$SCRIPT_DIR/dist/index.js"
CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

if [ -n "$CLAUDE_CONFIG_DIR" ]; then
    mkdir -p "$CLAUDE_CONFIG_DIR"

    NEW_SERVER=$(cat <<JSONEOF
{
    "command": "node",
    "args": ["$SERVER_PATH"],
    "env": {
        "GRINFI_API_KEY": "$GRINFI_API_KEY"
    }
}
JSONEOF
)

    if [ -f "$CONFIG_FILE" ]; then
        if command -v python3 &> /dev/null; then
            python3 << PYBLOCK
import json
config_path = '$CONFIG_FILE'
new_server_json = '''$NEW_SERVER'''
with open(config_path, 'r') as f:
    config = json.load(f)
config.setdefault('mcpServers', {})
config['mcpServers']['grinfi'] = json.loads(new_server_json)
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
print('merged')
PYBLOCK
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}OK${NC} Merged into existing config"
            else
                echo -e "${YELLOW}Could not merge. Writing new config.${NC}"
                cat > "$CONFIG_FILE" <<JSONEOF2
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF2
                echo -e "${GREEN}OK${NC} Config written"
            fi
        else
            cat > "$CONFIG_FILE" <<JSONEOF3
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF3
            echo -e "${GREEN}OK${NC} Config written"
        fi
    else
        cat > "$CONFIG_FILE" <<JSONEOF4
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF4
        echo -e "${GREEN}OK${NC} Config created"
    fi
fi

# ----- Install Claude Code skill -----
echo ""
echo -e "${BOLD}Installing Claude Code skill...${NC}"

SKILL_SOURCE="$SCRIPT_DIR/SKILL.md"
SKILL_DIR="$HOME/.claude/skills/grinfi-mcp"

if [ -f "$SKILL_SOURCE" ]; then
    mkdir -p "$SKILL_DIR"
    cp "$SKILL_SOURCE" "$SKILL_DIR/SKILL.md"
    echo -e "${GREEN}OK${NC} Skill installed to ${CYAN}$SKILL_DIR/SKILL.md${NC}"
else
    echo -e "${YELLOW}SKILL.md not found - skipping skill install${NC}"
fi

# ----- Done -----
echo ""
echo -e "${GREEN}${BOLD}========================================${NC}"
echo -e "${GREEN}${BOLD}   Installation Complete!                ${NC}"
echo -e "${GREEN}${BOLD}========================================${NC}"
echo ""
echo -e "  ${BOLD}What to do now:${NC}"
echo -e "  1. ${BOLD}Quit${NC} Claude Desktop completely (right-click dock icon > Quit)"
echo -e "  2. ${BOLD}Reopen${NC} Claude Desktop"
echo -e "  3. Look for ${CYAN}grinfi${NC} in the tools list (hammer icon)"
echo -e "  4. Try: ${CYAN}\"Show me all my Grinfi contacts\"${NC}"
echo ""
echo -e "  Config: ${YELLOW}$CONFIG_FILE${NC}"
echo ""
