# Grinfi MCP Server

Connect **Claude** to your **Grinfi.io** account. Manage contacts, automations, messages, and more — all through natural language.

---

## Quick Start

### 1. Get your API key

Go to **[Grinfi → Settings → API Keys](https://leadgen.grinfi.io/settings/api-keys)** and copy your key.

### 2. Download this repository

Click the green **"Code"** button above → **"Download ZIP"**, then unzip it.

Or clone with Git:
```bash
git clone https://github.com/alex-rise/grinfi-mcp-server.git
```

### 3. Run the installer for your OS

---

## macOS Installation

### Option A: Use the installer (recommended)

1. Open **Terminal** (press `Cmd + Space`, type **Terminal**, press Enter)
2. Type `bash ` (with a space after it)
3. **Drag the `install.sh` file** from Finder into the Terminal window — the path fills in automatically
4. Press **Enter**
5. When prompted, paste your **Grinfi API key** and press Enter

The installer will automatically:
- Install **Homebrew** (if not installed)
- Install **Node.js** (if not installed)
- Install all dependencies and build the server
- Configure Claude Desktop

> **Note:** If macOS asks for your password, enter your Mac login password and press Enter. This is normal — it's installing system packages.

### Option B: Manual setup (macOS)

```bash
cd grinfi-mcp-server
npm install
npm run build
```

Then add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grinfi": {
      "command": "node",
      "args": ["/full/path/to/grinfi-mcp-server/dist/index.js"],
      "env": {
        "GRINFI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

## Windows Installation

### Option A: Use the installer (recommended)

1. Open the **grinfi-mcp-server** folder in File Explorer
2. Right-click on **`install.ps1`**
3. Select **"Run with PowerShell"**
4. If Windows shows a security warning, type **R** and press Enter
5. When prompted, paste your **Grinfi API key** and press Enter

The installer will automatically:
- Install **Node.js** via winget (if not installed)
- Install all dependencies and build the server
- Configure Claude Desktop

> **If right-click doesn't show "Run with PowerShell":** Open PowerShell manually (press `Win + X`, choose "PowerShell"), then run:
> ```powershell
> cd "$HOME\Documents\grinfi-mcp-server"
> powershell -ExecutionPolicy Bypass -File install.ps1
> ```

### Option B: Manual setup (Windows)

```powershell
cd grinfi-mcp-server
npm install
npm run build
```

Then add this to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grinfi": {
      "command": "node",
      "args": ["C:/full/path/to/grinfi-mcp-server/dist/index.js"],
      "env": {
        "GRINFI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

## After Installation (All Platforms)

1. **Restart Claude Desktop** — quit completely (not just close the window) and reopen
2. Look for **"grinfi"** in the tools list (hammer icon at the bottom of the chat)
3. Start chatting! Try: *"Show me all my contacts"*

---

## Claude Code Configuration

```bash
claude mcp add grinfi -- node /full/path/to/grinfi-mcp-server/dist/index.js
```

Then set the environment variable before running Claude Code:

```bash
export GRINFI_API_KEY="your-api-key-here"
claude
```

---

## Cloud Endpoint (Paid Claude plans)

If you have a paid Claude plan, you can use our hosted cloud endpoint — no local installation needed.

Visit **[mcp.grinfi.io](https://mcp.grinfi.io)** to generate your personal MCP endpoint URL.

---

## Available Tools

### Contacts

| Tool | Description |
|------|-------------|
| `find_contact` | Find a contact by LinkedIn ID, email, or name + company |
| `search_contacts` | Search contacts with filters, sorting, pagination |
| `get_contact` | Get contact details by UUID |
| `update_contact` | Update contact fields |
| `delete_contact` | Delete a contact |
| `upsert_contact` | Create or update a contact in a list |

### Lists

| Tool | Description |
|------|-------------|
| `list_lists` | Get all contact lists |
| `get_list` | Get a list by UUID |
| `create_list` | Create a new list |

### Automations

| Tool | Description |
|------|-------------|
| `list_automations` | Get all automations |
| `start_automation` | Start an automation |
| `stop_automation` | Stop an automation |
| `add_contact_to_automation` | Add existing contact to automation |
| `add_new_contact_to_automation` | Create contact and add to automation |
| `cancel_contact_from_automations` | Cancel contact from specific automations |
| `cancel_contact_from_all_automations` | Cancel contact from all automations |

### Unibox (Messages)

| Tool | Description |
|------|-------------|
| `list_linkedin_messages` | List LinkedIn messages |
| `get_unread_conversations` | Get contacts with unread messages |
| `mark_conversation_as_read` | Mark a LinkedIn conversation as read |
| `send_linkedin_message` | Send a LinkedIn message |
| `list_emails` | List emails |
| `send_email` | Send an email |

### Sender Profiles

| Tool | Description |
|------|-------------|
| `list_sender_profiles` | List all sender profiles |
| `get_sender_profile` | Get sender profile details |
| `create_sender_profile` | Create a new sender profile |

---

## Example Conversations

**Find a contact:**
> "Find the contact with email john@example.com"

**Search with filters:**
> "Show me contacts at Google created after January 2024"

**Manage automations:**
> "List my automations and start the one called CMO Germany"

**Send messages:**
> "Send a LinkedIn message to Anna saying we have a new case study"

---

## Troubleshooting

### "GRINFI_API_KEY is not set"

Make sure your API key is configured. Re-run the installer or edit the Claude Desktop config file manually (see Manual Setup sections above).

### Tools not showing in Claude

1. Make sure Claude Desktop is **fully restarted** (quit and reopen, not just close window)
2. Check the config file path is correct for your OS
3. Make sure the path to `dist/index.js` is absolute (starts with `/` on Mac or `C:\` on Windows)

### API errors (401/403)

Your API key may be invalid or expired. Generate a new one in [Grinfi → Settings → API Keys](https://leadgen.grinfi.io/settings/api-keys).

### Build errors

```bash
cd grinfi-mcp-server
rm -rf node_modules dist
npm install
npm run build
```

### Installer won't start (Mac)

Make sure you typed `bash ` (with a space) before dragging the file. The full command should look like:
```
bash /Users/yourname/Documents/grinfi-mcp-server/install.sh
```

### PowerShell error (Windows)

Try running PowerShell as Administrator: right-click PowerShell in Start menu → "Run as administrator", then:
```powershell
cd "$HOME\Documents\grinfi-mcp-server"
powershell -ExecutionPolicy Bypass -File install.ps1
```

---

## Requirements

- **Node.js 18+** — installed automatically by the installer, or [download manually](https://nodejs.org)
- **Claude Desktop** — [download here](https://claude.com/download)
- **Grinfi.io account** with an API key

---

## License

MIT
