#!/usr/bin/env node

/**
 * HTTP transport wrapper for Grinfi MCP server.
 * Exposes the MCP server over Streamable HTTP so it can be accessed remotely.
 *
 * Usage:
 *   GRINFI_API_KEY=xxx MCP_API_KEY=your-secret-key node dist/http-server.js
 *
 * Environment variables:
 *   GRINFI_API_KEY  - Your Grinfi API key (required)
 *   MCP_API_KEY     - Secret key to protect this MCP endpoint (required)
 *   PORT            - HTTP port (default: 3000)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// --- Re-use the same server setup from index.ts ---
// We import the shared logic by re-declaring it here to keep it self-contained.

const BASE_URL = "https://leadgen.grinfi.io";

function getApiKey(): string {
  const key = process.env.GRINFI_API_KEY;
  if (!key) {
    throw new Error(
      "GRINFI_API_KEY environment variable is not set. " +
        "Get your API key from Grinfi.io → Settings → API Keys."
    );
  }
  return key;
}

function getMcpApiKey(): string {
  const key = process.env.MCP_API_KEY;
  if (!key) {
    throw new Error("MCP_API_KEY environment variable is not set. Set a secret key to protect this endpoint.");
  }
  return key;
}

async function grinfiRequest(
  method: string,
  path: string,
  body?: unknown,
  queryParams?: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders,
  };

  const options: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (response.status === 204) {
    return { success: true, message: "Operation completed successfully (204 No Content)" };
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Grinfi API error ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawResponse: text };
  }
}

function enrichLeadWithLinks(lead: Record<string, unknown>): Record<string, unknown> {
  if (lead.uuid) {
    lead._grinfi_contact_url = `https://leadgen.grinfi.io/crm/contacts/${lead.uuid}`;
  }
  if (lead.linkedin) {
    lead._linkedin_url = `https://www.linkedin.com/in/${lead.linkedin}`;
  }
  return lead;
}

function enrichResult(data: unknown): unknown {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (obj.lead && typeof obj.lead === "object") {
      enrichLeadWithLinks(obj.lead as Record<string, unknown>);
    }
    if (Array.isArray(obj.data)) {
      for (const item of obj.data) {
        if (item && typeof item === "object") {
          const entry = item as Record<string, unknown>;
          if (entry.lead && typeof entry.lead === "object") {
            enrichLeadWithLinks(entry.lead as Record<string, unknown>);
          }
          if (entry.uuid && !entry.lead) {
            enrichLeadWithLinks(entry);
          }
        }
      }
    }
    if (obj.uuid && obj.name) {
      enrichLeadWithLinks(obj);
    }
  }
  return data;
}

// --- Build MCP server with all tools ---

function loadSkillInstructions(): string {
  try {
    // Try loading SKILL.md from project root (one level up from dist/)
    const skillPath = join(__dirname, "..", "SKILL.md");
    const raw = readFileSync(skillPath, "utf-8");
    // Strip YAML frontmatter (between --- markers)
    const stripped = raw.replace(/^---[\s\S]*?---\s*/, "");
    return stripped.trim();
  } catch {
    return "";
  }
}

function createMcpServer(): McpServer {
  const instructions = loadSkillInstructions();
  const server = new McpServer(
    { name: "grinfi", version: "1.0.0" },
    instructions ? { instructions } : undefined
  );

  // CONTACTS
  server.tool(
    "find_contact",
    "Find a single contact by LinkedIn ID, email, or name + company. You must provide at least one: linkedin_id, email, or both name and company_name. Results include _grinfi_contact_url (https://leadgen.grinfi.io/crm/contacts/{uuid}) and _linkedin_url. The Grinfi messenger is at https://leadgen.grinfi.io/messenger/",
    {
      linkedin_id: z.string().optional().describe("LinkedIn profile URL or ID"),
      email: z.string().optional().describe("Email address"),
      name: z.string().optional().describe("Contact's full name"),
      company_name: z.string().optional().describe("Company name"),
      disable_aggregation: z.boolean().optional().describe("Disable data aggregation"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.linkedin_id) body.linkedin_id = params.linkedin_id;
      if (params.email) body.email = params.email;
      if (params.name) body.name = params.name;
      if (params.company_name) body.company_name = params.company_name;
      if (params.disable_aggregation !== undefined)
        body.disable_aggregation = params.disable_aggregation;
      const result = await grinfiRequest("POST", "/leads/api/leads/lookup-one", body);
      return { content: [{ type: "text" as const, text: JSON.stringify(enrichResult(result), null, 2) }] };
    }
  );

  server.tool(
    "search_contacts",
    "Search contacts with filters, sorting, and pagination. Filter supports: scalar values (equals), arrays (IN), objects with operators (>=, <=, >, <, =, !=, <>), 'is_null', 'is_not_null'. Results include _grinfi_contact_url (https://leadgen.grinfi.io/crm/contacts/{uuid}) and _linkedin_url for each contact.",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter object"),
      limit: z.number().optional().describe("Number of results to return (default 20)"),
      offset: z.number().optional().describe("Number of results to skip (default 0)"),
      order_field: z.string().optional().describe("Field to sort by (default: created_at)"),
      order_type: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
      disable_aggregation: z.boolean().optional().describe("Disable data aggregation"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.offset !== undefined) body.offset = params.offset;
      if (params.order_field) body.order_field = params.order_field;
      if (params.order_type) body.order_type = params.order_type;
      if (params.disable_aggregation !== undefined) body.disable_aggregation = params.disable_aggregation;
      const result = await grinfiRequest("POST", "/leads/api/leads/search", body);
      return { content: [{ type: "text" as const, text: JSON.stringify(enrichResult(result), null, 2) }] };
    }
  );

  server.tool("get_contact", "Get a contact by their UUID.", { uuid: z.string().describe("UUID of the contact") }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/leads/${params.uuid}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(enrichResult(result), null, 2) }] };
  });

  server.tool(
    "update_contact",
    "Update a contact's fields by UUID.",
    {
      uuid: z.string().describe("UUID of the contact to update"),
      first_name: z.string().optional().describe("First name"),
      last_name: z.string().optional().describe("Last name"),
      company_name: z.string().optional().describe("Company name"),
      ln_id: z.string().optional().describe("LinkedIn member ID"),
      sn_id: z.string().optional().describe("Sales Navigator ID"),
      linkedin: z.string().optional().describe("LinkedIn profile handle"),
      email: z.string().optional().describe("Email address"),
      about: z.string().optional().describe("Description / about text"),
      domain: z.string().optional().describe("Company domain for email finding"),
      headline: z.string().optional().describe("LinkedIn headline"),
      position: z.string().optional().describe("Job position/title"),
      raw_address: z.string().optional().describe("Location address string"),
    },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/leads/api/leads/${uuid}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(enrichResult(result), null, 2) }] };
    }
  );

  server.tool("delete_contact", "Delete a contact by UUID. This action is irreversible.", { uuid: z.string().describe("UUID of the contact to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/leads/${params.uuid}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool(
    "upsert_contact",
    "Create a new contact or update an existing one. The contact is placed into the specified list.",
    {
      list_uuid: z.string().describe("UUID of the target list"),
      linkedin_id: z.string().describe("LinkedIn ID or profile URL (required)"),
      first_name: z.string().optional(), last_name: z.string().optional(),
      company_name: z.string().optional(), ln_id: z.string().optional(),
      sn_id: z.string().optional(), linkedin: z.string().optional(),
      email: z.string().optional(), about: z.string().optional(),
      domain: z.string().optional(), headline: z.string().optional(),
      position: z.string().optional(), raw_address: z.string().optional(),
      custom_fields: z.record(z.string(), z.string()).optional().describe("Custom fields as key-value pairs"),
      update_if_exists: z.boolean().optional(), move_to_list: z.boolean().optional(),
    },
    async (params) => {
      const { list_uuid, custom_fields, update_if_exists, move_to_list, ...leadFields } = params;
      const body: Record<string, unknown> = { lead: leadFields, list_uuid };
      if (custom_fields) body.custom_fields = custom_fields;
      if (update_if_exists !== undefined) body.update_if_exists = update_if_exists;
      if (move_to_list !== undefined) body.move_to_list = move_to_list;
      const result = await grinfiRequest("POST", "/leads/api/leads/upsert", body);
      return { content: [{ type: "text" as const, text: JSON.stringify(enrichResult(result), null, 2) }] };
    }
  );

  // LISTS
  server.tool("list_lists", "Get all contact lists. Supports pagination, sorting, and search.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const query: Record<string, string> = {};
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.order_field) query.order_field = params.order_field;
    if (params.order_type) query.order_type = params.order_type;
    if (params.search) query["filter[q]"] = params.search;
    const result = await grinfiRequest("GET", "/leads/api/lists", undefined, query);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_list", "Get a specific contact list by UUID.", { uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/lists/${params.uuid}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_list", "Create a new contact list.", { name: z.string().describe("Name of the new list") }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/lists", { name: params.name });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // AUTOMATIONS
  server.tool("list_automations", "Get all automations (flows). Supports pagination, sorting, and search.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const query: Record<string, string> = {};
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.order_field) query.order_field = params.order_field;
    if (params.order_type) query.order_type = params.order_type;
    if (params.search) query["filter[q]"] = params.search;
    const result = await grinfiRequest("GET", "/flows/api/flows", undefined, query);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("start_automation", "Start an automation (flow) by UUID.", { flow_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/start`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("stop_automation", "Stop a running automation (flow) by UUID.", { flow_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/stop`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("add_contact_to_automation", "Add an existing contact to an automation by their UUIDs.", {
    flow_uuid: z.string(), lead_uuid: z.string(),
  }, async (params) => {
    const result = await grinfiRequest("POST", `/flows/api/flows/${params.flow_uuid}/leads/${params.lead_uuid}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool(
    "add_new_contact_to_automation",
    "Create a new contact and immediately add them to an automation.",
    {
      flow_uuid: z.string(), list_uuid: z.string(), linkedin_id: z.string(),
      first_name: z.string().optional(), last_name: z.string().optional(),
      company_name: z.string().optional(), email: z.string().optional(),
      headline: z.string().optional(), position: z.string().optional(),
      raw_address: z.string().optional(),
      custom_fields: z.record(z.string(), z.string()).optional(),
      update_lead_if_exists: z.boolean().optional(), move_to_list: z.boolean().optional(),
      flow_segment_id: z.number().optional(), skip_if_lead_exists: z.boolean().optional(),
    },
    async (params) => {
      const { flow_uuid, list_uuid, custom_fields, update_lead_if_exists, move_to_list, flow_segment_id, skip_if_lead_exists, ...leadFields } = params;
      const body: Record<string, unknown> = { lead: leadFields, list_uuid };
      if (custom_fields) body.custom_fields = custom_fields;
      if (update_lead_if_exists !== undefined) body.update_lead_if_exists = update_lead_if_exists;
      if (move_to_list !== undefined) body.move_to_list = move_to_list;
      if (flow_segment_id !== undefined) body.flow_segment_id = flow_segment_id;
      if (skip_if_lead_exists !== undefined) body.skip_if_lead_exists = skip_if_lead_exists;
      const result = await grinfiRequest("POST", `/flows/api/flows/${flow_uuid}/add-new-lead`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("cancel_contact_from_automations", "Cancel a contact from specific automations.", {
    lead_uuid: z.string(), flow_uuids: z.array(z.string()),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel`, { flow_uuids: params.flow_uuids });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("cancel_contact_from_all_automations", "Cancel a contact from ALL active automations.", { lead_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel-all`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("continue_automation", "Continue (resume) an automation for a specific contact.", { lead_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/continue-automation", { lead_uuid: params.lead_uuid });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // TASKS
  server.tool(
    "create_task",
    "Create a new task (e.g. send LinkedIn message) for a contact. The task is scheduled and will be executed by the automation system. Requires lead_uuid, sender_profile_uuid, message text, and schedule time.",
    {
      lead_uuid: z.string().describe("UUID of the contact (lead)"),
      sender_profile_uuid: z.string().describe("UUID of the sender profile to execute the task"),
      type: z.string().optional().describe("Task type (default: linkedin_send_message). Known types: linkedin_send_message, linkedin_send_connection_request, linkedin_send_inmail, linkedin_like_latest_post, linkedin_endorse_skills"),
      text: z.string().describe("Message text or task content"),
      schedule_at: z.string().describe("When to execute the task (ISO 8601 format, e.g. '2026-02-17T10:00:00.000000Z')"),
      timezone: z.string().optional().describe("Timezone (default: UTC)"),
      note: z.string().optional().describe("Optional note for the task"),
    },
    async (params) => {
      const result = await grinfiRequest("POST", "/flows/api/tasks", {
        lead_uuid: params.lead_uuid,
        sender_profile_uuid: params.sender_profile_uuid,
        type: params.type ?? "linkedin_send_message",
        automation: "manual",
        status: "new",
        payload: { template: params.text, note: params.note ?? null },
        schedule_at: params.schedule_at,
        timezone: params.timezone ?? "UTC",
        filter: { all: false, ids: [params.lead_uuid], excludeIds: [] },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // UNIBOX — LinkedIn Messages
  server.tool(
    "list_linkedin_messages",
    "List LinkedIn messages from the unified inbox. Supports filters, pagination, and sorting. Set type to 'inbox' for received messages, 'outbox' for sent. For UNREAD conversations, use the 'get_unread_conversations' tool instead.",
    {
      limit: z.number().optional(), offset: z.number().optional(),
      order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
      search: z.string().optional(), lead_uuid: z.string().optional(),
      sender_profile_uuid: z.string().optional(), linkedin_account_uuid: z.string().optional(),
      linkedin_conversation_uuid: z.string().optional(),
      status: z.string().optional(), type: z.string().optional(), user_id: z.string().optional(),
    },
    async (params) => {
      const query: Record<string, string> = {};
      if (params.limit !== undefined) query.limit = String(params.limit);
      if (params.offset !== undefined) query.offset = String(params.offset);
      if (params.order_field) query.order_field = params.order_field;
      if (params.order_type) query.order_type = params.order_type;
      if (params.search) query["filter[q]"] = params.search;
      if (params.lead_uuid) query["filter[lead_uuid]"] = params.lead_uuid;
      if (params.sender_profile_uuid) query["filter[sender_profile_uuid]"] = params.sender_profile_uuid;
      if (params.linkedin_account_uuid) query["filter[linkedin_account_uuid]"] = params.linkedin_account_uuid;
      if (params.linkedin_conversation_uuid) query["filter[linkedin_conversation_uuid]"] = params.linkedin_conversation_uuid;
      if (params.status) query["filter[status]"] = params.status;
      if (params.type) query["filter[type]"] = params.type;
      if (params.user_id) query["filter[user_id]"] = params.user_id;
      const result = await grinfiRequest("GET", "/flows/api/linkedin-messages", undefined, query);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_unread_conversations",
    "Get contacts that have unread LinkedIn or email messages. This fetches recent inbox messages, then checks each contact's unread_counts field. Returns a list of contacts with unread messages and the latest message from each. Use this when the user asks about unread or new messages.",
    {
      limit: z.number().optional().describe("How many recent inbox messages to scan (default 300, max 1000)"),
      sender_profile_uuid: z.string().optional().describe("Filter by sender profile UUID"),
    },
    async (params) => {
      const query: Record<string, string> = {
        limit: String(Math.min(params.limit ?? 300, 1000)),
        "filter[type]": "inbox",
        order_field: "created_at",
        order_type: "desc",
      };
      if (params.sender_profile_uuid) query["filter[sender_profile_uuid]"] = params.sender_profile_uuid;

      const messagesResult = await grinfiRequest("GET", "/flows/api/linkedin-messages", undefined, query) as {
        data?: Array<{ lead_uuid: string; text: string; created_at: string; sender_profile_uuid: string; linkedin_conversation_uuid: string; [key: string]: unknown }>;
        total?: number;
      };

      if (!messagesResult.data || messagesResult.data.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ unread_conversations: [], total_unread: 0, note: "No inbox messages found" }, null, 2) }] };
      }

      const leadLatestMessage = new Map<string, (typeof messagesResult.data)[0]>();
      for (const msg of messagesResult.data) {
        if (!leadLatestMessage.has(msg.lead_uuid)) leadLatestMessage.set(msg.lead_uuid, msg);
      }

      const unreadConversations: Array<{
        contact_name: string; contact_uuid: string; unread_counts: unknown;
        latest_message: string; latest_message_at: string;
        sender_profile_uuid: string; conversation_uuid: string;
      }> = [];

      for (const [leadUuid, latestMsg] of leadLatestMessage) {
        try {
          const leadData = await grinfiRequest("GET", `/leads/api/leads/${leadUuid}`) as {
            lead?: { name?: string; unread_counts?: Array<{ count: number; channel: string; sender_profile_uuid: string }> };
          };
          const unreadCounts = leadData.lead?.unread_counts ?? [];
          if (unreadCounts.length > 0 && unreadCounts.some((uc) => uc.count > 0)) {
            unreadConversations.push({
              contact_name: leadData.lead?.name ?? "Unknown",
              contact_uuid: leadUuid,
              unread_counts: unreadCounts,
              latest_message: latestMsg.text,
              latest_message_at: latestMsg.created_at,
              sender_profile_uuid: latestMsg.sender_profile_uuid,
              conversation_uuid: latestMsg.linkedin_conversation_uuid,
            });
          }
        } catch { /* skip */ }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            unread_conversations: unreadConversations,
            total_unread: unreadConversations.length,
            scanned_messages: messagesResult.data.length,
            total_inbox_messages: messagesResult.total,
            note: "Showing contacts with unread_counts > 0 from recent inbox messages",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("mark_conversation_as_read", "Mark a LinkedIn conversation as read in Grinfi. This updates the unread counter in the Grinfi interface.", {
    lead_uuid: z.string().describe("UUID of the contact (lead) whose conversation to mark as read"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/leads/api/leads/mass-action", {
      type: "contact_mark_read",
      filter: { all: false, ids: [params.lead_uuid], excludeIds: [] },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("send_linkedin_message", "Send a LinkedIn message to a contact.", {
    sender_profile_uuid: z.string(), lead_uuid: z.string(), text: z.string(),
    template_uuid: z.string().optional(),
  }, async (params) => {
    const body: Record<string, unknown> = {
      sender_profile_uuid: params.sender_profile_uuid, lead_uuid: params.lead_uuid, text: params.text,
    };
    if (params.template_uuid) body.template_uuid = params.template_uuid;
    const result = await grinfiRequest("POST", "/flows/api/linkedin-messages", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // EMAILS
  server.tool("list_emails", "List emails from the unified inbox. Supports filters, pagination, and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(), lead_uuid: z.string().optional(),
    sender_profile_uuid: z.string().optional(), status: z.string().optional(),
    type: z.string().optional(),
  }, async (params) => {
    const query: Record<string, string> = {};
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.order_field) query.order_field = params.order_field;
    if (params.order_type) query.order_type = params.order_type;
    if (params.search) query["filter[q]"] = params.search;
    if (params.lead_uuid) query["filter[lead_uuid]"] = params.lead_uuid;
    if (params.sender_profile_uuid) query["filter[sender_profile_uuid]"] = params.sender_profile_uuid;
    if (params.status) query["filter[status]"] = params.status;
    if (params.type) query["filter[type]"] = params.type;
    const result = await grinfiRequest("GET", "/emails/api/emails", undefined, query);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("send_email", "Send an email to a contact.", {
    sender_profile_uuid: z.string(), lead_uuid: z.string(),
    from_name: z.string(), from_email: z.string(),
    to_name: z.string(), to_email: z.string(), subject: z.string(),
    cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(),
  }, async (params) => {
    const body: Record<string, unknown> = {
      sender_profile_uuid: params.sender_profile_uuid, lead_uuid: params.lead_uuid,
      from_name: params.from_name, from_email: params.from_email,
      to_name: params.to_name, to_email: params.to_email, subject: params.subject,
    };
    if (params.cc) body.cc = params.cc;
    if (params.bcc) body.bcc = params.bcc;
    const result = await grinfiRequest("POST", "/emails/api/emails/send-email", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // SENDER PROFILES
  server.tool("list_sender_profiles", "Get all sender profiles. These represent the LinkedIn/email accounts you send from.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const query: Record<string, string> = {};
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.order_field) query.order_field = params.order_field;
    if (params.order_type) query.order_type = params.order_type;
    if (params.search) query["filter[q]"] = params.search;
    const result = await grinfiRequest("GET", "/flows/api/sender-profiles", undefined, query);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_sender_profile", "Get a sender profile by UUID.", { uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/sender-profiles/${params.uuid}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_sender_profile", "Create a new sender profile.", {
    first_name: z.string(), last_name: z.string(),
    label: z.string().optional(), assignee_user_id: z.number().optional(),
  }, async (params) => {
    const body: Record<string, unknown> = { first_name: params.first_name, last_name: params.last_name };
    if (params.label) body.label = params.label;
    if (params.assignee_user_id !== undefined) body.assignee_user_id = params.assignee_user_id;
    const result = await grinfiRequest("POST", "/flows/api/sender-profiles", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

// --- HTTP Server with Bearer auth ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Track sessions: each session gets its own McpServer + Transport pair
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "grinfi-mcp" }));
    return;
  }

  // Only handle /mcp path
  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Auth check
  const authHeader = req.headers.authorization;
  const expectedKey = getMcpApiKey();
  if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Check for existing session
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session - route to the existing transport
    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP session request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  // Handle DELETE for session cleanup
  if (req.method === "DELETE") {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.server.close();
      sessions.delete(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    }
    return;
  }

  // New session - create a fresh McpServer + Transport pair
  try {
    const mcpServer = createMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server: mcpServer });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Grinfi MCP HTTP server running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});
