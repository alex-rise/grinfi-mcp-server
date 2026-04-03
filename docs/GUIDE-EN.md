# Grinfi MCP — Complete Guide

**Connect Claude AI to Grinfi and manage your entire outreach workflow using plain English.**

With Grinfi MCP, you talk to Claude and Claude does the work inside Grinfi — finding contacts, launching automations, writing emails, managing tasks, and much more. No clicking through menus, no copy-pasting data between tabs.

---

## How to Connect

There are three ways to use Grinfi MCP, depending on which Claude product you use.

### Option 1 — Claude.ai (browser, no setup needed)

1. Open [claude.ai](https://claude.ai) → go to **Settings → Integrations**
2. Click **Add Integration** and paste: `https://mcp.grinfi.io`
3. Claude will ask you to log in with your Grinfi email and password
4. Done — Claude now has full access to your Grinfi workspace

### Option 2 — Claude Code (terminal)

Run this in your terminal:

```bash
claude mcp add grinfi --transport http https://mcp.grinfi.io
```

Claude Code will open a browser tab for OAuth login. After logging in, all MCP tools are available in your terminal session.

### Option 3 — Claude Desktop (local install)

1. Download the [Grinfi MCP repository](https://github.com/alex-rise/grinfi-mcp-server) (green "Code" → "Download ZIP")
2. Get your API key from **Grinfi → Settings → API Keys**
3. Run the installer:
   - **macOS/Linux:** double-click `install.sh` or run `./install.sh` in terminal
   - **Windows:** double-click `install.bat`
4. Paste your API key when prompted
5. Restart Claude Desktop

> **Multi-team setup:** If you manage multiple Grinfi workspaces, set the `GRINFI_TEAM_KEYS` environment variable with comma-separated `teamId:apiKey` pairs. Use `list_my_teams` and `switch_team` to switch between workspaces mid-conversation.

---

## What Claude Can Do in Grinfi

Grinfi MCP gives Claude **158 tools** organized into 14 functional areas. Below is a practical guide to each one.

---

### 1. Contacts

Find, create, update, and manage your leads. Claude can look up a contact by LinkedIn URL, email, or name — and enrich the result with direct links to their Grinfi profile and LinkedIn page.

**Tools:** `find_contact`, `get_contact`, `search_contacts`, `update_contact`, `delete_contact`, `upsert_contact`, `add_contact_to_automation`, `add_new_contact_to_automation`, `cancel_contact_from_automations`, `cancel_contact_from_all_automations`, `change_contact_pipeline_stage`

**Example prompts:**
- *"Find the contact with LinkedIn URL linkedin.com/in/john-smith and show me their details"*
- *"Search for all contacts at Stripe who haven't been contacted yet"*
- *"Update Maria Garcia's job title to VP of Engineering"*
- *"Move all contacts tagged 'hot-lead' to the 'Negotiation' pipeline stage"*
- *"Add John to the Q2 Outreach automation"*

---

### 2. Companies

Manage your company CRM — create company records, look them up by LinkedIn or website, enrich data, and search for employees.

**Tools:** `list_companies`, `get_company`, `create_companies`, `update_company`, `delete_company`, `lookup_companies`, `search_company_leads`, `enrich_companies`

**Example prompts:**
- *"Find the company Acme Corp on LinkedIn and add it to Grinfi"*
- *"Look up all employees at companies we have in our database that work in Finance"*
- *"Enrich the top 50 companies in our list with LinkedIn data"*
- *"Show me all contacts at Stripe"*

---

### 3. Contact Lists

Organize contacts into lists for targeting specific segments in automations.

**Tools:** `list_lists`, `get_list`, `create_list`, `update_list`, `delete_list`, `get_list_metrics`

**Example prompts:**
- *"Create a new list called 'Series B Startups — Q2'"*
- *"How many contacts are in the 'Enterprise Prospects' list?"*
- *"Show me all my contact lists with their sizes"*

---

### 4. Automations

Launch, stop, clone, and monitor your outreach sequences. Claude can check performance metrics, manage automation lifecycles, and even update settings.

**Tools:** `list_automations`, `get_automation`, `start_automation`, `stop_automation`, `archive_automation`, `unarchive_automation`, `clone_automation`, `update_automation`, `delete_automation`, `get_automation_metrics`

**Example prompts:**
- *"Show me all active automations and their reply rates"*
- *"Clone the 'Cold Outreach SaaS' automation and rename it 'Cold Outreach Fintech'"*
- *"Stop all automations that have been running for more than 30 days"*
- *"What's the open rate on the 'Q1 Campaign' automation?"*
- *"Archive all automations from last year"*

---

### 5. Automation Folders

Organize your automations into folders to keep your workspace clean.

**Tools:** `list_automation_folders`, `create_automation_folder`, `update_automation_folder`, `delete_automation_folder`

**Example prompts:**
- *"Create a folder called 'Q2 2026 Campaigns'"*
- *"List all my automation folders"*
- *"Rename the folder 'Old Campaigns' to 'Archive 2025'"*

---

### 6. Tasks (Manual Actions)

View, complete, skip, or bulk-process manual tasks that your automations generate — LinkedIn messages to review, connection requests to send, emails to approve.

**Tools:** `list_tasks`, `get_task`, `create_task`, `complete_task`, `cancel_task`, `fail_task`, `mass_complete_tasks`, `mass_cancel_tasks`, `mass_retry_tasks`, `mass_skip_tasks`, `get_tasks_group_counts`, `get_tasks_schedule`, `continue_automation`

**Example prompts:**
- *"Show me all pending LinkedIn message tasks for today"*
- *"Complete all tasks that have been waiting for more than 3 days"*
- *"Schedule a LinkedIn message to Alex Johnson for tomorrow at 10am"*
- *"How many tasks do I have in each status?"*
- *"Skip all tasks for contacts from companies we've already closed"*

---

### 7. LinkedIn Browsers

Manage the LinkedIn browser sessions that power your outreach — check status, start/stop sessions, configure proxies, and share browsers with teammates.

**Tools:** `list_linkedin_browsers`, `get_linkedin_browser`, `create_linkedin_browser`, `delete_linkedin_browser`, `run_linkedin_browser`, `stop_linkedin_browser`, `set_linkedin_browser_proxy`, `share_linkedin_browser`

**Example prompts:**
- *"Show me all LinkedIn browser sessions and their current status"*
- *"Start the browser session for Anna's sender profile"*
- *"Change the proxy country for browser #3 to Germany"*
- *"Share browser profile #5 with colleague@company.com"*

---

### 8. Sender Profiles

Manage the LinkedIn and email accounts you send from. Enable/disable them, set working hours schedules, and configure smart limits.

**Tools:** `list_sender_profiles`, `get_sender_profile`, `create_sender_profile`, `update_sender_profile`, `delete_sender_profile`, `enable_sender_profile`, `disable_sender_profile`

**Example prompts:**
- *"Show all sender profiles and which ones are currently active"*
- *"Set working hours for John's profile to Monday–Friday 9am–6pm Berlin time"*
- *"Disable all sender profiles except the main one"*
- *"Enable smart limits for all profiles"*

---

### 9. Email & LinkedIn Messaging

Read incoming messages, send replies, manage your unified inbox, and get conversation context.

**Tools:** `list_emails`, `get_email`, `get_email_body`, `get_email_thread`, `get_email_llm_thread`, `send_email`, `delete_email`, `get_latest_emails_by_leads`, `list_email_bodies`, `get_unread_conversations`, `list_linkedin_messages`, `send_linkedin_message`, `delete_linkedin_message`, `retry_linkedin_message`, `mark_conversation_as_read`

**Example prompts:**
- *"Show me all unread conversations from today"*
- *"What did Sarah from Acme Corp reply to our last message?"*
- *"Draft and send a follow-up email to all leads who opened our email but didn't reply"*
- *"Get the full conversation thread with michael@techcorp.com"*
- *"Send a LinkedIn message to the 5 contacts who replied to our campaign this week"*

---

### 10. Mailboxes

Manage your email sending accounts — create, configure, activate, and diagnose issues.

**Tools:** `list_mailboxes`, `get_mailbox`, `create_mailbox`, `update_mailbox`, `delete_mailbox`, `activate_mailbox`, `deactivate_mailbox`, `list_mailbox_errors`

**Example prompts:**
- *"Show me all mailboxes and their sending status"*
- *"Are there any errors with our mailboxes? List all recent issues"*
- *"Deactivate the outreach@company.com mailbox while we're on vacation"*

---

### 11. Data Sources

Manage LinkedIn import jobs — import contacts from Sales Navigator searches, LinkedIn lists, network connections, post engagements, and more.

**Tools:** `list_data_sources`, `get_data_source`, `create_data_source`, `update_data_source`, `delete_data_source`

**Example prompts:**
- *"Show me all active LinkedIn import jobs"*
- *"Create an import from my LinkedIn network connections into the 'Network 2026' list"*
- *"What's the status of the Sales Navigator import I started yesterday?"*

---

### 12. Tags, Pipeline Stages & Custom Fields

Organize and segment your database with tags, custom pipeline stages, and custom fields.

**Tools:** `list_tags`, `create_tag`, `update_tag`, `delete_tag`, `get_tag_metrics` · `list_pipeline_stages`, `create_pipeline_stage`, `update_pipeline_stage`, `delete_pipeline_stage` · `list_custom_fields`, `create_custom_field`, `upsert_custom_field_value`

**Example prompts:**
- *"Create a tag called 'ICP — Enterprise' with green color"*
- *"How many leads and companies have the 'hot-lead' tag?"*
- *"Add a new pipeline stage called 'Demo Scheduled' between Engaged and Replied"*
- *"Set the 'deal_size' custom field for Stripe to $50,000"*

---

### 13. AI Features

Use Grinfi's built-in AI agents and templates for automated message personalization, variable generation, and LLM integrations.

**Tools:** `list_ai_agents`, `get_ai_agent`, `list_ai_templates`, `get_ai_template`, `create_ai_template`, `render_ai_template`, `list_ai_variables`, `ai_ask` · `list_llms`, `get_llm`, `create_llm`, `update_llm`, `delete_llm`, `generate_llm_response`, `get_llm_metrics`, `list_llm_logs`, `get_llm_log`

**Example prompts:**
- *"List all AI templates and show me which ones are most used"*
- *"Render the 'Personalized Opening Line' template for John Smith at Acme Corp"*
- *"Add our company's OpenAI API key so Grinfi can use GPT-4 for message generation"*
- *"How many AI credits did we use this month?"*

---

### 14. Webhooks, Notes, Activities & Attachments

Complete workflow management — track activities, add notes, set up event notifications, manage files.

**Tools:** `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook`, `test_webhook`, `get_webhook_metrics` · `list_notes`, `get_note`, `create_note`, `update_note`, `delete_note` · `list_activities`, `create_activity` · `list_attachments`, `get_attachment`, `upload_attachment`, `delete_attachment`

**Example prompts:**
- *"Create a webhook that fires when a contact replies to our LinkedIn message"*
- *"Test the CRM sync webhook and show me the response"*
- *"Add a note to John Smith's profile: 'Interested in the Enterprise plan, call back in 2 weeks'"*
- *"Show me all activities for leads we contacted this week"*

---

### 15. Account & Team Management

Get current user info, list workspaces, and switch between teams.

**Tools:** `get_current_user`, `list_teams`, `get_team`, `list_my_teams`, `switch_team`

**Example prompts:**
- *"Which Grinfi account am I connected to right now?"*
- *"Show me all my workspaces"*
- *"Switch to the European team workspace"*

---

### 16. Mass Actions & Blacklists

Apply bulk operations across hundreds of contacts or companies at once.

**Tools:** `leads_mass_action`, `companies_mass_action`, `list_leads_blacklist`, `add_to_leads_blacklist`, `list_companies_blacklist`, `add_to_companies_blacklist`

**Example prompts:**
- *"Add the tag 'Q2-Follow-Up' to all 300 contacts in the 'Webinar Attendees' list"*
- *"Move all contacts in the 'Churned' list to the 'Lost' pipeline stage"*
- *"Add competitor.com to the company blacklist so we never contact their employees"*
- *"Delete all contacts imported before January 2025 that never responded"*

---

### 17. Enrichment & Tracking Domains

Monitor LinkedIn data enrichment progress and manage custom domains for email tracking.

**Tools:** `list_enrichment_queue`, `get_enrichment_metrics` · `list_custom_tracking_domains`, `get_custom_tracking_domain`, `create_custom_tracking_domain`

---

## Real Workflow Examples

These are full multi-step workflows you can describe to Claude in one message:

---

**Morning review:**
> *"Check my unread conversations, list today's pending tasks, and show me which automations had replies in the last 24 hours"*

---

**Launching a new campaign:**
> *"Clone the 'SaaS Cold Outreach' automation, rename it 'Fintech Q2 2026', move it to the 'Q2 Campaigns' folder, then add all contacts from the 'Series B Fintech' list to it"*

---

**Researching a reply:**
> *"Find the contact who replied to our campaign today, show me their full conversation history, their company info, what stage they're in, and any notes on their profile"*

---

**Bulk cleanup:**
> *"Find all contacts in the 'Old Leads 2024' list who were never contacted, add the tag 'archive-2024', move them to the 'Archived' pipeline stage, and remove them from all active automations"*

---

**Setting up a new sender:**
> *"Create a sender profile for Anna Müller, set her working hours to Monday–Friday 8am–5pm Berlin time with smart limits enabled, then link it to a LinkedIn browser with a German proxy"*

---

## Tips for Best Results

- **Be specific about names** — if you have multiple automations with similar names, include keywords to help Claude identify the right one
- **Claude remembers context** — within a conversation, Claude knows what contacts, automations, or data you've already discussed
- **Ask for confirmation** on destructive actions — Claude will ask you before deleting contacts or stopping active automations
- **Combine tools naturally** — you can ask Claude to look something up and immediately act on it in the same message

---

## Support & Links

- **Grinfi:** [grinfi.io](https://grinfi.io)
- **MCP Server (GitHub):** [github.com/alex-rise/grinfi-mcp-server](https://github.com/alex-rise/grinfi-mcp-server)
- **Cloud MCP URL:** `https://mcp.grinfi.io`
