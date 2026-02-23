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
echo -e "${CYAN}${BOLD}   Grinfi MCP Server — Quick Install    ${NC}"
echo -e "${CYAN}${BOLD}========================================${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed.${NC}"
    echo -e "Please install Node.js 18+ from ${CYAN}https://nodejs.org${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Node.js 18+ is required. You have $(node -v).${NC}"
    echo -e "Please update from ${CYAN}https://nodejs.org${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"

# Get API key
echo ""
echo -e "${BOLD}Step 1: Enter your Grinfi API key${NC}"
echo -e "  Get it from: ${CYAN}Grinfi.io → Settings → API Keys${NC}"
echo ""
read -rp "  API Key: " GRINFI_API_KEY

if [ -z "$GRINFI_API_KEY" ]; then
    echo -e "${RED}API key cannot be empty.${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} API key saved"

# Install & build
echo ""
echo -e "${BOLD}Step 2: Installing dependencies...${NC}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm install --silent 2>&1 | tail -1
echo -e "${GREEN}✓${NC} Dependencies installed"

npm run build --silent 2>&1
echo -e "${GREEN}✓${NC} Server built"

# Detect config path
echo ""
echo -e "${BOLD}Step 3: Configuring Claude Desktop...${NC}"

if [[ "$OSTYPE" == "darwin"* ]]; then
    CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CLAUDE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
else
    echo -e "${YELLOW}Could not detect OS. Please configure manually (see README).${NC}"
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
                echo -e "${GREEN}✓${NC} Merged into existing config"
            else
                echo -e "${YELLOW}Could not merge automatically. Writing new config.${NC}"
                cat > "$CONFIG_FILE" <<JSONEOF2
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF2
                echo -e "${GREEN}✓${NC} Config written"
            fi
        else
            cat > "$CONFIG_FILE" <<JSONEOF3
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF3
            echo -e "${GREEN}✓${NC} Config written"
        fi
    else
        cat > "$CONFIG_FILE" <<JSONEOF4
{
  "mcpServers": {
    "grinfi": $NEW_SERVER
  }
}
JSONEOF4
        echo -e "${GREEN}✓${NC} Config created"
    fi
fi

# Install Claude Code skill
echo ""
echo -e "${BOLD}Step 4: Installing Claude Code skill...${NC}"

SKILL_SOURCE="$SCRIPT_DIR/SKILL.md"
SKILL_DIR="$HOME/.claude/skills/grinfi-mcp"

if [ -f "$SKILL_SOURCE" ]; then
    mkdir -p "$SKILL_DIR"
    cp "$SKILL_SOURCE" "$SKILL_DIR/SKILL.md"
    echo -e "${GREEN}✓${NC} Skill installed to ${CYAN}$SKILL_DIR/SKILL.md${NC}"
else
    echo -e "${YELLOW}⚠ SKILL.md not found in repo — skipping skill install${NC}"
fi

# Done
echo ""
echo -e "${GREEN}${BOLD}========================================${NC}"
echo -e "${GREEN}${BOLD}   Installation Complete!                ${NC}"
echo -e "${GREEN}${BOLD}========================================${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. Restart Claude Desktop (quit and reopen)"
echo -e "  2. Look for ${CYAN}grinfi${NC} in the MCP tools list (hammer icon)"
echo -e "  3. Try: ${CYAN}\"Show me all my Grinfi contacts\"${NC}"
echo ""
echo -e "  Config: ${YELLOW}$CONFIG_FILE${NC}"
echo -e "  Skill:  ${YELLOW}$SKILL_DIR/SKILL.md${NC}"
echo ""
