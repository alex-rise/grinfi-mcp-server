# Grinfi MCP Server

Connect **Claude AI** to your **[Grinfi.io](https://grinfi.io)** account via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Manage contacts, automations, LinkedIn messages, emails, and more — all through natural language.

## Prerequisites

- **Node.js 18+** — [download here](https://nodejs.org)
- **Claude Desktop** or **Claude Code**
- **Grinfi.io account** with an API key

## Quick Install

### 1. Get your API key

Go to **[Grinfi.io](https://grinfi.io)** → **Settings** → **API Keys** and copy your key.

### 2. Clone this repo

```bash
git clone https://github.com/alex-rise/grinfi-mcp-server.git
cd grinfi-mcp-server
```

### 3. Run the installer

**macOS / Linux:**

```bash
bash install.sh
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer will:
- Check that Node.js is installed
- Ask for your Grinfi API key
- Install dependencies and build the server
- Automatically configure Claude Desktop

### 4. Restart Claude Desktop

Quit and reopen Claude Desktop. You'll see **grinfi** in the MCP tools list (hammer icon).

## Manual Setup

If you prefer to configure manually:

### Install & Build

```bash
npm install
npm run build
```

### Claude Desktop

Add this to your config file:

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

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

### Claude Code

```bash
claude mcp add grinfi -- env GRINFI_API_KEY=your-api-key-here node /full/path/to/grinfi-mcp-server/dist/index.js
```

## Available Tools

### Contacts

| Tool | Description |
|---|---|
| `find_contact` | Find by LinkedIn, email, or name + company |
| `search_contacts` | Search with filters, sorting, pagination |
| `get_contact` | Get contact by UUID |
| `update_contact` | Update contact fields |
| `delete_contact` | Delete a contact |
| `upsert_contact` | Create or update a contact in a list |

### Lists

| Tool | Description |
|---|---|
| `list_lists` | Get all contact lists |
| `get_list` | Get list by UUID |
| `create_list` | Create a new list |

### Automations

| Tool | Description |
|---|---|
| `list_automations` | Get all automations |
| `start_automation` | Start an automation |
| `stop_automation` | Stop an automation |
| `add_contact_to_automation` | Add contact to automation |
| `add_new_contact_to_automation` | Create contact and add to automation |
| `cancel_contact_from_automations` | Cancel from specific automations |
| `cancel_contact_from_all_automations` | Cancel from all automations |
| `continue_automation` | Resume paused automation |

### Tasks

| Tool | Description |
|---|---|
| `create_task` | Schedule a task (LinkedIn message, connection request, etc.) |

### Messages (Unibox)

| Tool | Description |
|---|---|
| `list_linkedin_messages` | List LinkedIn messages |
| `send_linkedin_message` | Send a LinkedIn message |
| `get_unread_conversations` | Get contacts with unread messages |
| `mark_conversation_as_read` | Mark conversation as read |
| `list_emails` | List emails |
| `send_email` | Send an email |

### Sender Profiles

| Tool | Description |
|---|---|
| `list_sender_profiles` | List all sender profiles |
| `get_sender_profile` | Get profile details |
| `create_sender_profile` | Create a new profile |

## Usage Examples

**Find a contact:**
> "Find the contact with email john@example.com"

**Search with filters:**
> "Show me contacts at Google created after January 2024"

**Manage automations:**
> "List my automations and start the one called Outreach EU"

**Send messages:**
> "Send a LinkedIn message to John saying 'Hi, let's connect!'"

**Check inbox:**
> "Do I have any unread messages?"

## Troubleshooting

**"GRINFI_API_KEY is not set"** — Make sure your API key is in the Claude config file under `env.GRINFI_API_KEY`.

**Tools not showing in Claude** — Restart Claude Desktop completely (quit, not just close). Check that the path to `dist/index.js` is absolute.

**API errors (401/403)** — Your API key may be invalid. Generate a new one at Grinfi.io → Settings → API Keys.

**Build errors:**
```bash
rm -rf node_modules dist
npm install
npm run build
```

## License

MIT
