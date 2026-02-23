# Grinfi MCP Server

Connect **Claude AI** to your **[Grinfi.io](https://grinfi.io)** account and manage your outreach through natural language - no clicking through interfaces, no copy-pasting between tools.

With this integration you can ask Claude things like:

- *"Check my unread LinkedIn messages and summarize who replied"*
- *"Add these 3 contacts to the Outreach EU automation"*
- *"Find John from Acme Corp and send him a follow-up"*
- *"Show me all HOT leads from this week"*
- *"Create a follow-up task for Maria in 1 week"*

---

## What you need before starting

- **Node.js 18 or newer** - [download here](https://nodejs.org) (if unsure, run `node -v` in your terminal)
- **Claude Desktop** or **Claude Code**
- **A Grinfi.io account** with an API key

---

## Installation

### Step 1 - Get your Grinfi API key

Log in to [Grinfi.io](https://grinfi.io) → go to **Settings** → **API Keys** → copy your key.

### Step 2 - Clone the repo

```bash
git clone https://github.com/alex-rise/grinfi-mcp-server.git
cd grinfi-mcp-server
```

### Step 3 - Run the installer

**macOS / Linux:**
Double-click `install.sh`, or run in terminal:
```bash
bash install.sh
```

**Windows:**
Double-click `install.ps1`, or run in PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

> **Note for macOS:** If double-click doesn't work, right-click the file → Open With → Terminal.

The installer will ask for your API key, install everything, configure Claude Desktop, and install the skill file automatically.

### Step 4 - Restart Claude Desktop

Quit and reopen Claude Desktop. You should see **grinfi** in the tools list (hammer icon in the bottom left).

That's it - you're ready.

---

## Manual setup (optional)

If you prefer to configure things yourself instead of using the installer:

```bash
npm install
npm run build
```

Then add the following to your Claude Desktop config file:

| OS | Config file location |
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

**For Claude Code:**
```bash
claude mcp add grinfi -- env GRINFI_API_KEY=your-api-key-here node /full/path/to/grinfi-mcp-server/dist/index.js
```

---

## Skill file (for Claude Code)

The installer automatically places a **skill file** at:

| OS | Skill file location |
|---|---|
| macOS / Linux | `~/.claude/skills/grinfi-mcp/SKILL.md` |
| Windows | `%USERPROFILE%\.claude\skills\grinfi-mcp\SKILL.md` |

The skill file teaches Claude how to use Grinfi tools efficiently — how to process inbox, classify leads, schedule follow-ups, and manage automations. It's loaded automatically by Claude Code.

### What the skill includes

- Step-by-step workflows for inbox processing
- Lead classification rules (HOT / WARM / NEUTRAL / REJECTION)
- Task scheduling guidelines with timezone handling
- Pipeline management best practices
- Mass processing workflow for 30+ unread messages
- Known API quirks and workarounds

### Editing the skill

If you want to customize how Claude works with your Grinfi account, edit the skill file directly:

```bash
# macOS / Linux
nano ~/.claude/skills/grinfi-mcp/SKILL.md

# Or open in any editor
code ~/.claude/skills/grinfi-mcp/SKILL.md
```

The source file is also in the repo root: `SKILL.md`. If you want to reset to defaults, re-run the installer or copy it manually:

```bash
cp SKILL.md ~/.claude/skills/grinfi-mcp/SKILL.md
```


## What Claude can do with Grinfi

### Contacts and lists
- Find contacts by LinkedIn URL, email, or name
- Search and filter your CRM with any criteria
- Create, update, and organize contacts into lists

### Automations
- Start, stop, and monitor your outreach sequences
- Add or remove contacts from automations
- Resume paused automations for contacts who replied

### Inbox (LinkedIn + Email)
- Check unread conversations across all sender profiles
- Read and summarize message threads
- Send LinkedIn messages and emails directly
- Mark conversations as read

### Tasks and follow-ups
- Schedule follow-up tasks for specific dates
- View and manage your task queue
- Bulk complete or cancel tasks

### Pipeline management
- Move contacts between pipeline stages
- Track where each lead is in your sales process

### Sender profiles and mailboxes
- View all your connected LinkedIn and email accounts
- Check mailbox status and sending limits

---

## Troubleshooting

**"GRINFI_API_KEY is not set"**
Your API key isn't being passed to the server. Double-check it's in the config file under `env.GRINFI_API_KEY` - no extra spaces or quotes.

**Tools not showing up in Claude**
Restart Claude Desktop completely (quit, not just close the window). Make sure the path to `dist/index.js` in your config is the full absolute path.

**401 or 403 API errors**
Your API key is invalid or expired. Go to Grinfi.io → Settings → API Keys and generate a new one.

**Build errors or something broke after an update**
```bash
rm -rf node_modules dist
npm install
npm run build
```

**Skill not working in Claude Code**
Check that the file exists at `~/.claude/skills/grinfi-mcp/SKILL.md`. If not, copy it manually from the repo root: `cp SKILL.md ~/.claude/skills/grinfi-mcp/SKILL.md`

---

## License

MIT
