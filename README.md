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

1. Open the **grinfi-mcp-server** folder in Finder
2. **Double-click `install.sh`**
3. When prompted, paste your **Grinfi API key** and press Enter

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
2. **Double-click `install.bat`**
3. If Windows shows a security warning ("Windows protected your PC"), click **"More info"** then **"Run anyway"**
4. When prompted, paste your **Grinfi API key** and press Enter

The installer will automatically:
- Install **Node.js** via winget (if not installed)
- Install all dependencies and build the server
- Configure Claude Desktop

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

### CSV Import / Export *(new in 1.1)*

| Tool | Description |
|------|-------------|
| `upload_csv` | Upload a CSV file from local disk; returns a file_import UUID |
| `import_leads_from_file` | Import contacts from an uploaded CSV with column mapping |
| `import_companies_from_file` | Import companies from an uploaded CSV |
| `export_leads_csv` | Queue a CSV export of contacts matching a filter |
| `export_companies_csv` | Queue a CSV export of companies matching a filter |
| `download_export` | Get the download payload for a queued export |

### Lead Enrichment & Analytics *(new in 1.1)*

| Tool | Description |
|------|-------------|
| `enrich_leads` | Trigger advanced LinkedIn enrichment for contacts |
| `count_leads` | Count contacts matching a filter |
| `get_leads_metrics` | Get team engagement metrics for contacts |

### Automation Folders & Enrollment *(new in 1.1)*

| Tool | Description |
|------|-------------|
| `list_flow_workspaces` | List automation folders |
| `create_flow_workspace` | Create a new automation folder |
| `update_flow_workspace` | Rename or update a folder |
| `delete_flow_workspace` | Delete a folder (automations inside are not deleted) |
| `list_flow_leads` | Search contacts enrolled in automations |
| `delete_flow_lead_history` | Delete a contact's automation history (full erase) |

### AI Agents & Templates — full CRUD *(new in 1.1)*

| Tool | Description |
|------|-------------|
| `create_ai_agent` | Create a new AI agent |
| `update_ai_agent` | Update an AI agent |
| `delete_ai_agent` | Delete an AI agent |
| `update_ai_template` | Update an AI template |
| `delete_ai_template` | Delete an AI template |

### Closures *(new in 1.1)*

| Tool | Description |
|------|-------------|
| `upload_attachment` | Upload a local file as an attachment |
| `remove_from_leads_blacklist` | Remove a contact from the leads blacklist |
| `remove_from_companies_blacklist` | Remove a company from the companies blacklist |
| `update_custom_field` | Rename a custom field or change order |
| `delete_custom_field` | Delete a custom field (and all its values) |

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

If double-click doesn't work, open Terminal and run:
```
bash /Users/yourname/Documents/grinfi-mcp-server/install.sh
```

### Installer won't start (Windows)

Make sure you're double-clicking **`install.bat`** (not `install.ps1`). If Windows blocks it, click "More info" → "Run anyway".

If that doesn't work, open PowerShell manually (press `Win + X`, choose "PowerShell"), then run:
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
