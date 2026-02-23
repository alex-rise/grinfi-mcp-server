---
name: grinfi-mcp
description: "Use this skill for any task involving Grinfi CRM and outreach automation via MCP. Triggers include: managing contacts or leads, checking unread messages or inbox, sending LinkedIn or email messages, adding contacts to automations or sequences, updating pipeline stages, creating or canceling tasks, managing automations (start/stop/clone), searching or filtering contacts, handling follow-ups, processing inbox replies, booking demos, blacklisting contacts, and any operations with Grinfi sender profiles or mailboxes. Use when the user says 'check inbox', 'add to automation', 'send message', 'update pipeline', 'find contact', 'create task', 'stop automation', or any similar outreach and CRM workflow."
metadata:
  mcp-server: grinfi
  version: 1.0.0
---

# Grinfi MCP - Workflow Guide

Grinfi is a LinkedIn + Email outreach automation platform. This skill guides optimal use of the Grinfi MCP server for CRM management, inbox processing, lead handling, and automation workflows.

---

## Core Concepts

**Contacts (leads)** - prospects in the CRM. Every contact has a UUID used in all API calls.

**Sender profiles** - LinkedIn/email accounts used for outreach. Each sender_profile has its own UUID. Always confirm which sender profile to use before sending messages.

**Automations (flows)** - multi-step outreach sequences. Contacts can be added, paused, continued, or removed from automations.

**Pipeline stages** - track where a lead is in the sales process. Change via `change_contact_pipeline_stage`, not `update_contact`.

**Tasks** - scheduled manual actions (LinkedIn messages, follow-ups). Created with a schedule_at timestamp in UTC ISO 8601.

---

## Step 1: Finding Contacts

Use `find_contact` when you have a LinkedIn URL, email, or name + company.

Use `search_contacts` for filtered queries. Supports operators:
- Scalar: `{ "field": "value" }` - exact match
- Array: `{ "field": ["a", "b"] }` - IN filter
- Object: `{ "field": { ">=": "value" } }` - comparison operators
- Null checks: `"is_null"` / `"is_not_null"`

Results include `_grinfi_contact_url` and `_linkedin_url` for each contact.

---

## Step 2: Reading Conversation History

Before composing any message, always fetch the full conversation history:

```
list_linkedin_messages(lead_uuid=UUID, order_field="sent_at", order_type="asc")
```

This returns messages from ALL sender profiles - critical for avoiding repetition or contradictions.

For email threads use `get_email_llm_thread` or `list_emails` filtered by `lead_uuid`.

**Key rule:** Never compose a reply without checking what was already sent from all profiles.

---

## Step 3: Processing Unread Messages

For inbox processing:

1. `get_unread_conversations(limit=300)` - fetch contacts with unread messages
2. For each contact: `list_linkedin_messages` (full history, asc) + `get_contact`
3. Classify the lead based on their reply
4. Propose a response - wait for user confirmation before sending
5. After confirmation: send -> stop automation -> mark read -> create task

**Classification signals:**

| Response type | Action |
|---|---|
| Requests demo/pricing/info | HOT - full pitch + Calendly, stop automation, task 1 week |
| Shows interest, wants to check | WARM - soft push, stop automation, task 1-1.5 weeks |
| Neutral ("ok", thumbs up) on early message | Continue automation |
| Neutral after 10+ messages | Likely polite close - stop automation |
| Clear rejection | Stop automation, pipeline -> НЕ ЦА, no task |
| Not ICP (student, no team, not decision-maker) | Stop automation, mark read, no reply, no task |

---

## Step 4: Sending Messages

**LinkedIn:**
```
send_linkedin_message(lead_uuid, sender_profile_uuid, text)
```

**Email:**
```
send_email(from_email, from_name, lead_uuid, sender_profile_uuid, subject, to_email, to_name)
```

Always confirm message content with the user before sending. Never send without approval.

---

## Step 5: Managing Automations

**Stop all automations for a contact** (after manual reply or rejection):
```
cancel_contact_from_all_automations(lead_uuid)
```

**Continue automation** (neutral early response):
```
continue_automation(lead_uuid)
```

**Add contact to automation:**
- Existing contact: `add_contact_to_automation(flow_uuid, lead_uuid)`
- New contact: `add_new_contact_to_automation(flow_uuid, linkedin_id, list_uuid, ...)`

**Start/stop automations:**
```
start_automation(flow_uuid)
stop_automation(flow_uuid)
```

---

## Step 6: Pipeline Stage Updates

Use `change_contact_pipeline_stage`, not `update_contact` (which does not support pipeline_stage_uuid).

```
change_contact_pipeline_stage(contact_uuids=[UUID], pipeline_stage_uuid=STAGE_UUID)
```

List available stages: `list_pipeline_stages(object="lead")`

---

## Step 7: Creating Tasks

Tasks schedule manual outreach actions. Always create in UTC.

```
create_task(
  lead_uuid=UUID,
  sender_profile_uuid=UUID,
  text="Message content or note",
  schedule_at="2026-03-03T08:00:00.000000Z",
  type="linkedin_send_message",
  timezone="UTC",
  note="Optional context note"
)
```

**Task timing guidelines:**
- HOT lead follow-up: +1 week
- WARM lead follow-up: +1 to 1.5 weeks
- Competitor users: +1 week
- Price inquiry: +2 weeks
- Cold/silent leads (3-4+ months): +3-4 weeks
- Rejections and not-ICP: no task

Schedule at ~10:00 local time for the lead's timezone. Convert to UTC before creating.

Common timezone offsets:
- UTC+2: Ukraine (Europe/Kyiv)
- UTC+1: Spain (Europe/Madrid)
- UTC+4: Georgia (Asia/Tbilisi)
- UTC+5: Pakistan (Asia/Karachi)
- UTC+5:30: India (Asia/Kolkata)

---

## Step 8: After Sending a Manual Reply

For HOT and WARM leads after sending a manual response:

1. `cancel_contact_from_all_automations(lead_uuid)` - stop all sequences
2. `change_contact_pipeline_stage` -> active negotiations stage
3. `mark_conversation_as_read(lead_uuid)`
4. `create_task(...)` - schedule follow-up ping

---

## Notes

- `list_linkedin_messages` search parameter does not work (field "q" error) - use other filters instead
- `list_mailbox_errors` search parameter also does not work - use pagination/ordering
- `update_contact` cannot change pipeline_stage_uuid - always use `change_contact_pipeline_stage`
- Tasks must use ISO 8601 with UTC timezone in schedule_at field
- `get_unread_conversations` scans recent inbox messages and returns contacts with unread counts - use this for inbox processing workflows

---

## Mass Processing Workflow (30+ unread)

1. `get_unread_conversations(limit=300)`
2. Sort into: HOT / REJECTION / NEUTRAL
3. Process rejections in batch: stop automation + mark read + pipeline update
4. Process HOT leads one by one with full cycle
5. NEUTRAL: check message count, decide continue vs stop

---

## Troubleshooting

**"field q is not allowed" error on list_linkedin_messages or list_mailbox_errors**
Cause: search parameter not supported on these endpoints.
Solution: Remove search parameter, use filters or pagination instead.

**Pipeline stage not updating via update_contact**
Cause: update_contact does not support pipeline_stage_uuid.
Solution: Use `change_contact_pipeline_stage` with the correct UUID.

**Contact not found by find_contact**
Cause: LinkedIn URL format varies.
Solution: Try both the full URL and just the LinkedIn ID/handle. Also try search_contacts with name + company filter.
