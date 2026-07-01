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

### Automation Folders & Enrollment

| Tool | Description |
|------|-------------|
| `list_automation_folders` | List automation folders *(renamed from `list_flow_workspaces` in 1.2)* |
| `create_automation_folder` | Create a new automation folder *(renamed in 1.2)* |
| `update_automation_folder` | Rename or change display order *(renamed in 1.2)* |
| `delete_automation_folder` | Delete a folder (automations inside are not deleted) *(renamed in 1.2)* |
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

### Failed-task triage *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `diagnose_failed_tasks` | Read-only triage: failure breakdown by error code, per-sender, sample tasks, pattern hints (captcha/proxy/rate-limit detection) |
| `restart_failed_tasks` | Bulk-retry failed automation tasks (filter or explicit UUIDs); supports `dry_run` |
| `skip_failed_tasks` | Bulk-skip failed tasks (lead progresses to next node) |
| `restart_failed_tasks_from_top` | Re-enrol matched leads from the start of a flow; optionally swap to a different sender |

### Workspace dashboard & health *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `workspace_health_check` | Single-call 6-section operational overview: today/yesterday counts, LinkedIn fleet, mailbox health, active flows, failed tasks |
| `get_dashboard` | CRM analytics widgets: activities-over-time, conversion-funnel, pipeline-distribution, sender-performance, response-rate |
| `send_volume_report` | Period-aware outreach event counts with flexible group_by (type, status, flow, sender, day, week) |
| `diagnose_mailbox` | Deep mailbox health diagnosis with detected issues + recommendations |
| `get_health_snapshots` | Fleet-wide LinkedIn account snapshot (status, cookie, health score, daily caps) |

### LinkedIn browsers *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `list_linkedin_browsers` | List all LinkedIn browser profiles |
| `get_linkedin_browser` | Get a browser by ID |
| `create_linkedin_browser` | Create a browser linked to a sender profile |
| `delete_linkedin_browser` | Delete a browser (irreversible) |
| `run_linkedin_browser` / `stop_linkedin_browser` | Start / stop a browser session |
| `set_linkedin_browser_proxy` | Change proxy country |
| `share_linkedin_browser` | Share browser access with team members by email |
| `diagnose_linkedin_browser` | Deep health diagnosis on one browser (cookie, health score, limits, proxy) |

### Data sources (LinkedIn import jobs) *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `list_data_sources` / `get_data_source` | Discover & inspect import jobs |
| `create_data_source` | Create import from CSV / Sales Navigator / LinkedIn search / post engagement |
| `update_data_source` / `delete_data_source` | Edit or remove an import job |

### Account & teams *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `get_current_user` | Authenticated user profile |
| `list_teams` | All teams accessible via the Grinfi API (vs `list_my_teams` for locally-configured keys) |
| `get_team` | Team details by numeric ID |

### Integrations & diagnostics *(new in 1.2)*

| Tool | Description |
|------|-------------|
| `call_external_api` | Ad-hoc outbound HTTP request (SSRF-protected, public URLs only, 1MB cap) |
| `list_outbound_log` | Outbound HTTP log: webhook deliveries, automation API calls, enrichment requests |
| `test_llm_connection` | Smoke-test a stored LLM integration (~5 token cost) |

### CRM read & helpers *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `get_leads_by_uuids` | Fetch multiple contacts by their UUIDs in one round-trip |
| `list_lead_uuids` | Lightweight UUID-only listing of leads matching a filter (much smaller than `search_contacts`) |
| `list_company_uuids` | Lightweight UUID-only listing of companies matching a filter |
| `suggest_lead_filter_values` | Typeahead suggestions for contact filter fields — discover valid values to filter by |
| `suggest_company_filter_values` | Typeahead suggestions for company filter fields |
| `create_lead` | Create one or more leads in a target list (bulk-friendly alternative to `upsert_contact`) |

### Metrics & statistics *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `get_custom_field_metrics` | Usage metrics for custom fields — how many records have a value set |
| `get_pipeline_stage_metrics` | Funnel analytics: how many leads/companies sit in each pipeline stage |
| `get_sender_profile_metrics` | Per-sender analytics: sends, replies, bounces, response-rate |
| `get_outreach_metrics` | High-level outreach analytics in one call: connection requests sent vs accepted, messages, replies |
| `get_ai_agent_lead_metrics` | Performance metrics for AI agents — leads engaged by engagement status |
| `get_flow_node_statistics` | Per-step funnel for an automation: how many leads passed each node and where they dropped off |
| `get_flow_contact_source_statistics` | Per-contact-source breakdown of leads inside an automation |
| `get_enrichment_queue_metrics_filtered` | Enrichment-queue metrics for the current month, optionally narrowed by a filter |
| `get_enrichment_queue_item` | Fetch a single enrichment-queue item by numeric ID (provider, status, cost, target) |

### Mass actions *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `leads_mass_action_by_filter` | Default filter-based bulk contact op — server fetches UUIDs, chunks them, applies the action (supports `dry_run`) |
| `list_mass_actions` | Browse the history of mass-action jobs run on this workspace |
| `get_mass_action_status` | Poll the status of a specific mass-action job by UUID |
| `get_mass_action_metrics` | Execution metrics for mass-action jobs — progress, succeeded/failed counts |
| `cancel_mass_action` | Abort a still-running mass-action job before it finishes |

### CSV bulk update *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `update_leads_from_csv` | Bulk-update existing contacts from a local CSV (matched by uuid/email) |
| `update_companies_from_csv` | Bulk-update existing companies from a local CSV |
| `add_to_blacklist_from_csv` | Bulk-add contacts to the blacklist from a local CSV (emails, LinkedIn IDs, or UUIDs) |

> These take a local `file_path` (like `upload_csv`) — the server reads the file from disk.

### Lead imports — LinkedIn / Sales Navigator *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `import_ln_leads_search` | Queue a regular LinkedIn (non-Sales-Navigator) people-search import |
| `import_ln_my_network` | Queue an import of your own LinkedIn 1st-degree connections |
| `import_post_engagement` | Harvest people who liked, reposted, or commented on a specific LinkedIn post |
| `import_sn_accounts_search` | Queue a Sales Navigator company search import |
| `import_sn_dynamic_search` | Queue an import from a Sales Navigator ad-hoc (non-saved) search URL |
| `import_sn_saved_search` | Queue an import from a Sales Navigator saved search URL |

### Tasks *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `list_tasks_simple` | Simple GET-based automation-tasks listing with query-string pagination |
| `count_tasks` | Count automation tasks matching a filter without fetching the rows |
| `get_task_metrics` | Task-execution metrics aggregated by sender profile and status |
| `update_task` | Update editable fields of an automation task (reschedule, reassign, edit payload) |

### Flows / automations *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `create_flow` | Create a brand-new automation from scratch with custom nodes (steps) |
| `publish_flow_publicly` | Make a flow accessible via a public share link |
| `get_public_flow` | Fetch the public/shared definition of a flow by its share UUID (read-only) |
| `get_all_sender_profiles_for_flows` | Return every sender profile referenced by a list of flow UUIDs, in one call |

### Mailboxes & sender profiles *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `activate_mailboxes_bulk` | Enable sending on a set of mailboxes in one call |
| `deactivate_mailboxes_bulk` | Pause sending on a set of mailboxes in one call |
| `reconnect_mailbox_smtp` | Re-establish a mailbox's SMTP connection with fresh credentials |
| `setup_mailbox_tracking_domain` | Attach a custom (branded) open/click tracking domain to a mailbox |
| `remove_mailbox_tracking_domain` | Revert a mailbox's tracking to the default platform domain |
| `detect_email_provider` | Detect the email provider (Gmail, Outlook, Yandex, custom SMTP) for an address via MX lookup |
| `check_sender_status` | One-call dispatch-readiness check for a sender across LinkedIn + email channels |
| `disable_smart_limits_for_sender` | Turn off smart-limits enforcement on a sender profile |
| `enable_smart_limits_for_sender` | Turn on smart-limits enforcement (throttle near daily safety limits) |
| `list_sender_profiles_filtered` | Browse sender profiles with filtering, sorting, and pagination |

### LinkedIn browsers — external cloud *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `update_linkedin_browser` | Update a LinkedIn browser profile by internal ID (name, proxy, sharing) |
| `check_linkedin_browser_proxy` | Test a proxy configuration before assigning it to a browser |
| `connect_linkedin_browser_to_external_cloud` | Connect a browser profile to an external cloud runner via a shared access key |
| `generate_external_browser_access_key` | Mint an external-cloud access key for a LinkedIn browser profile |
| `run_linkedin_browser_external` | Start a browser session in an externally-hosted environment via a pre-shared access key |

### Export webhooks *(new in 1.3)*

| Tool | Description |
|------|-------------|
| `trigger_lead_export_webhook` | Manually fire the "lead exported" webhook for a set of leads (replay a delivery) |
| `trigger_company_export_webhook` | Manually fire the "company exported" webhook for a set of companies |

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
