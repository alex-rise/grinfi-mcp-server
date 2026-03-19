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

// Global cache for get_unread_conversations (persists across MCP sessions, 30s TTL)
const _globalUnreadCache = new Map<string, { data: unknown; ts: number }>();
const UNREAD_CACHE_TTL_MS = 30_000;

import { tenantStorage, getTenantApiKey } from "./tenant-context.js";
import { loadTenants, registerTenant, getApiKeyByToken, getTenantCount } from "./tenant-store.js";
import { getLandingPageHtml } from "./landing-page.js";

import {
  initOAuthStore, loadOAuthTokens, registerClient, getClient,
  createAuthCode, consumeAuthCode, issueTokens, refreshAccessToken,
  getGrinfiJwtByAccessToken, revokeToken, verifyPKCE,
} from "./oauth-store.js";
// --- Helpers ---

const BASE_URL = "https://leadgen.grinfi.io";

function getApiKey(): string {
  // Multi-tenant: check AsyncLocalStorage first
  const tenantKey = getTenantApiKey();
  if (tenantKey) return tenantKey;

  // Fallback: owner's env var
  const key = process.env.GRINFI_API_KEY;
  if (!key) {
    throw new Error(
      "No API key available. Neither tenant context nor GRINFI_API_KEY env var is set."
    );
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


async function grinfiUpload(
  path: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
  formData.append("attachment", blob, fileName);
  formData.append("payload[size]", String(fileBuffer.length));
  formData.append("payload[type]", mimeType);
  formData.append("payload[name]", fileName);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    Accept: "application/json",
  };

  const response = await fetch(url.toString(), { method: "POST", headers, body: formData });
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

// Helper to build query params from pagination/filter options
function buildQuery(params: Record<string, unknown>, filterFields?: string[]): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.limit !== undefined) query.limit = String(params.limit);
  if (params.offset !== undefined) query.offset = String(params.offset);
  if (params.order_field) query.order_field = String(params.order_field);
  if (params.order_type) query.order_type = String(params.order_type);
  if (params.search) query["filter[q]"] = String(params.search);
  if (filterFields) {
    for (const f of filterFields) {
      if (params[f] !== undefined) query[`filter[${f}]`] = String(params[f]);
    }
  }
  return query;
}

// Helper for simple JSON response
function jsonResult(data: unknown, enrich = false) {
  const result = enrich ? enrichResult(data) : data;
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

// --- Build MCP server with all tools ---

function loadSkillInstructions(): string {
  try {
    const skillPath = join(__dirname, "..", "SKILL.md");
    const raw = readFileSync(skillPath, "utf-8");
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

  // Wrap server.tool to catch unhandled errors in any handler
  const originalTool = server.tool.bind(server);
  server.tool = ((...args: unknown[]) => {
    const handlerIndex = args.length - 1;
    const originalHandler = args[handlerIndex] as (...a: unknown[]) => Promise<unknown>;
    args[handlerIndex] = async (...handlerArgs: unknown[]) => {
      try {
        return await originalHandler(...handlerArgs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Tool error: ${message}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
      }
    };
    return (originalTool as (...a: unknown[]) => unknown)(...args);
  }) as typeof server.tool;

  // ===========================
  // CONTACTS
  // ===========================

  server.tool(
    "find_contact",
    "Find a single contact by LinkedIn ID or email. Requires linkedin_id or email — do NOT use this for searching by name. To search by name or company, use search_contacts with filter: {q: \"name\"}. Results include _grinfi_contact_url and _linkedin_url.",
    {
      linkedin_id: z.string().optional().describe("LinkedIn profile URL or ID"),
      email: z.string().optional().describe("Email address"),
      name: z.string().optional().describe("Contact's full name"),
      company_name: z.string().optional().describe("Company name"),
      disable_aggregation: z.boolean().optional().describe("Disable data aggregation"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.linkedin_id) body.linkedin_id = params.linkedin_id;
      if (params.email) body.email = params.email;
      if (params.name) body.name = params.name;
      if (params.company_name) body.company_name = params.company_name;
      if (params.disable_aggregation !== undefined) body.disable_aggregation = params.disable_aggregation;
      const result = await grinfiRequest("POST", "/leads/api/leads/lookup-one", body);
      return jsonResult(result, true);
    }
  );

  server.tool(
    "search_contacts",
    `Search contacts by name, company, or filter criteria. If you already have a UUID — use get_contact instead. If you have a LinkedIn URL or email — use find_contact instead.

Filter supports: scalar values (equals), arrays (IN), objects with operators (>=, <=, >, <, =, !=, <>), 'is_null', 'is_not_null'.

IMPORTANT: To search by name, company, or any text — use filter.q (e.g. filter: {q: "John Doe"}).
Text fields like first_name, last_name, name, company_name do NOT work as direct filters.

Supported filter fields: q (text search by name/company/email), list_uuid, pipeline_stage_uuid, email_status, linkedin_status, status, tags (array of tag UUIDs), sender_profile_uuid, data_source_uuid, created_at, updated_at (with operators >= <= etc).

Results include _grinfi_contact_url and _linkedin_url for each contact.`,
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter object. Use 'q' key for text search by name/company (e.g. {q: 'John'}). Other keys: list_uuid, pipeline_stage_uuid, email_status, linkedin_status, status, tags, sender_profile_uuid, created_at, updated_at"),
      limit: z.number().optional().describe("Number of results to return (default 20)"),
      offset: z.number().optional().describe("Number of results to skip (default 0)"),
      order_field: z.string().optional().describe("Field to sort by (default: created_at)"),
      order_type: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
      disable_aggregation: z.boolean().optional().describe("Disable data aggregation"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.offset !== undefined) body.offset = params.offset;
      if (params.order_field) body.order_field = params.order_field;
      if (params.order_type) body.order_type = params.order_type;
      if (params.disable_aggregation !== undefined) body.disable_aggregation = params.disable_aggregation;
      const result = await grinfiRequest("POST", "/leads/api/leads/search", body);
      return jsonResult(result, true);
    }
  );

  server.tool("get_contact", "Get a contact by UUID. ALWAYS use this when UUID is already known — never search again by name/email if you have the UUID.", { uuid: z.string().describe("UUID of the contact") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/leads/${params.uuid}`);
    return jsonResult(result, true);
  });

  server.tool(
    "update_contact",
    "Update a contact's fields by UUID. WARNING: pipeline_stage_uuid is silently ignored here — MUST use change_contact_pipeline_stage instead. Use work_email for business email and personal_email for personal email (not 'email').",
    {
      uuid: z.string().describe("UUID of the contact to update"),
      first_name: z.string().optional().describe("First name"),
      last_name: z.string().optional().describe("Last name"),
      company_name: z.string().optional().describe("Company name"),
      ln_id: z.string().optional().describe("LinkedIn member ID"),
      sn_id: z.string().optional().describe("Sales Navigator ID"),
      linkedin: z.string().optional().describe("LinkedIn profile handle"),
      work_email: z.string().optional().describe("Work/business email address"),
      personal_email: z.string().optional().describe("Personal email address"),
      about: z.string().optional().describe("Description / about text"),
      domain: z.string().optional().describe("Company domain for email finding"),
      headline: z.string().optional().describe("LinkedIn headline"),
      position: z.string().optional().describe("Job position/title"),
      raw_address: z.string().optional().describe("Location address string"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/leads/api/leads/${uuid}`, body);
      return jsonResult(result, true);
    }
  );

  server.tool("delete_contact", "Delete a contact by UUID. This action is irreversible.", { uuid: z.string().describe("UUID of the contact to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/leads/${params.uuid}`);
    return jsonResult(result);
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
      custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom fields as key-value pairs"),
      update_if_exists: z.boolean().optional(), move_to_list: z.boolean().optional(),
    },
    async (params) => {
      const { list_uuid, custom_fields, update_if_exists, move_to_list, ...leadFields } = params;
      const body: Record<string, unknown> = { lead: leadFields, list_uuid };
      if (custom_fields) body.custom_fields = custom_fields;
      if (update_if_exists !== undefined) body.update_if_exists = update_if_exists;
      if (move_to_list !== undefined) body.move_to_list = move_to_list;
      const result = await grinfiRequest("POST", "/leads/api/leads/upsert", body);
      return jsonResult(result, true);
    }
  );

  server.tool(
    "change_contact_pipeline_stage",
    "Change the pipeline stage of one or more contacts. Use list_pipeline_stages to get valid stage UUIDs. Also available as leads_mass_action with type 'contact_change_pipeline_stage'.",
    {
      contact_uuids: z.array(z.string()).describe("Array of contact UUIDs to change"),
      pipeline_stage_uuid: z.string().describe("UUID of the target pipeline stage"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const result = await grinfiRequest("PUT", "/leads/api/leads/mass-action", {
        type: "contact_change_pipeline_stage",
        filter: { all: false, ids: params.contact_uuids, excludeIds: [] },
        payload: { pipeline_stage_uuid: params.pipeline_stage_uuid },
      });
      return jsonResult(result);
    }
  );

  server.tool(
    "leads_mass_action",
    "Perform a mass action on leads. Actions ONLY available here (no separate tool): contact_assign_tag (payload: {tag_uuid}), contact_remove_tag (payload: {tag_uuid}), contact_move_to_list (payload: {list_uuid}). Actions that also have separate tools: contact_mark_read (no payload) - also see mark_conversation_as_read, contact_change_pipeline_stage (payload: {pipeline_stage_uuid}) - also see change_contact_pipeline_stage, contact_delete (no payload) - also see delete_contact. Filter: {ids: ['uuid1','uuid2']} for specific contacts or {all: true} for all matching.",
    {
      type: z.string().describe("Mass action type (e.g. 'contact_change_pipeline_stage', 'contact_mark_read')"),
      filter: z.record(z.string(), z.unknown()).describe("Filter to select leads"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Action-specific payload"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const body: Record<string, unknown> = { type: params.type, filter: params.filter };
      if (params.payload) body.payload = params.payload;
      const result = await grinfiRequest("PUT", "/leads/api/leads/mass-action", body);
      return jsonResult(result);
    }
  );

  // ===========================
  // LISTS
  // ===========================

  server.tool("list_lists", "Get all contact lists. Supports pagination, sorting, and search.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/lists", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_list", "Get a specific contact list by UUID.", { uuid: z.string() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/lists/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_list", "Create a new contact list.", { name: z.string().describe("Name of the new list") },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/lists", { name: params.name });
    return jsonResult(result);
  });

  server.tool("update_list", "Update (rename) a contact list.", {
    uuid: z.string().describe("UUID of the list"),
    name: z.string().describe("New list name"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/leads/api/lists/${params.uuid}`, { name: params.name });
    return jsonResult(result);
  });

  server.tool("delete_list", "Delete a contact list by UUID. This action is irreversible.", {
    uuid: z.string().describe("UUID of the list"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/lists/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_list_metrics", "Get metrics (lead counts) for specified lists.", {
    uuids: z.array(z.string()).describe("Array of list UUIDs"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/lists/metrics", { uuids: params.uuids });
    return jsonResult(result);
  });

  // ===========================
  // COMPANIES
  // ===========================

  server.tool("list_companies", "List companies with pagination, sorting, and search.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/companies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_company", "Get a company by its UUID.", { uuid: z.string().describe("UUID of the company") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/companies/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool(
    "create_companies",
    "Create one or more companies. Optionally assign to lists and a data source.",
    {
      companies: z.array(z.record(z.string(), z.unknown())).describe("Array of company objects to create"),
      list_uuids: z.array(z.string()).optional(),
      data_source_uuid: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const body: Record<string, unknown> = { companies: params.companies };
      if (params.list_uuids) body.list_uuids = params.list_uuids;
      if (params.data_source_uuid) body.data_source_uuid = params.data_source_uuid;
      const result = await grinfiRequest("POST", "/leads/api/companies", body);
      return jsonResult(result);
    }
  );

  server.tool(
    "update_company",
    "Update a company's fields by UUID.",
    {
      uuid: z.string().describe("UUID of the company to update"),
      name: z.string().optional(), domain: z.string().optional(),
      website: z.string().optional(), linkedin: z.string().optional(),
      ln_id: z.number().optional(), phone: z.string().optional(),
      industry: z.string().optional(), employees_range: z.string().optional(),
      hq_raw_address: z.string().optional(), about: z.string().optional(),
      lead_status_uuid: z.string().optional(),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/leads/api/companies/${uuid}`, body);
      return jsonResult(result);
    }
  );

  server.tool("delete_company", "Delete a company by UUID. This action is irreversible.", {
    uuid: z.string().describe("UUID of the company to delete"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/companies/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("lookup_companies", "Lookup companies by LinkedIn ID, website, or name. Pass an array of lookup objects.", {
    lookups: z.array(z.record(z.string(), z.unknown())).describe("Array of lookup criteria objects"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/companies/lookup", { lookups: params.lookups });
    return jsonResult(result);
  });

  server.tool("search_company_leads", "Get leads (contacts) belonging to specified companies.", {
    uuids: z.array(z.string()).describe("Array of company UUIDs"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/companies/leads", { uuids: params.uuids });
    return jsonResult(result, true);
  });

  server.tool("enrich_companies", "Trigger advanced enrichment for companies. Provide either a filter or an array of company UUIDs.", {
    uuids: z.array(z.string()).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = {};
    if (params.uuids) body.uuids = params.uuids;
    if (params.filter) body.filter = params.filter;
    const result = await grinfiRequest("POST", "/leads/api/companies/enrich", body);
    return jsonResult(result);
  });

  server.tool(
    "companies_mass_action",
    "Perform a mass action on companies. Types: assign_tag (payload: {tag_uuid}), remove_tag (payload: {tag_uuid}), move_to_list (payload: {list_uuid}), change_pipeline_stage (payload: {pipeline_stage_uuid}), delete (no payload). Filter: {ids: ['uuid1','uuid2']} for specific companies or {all: true} for all matching.",
    {
      type: z.string().describe("Mass action type"),
      filter: z.record(z.string(), z.unknown()).describe("Filter to select companies"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Action-specific payload"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const body: Record<string, unknown> = { type: params.type, filter: params.filter };
      if (params.payload) body.payload = params.payload;
      const result = await grinfiRequest("PUT", "/leads/api/companies/mass-action", body);
      return jsonResult(result);
    }
  );

  // ===========================
  // TAGS
  // ===========================

  server.tool("list_tags", "List all tags in your account.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/leads/api/tags");
    return jsonResult(result);
  });

  server.tool("create_tag", "Create a new tag.", {
    name: z.string().describe("Tag name"),
    color: z.string().optional().describe("Tag color"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.color) body.color = params.color;
    const result = await grinfiRequest("POST", "/leads/api/tags", body);
    return jsonResult(result);
  });

  server.tool("update_tag", "Update a tag's name or color.", {
    uuid: z.string().describe("UUID of the tag"),
    name: z.string().optional(), color: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/leads/api/tags/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_tag", "Delete a tag by UUID.", { uuid: z.string().describe("UUID of the tag to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/tags/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_tag_metrics", "Get metrics (leads count, companies count) for specified tags.", {
    uuids: z.array(z.string()).describe("Array of tag UUIDs"),
    metrics: z.array(z.enum(["leads_count", "companies_count"])).describe("Metrics to retrieve"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/tags/metrics", { uuids: params.uuids, metrics: params.metrics });
    return jsonResult(result);
  });

  // ===========================
  // PIPELINE STAGES
  // ===========================

  server.tool("list_pipeline_stages", "List pipeline stages. Filter by object type (lead or company). Returns UUID, name, category, and order for each stage.", {
    object: z.enum(["lead", "company"]).optional().describe("Filter by object type (default: lead)"),
    type: z.enum(["custom", "new", "approaching", "engaging", "replied"]).optional().describe("Filter by stage type"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const query: Record<string, string> = {};
    if (params.object) query["filter[object]"] = params.object;
    if (params.type) query["filter[type]"] = params.type;
    const result = await grinfiRequest("GET", "/leads/api/pipeline-stages", undefined, query);
    return jsonResult(result);
  });

  server.tool("create_pipeline_stage", "Create a new custom pipeline stage.", {
    name: z.string().describe("Stage name"),
    object: z.enum(["lead", "company"]).describe("Object type"),
    category: z.enum(["cold", "engaging", "positive", "negative"]).describe("Stage category"),
    order: z.number().optional().describe("Display order"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/pipeline-stages", params);
    return jsonResult(result);
  });

  server.tool("update_pipeline_stage", "Update a pipeline stage's name, category, or order.", {
    uuid: z.string().describe("UUID of the pipeline stage"),
    name: z.string().optional(), category: z.enum(["cold", "engaging", "positive", "negative"]).optional(),
    order: z.number().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/leads/api/pipeline-stages/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_pipeline_stage", "Delete a custom pipeline stage by UUID.", {
    uuid: z.string().describe("UUID of the pipeline stage"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/pipeline-stages/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // CUSTOM FIELDS
  // ===========================

  server.tool("list_custom_fields", "List all custom fields. Custom fields can be for leads or companies.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/custom-fields", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("create_custom_field", "Create a new custom field for leads or companies.", {
    name: z.string().describe("Field name"),
    object: z.enum(["lead", "company"]).describe("Object type"),
    order: z.number().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/custom-fields", params);
    return jsonResult(result);
  });

  server.tool("upsert_custom_field_value", "Set (upsert) a custom field value on a lead or company.", {
    custom_field_uuid: z.string().describe("UUID of the custom field"),
    object_type: z.enum(["lead", "company"]).describe("Object type"),
    object_uuid: z.string().describe("UUID of the lead or company"),
    value: z.unknown().optional().describe("Field value (or null to clear)"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/leads/api/custom-fields/${params.custom_field_uuid}/values`, {
      object_type: params.object_type,
      object_uuid: params.object_uuid,
      value: params.value ?? null,
    });
    return jsonResult(result);
  });

  // ===========================
  // NOTES
  // ===========================

  server.tool("list_notes", "List notes with pagination and sorting. Notes can be attached to leads or companies.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/notes", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_note", "Get a note by its UUID.", { uuid: z.string().describe("UUID of the note") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/notes/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_note", "Create a note on a lead or company.", {
    object: z.enum(["lead", "company"]).describe("Object type"),
    object_uuid: z.string().describe("UUID of the lead or company"),
    note: z.string().describe("Note text content"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/notes", params);
    return jsonResult(result);
  });

  server.tool("update_note", "Update a note's text.", {
    uuid: z.string().describe("UUID of the note"),
    note: z.string().describe("Updated note text"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/leads/api/notes/${params.uuid}`, { note: params.note });
    return jsonResult(result);
  });

  server.tool("delete_note", "Delete a note by UUID.", { uuid: z.string().describe("UUID of the note to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/notes/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // ACTIVITIES
  // ===========================

  server.tool("list_activities", "List activities for leads or companies. Activities track events like messages sent, emails opened, etc.", {
    object: z.enum(["lead", "company"]).optional(),
    filter: z.string().optional(),
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const query: Record<string, string> = {};
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.order_field) query.order_field = params.order_field;
    if (params.order_type) query.order_type = params.order_type;
    if (params.object) query["filter[object]"] = params.object;
    if (params.filter) query["filter[q]"] = params.filter;
    const result = await grinfiRequest("GET", "/leads/api/activities", undefined, query);
    return jsonResult(result);
  });

  server.tool("create_activity", "Create a new activity record for a lead or company.", {
    object_uuid: z.string().describe("UUID of the lead or company"),
    object_type: z.enum(["lead", "company"]).describe("Object type"),
    type: z.string().describe("Activity type (e.g. 'linkedin_message_sent', 'email_sent')"),
    payload: z.record(z.string(), z.unknown()).optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/activities", params);
    return jsonResult(result);
  });

  // ===========================
  // BLACKLISTS
  // ===========================

  server.tool("list_leads_blacklist", "List blacklisted leads with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/blacklist/leads", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("add_to_leads_blacklist", "Add a lead to the blacklist.", {
    name: z.string().optional(), linkedin: z.string().optional(),
    ln_id: z.string().optional(), personal_email: z.string().optional(),
    work_email: z.string().optional(), company_name: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("POST", "/leads/api/blacklist/leads", body);
    return jsonResult(result);
  });

  server.tool("list_companies_blacklist", "List blacklisted companies with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/blacklist/companies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("add_to_companies_blacklist", "Add a company to the blacklist.", {
    name: z.string().optional(), domain: z.string().optional(),
    linkedin: z.string().optional(), ln_id: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("POST", "/leads/api/blacklist/companies", body);
    return jsonResult(result);
  });

  // ===========================
  // WEBHOOKS
  // ===========================

  server.tool("list_webhooks", "List all webhooks configured in your account.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/integrations/c1/api/webhooks");
    return jsonResult(result);
  });

  server.tool("get_webhook", "Get a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/integrations/c1/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_webhook", "Create a new webhook. Specify the event to listen for and the target URL to call.", {
    name: z.string().describe("Webhook name"),
    event: z.string().describe("Event to trigger on (e.g. 'contact_exported', 'lead_created', 'lead_updated')"),
    target_url: z.string().describe("URL to send the webhook payload to"),
    request_method: z.string().optional().describe("HTTP method (default: POST)"),
    filters: z.string().optional().describe("Optional filters"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body = { ...params, request_method: params.request_method || "POST" };
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks", body);
    return jsonResult(result);
  });

  server.tool("update_webhook", "Update a webhook by UUID.", {
    uuid: z.string().describe("UUID of the webhook to update"),
    name: z.string().optional(), event: z.string().optional(),
    target_url: z.string().optional(), request_method: z.string().optional(),
    filters: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/integrations/c1/api/webhooks/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_webhook", "Delete a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/integrations/c1/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("test_webhook", "Test a webhook by sending a test payload.", {
    event: z.string().describe("Event name to test"),
    target_url: z.string().describe("Target URL to send the test to"),
    request_method: z.string().optional(),
    lead_uuid: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks/test", params);
    return jsonResult(result);
  });

  server.tool("get_webhook_metrics", "Get metrics for specified webhooks.", {
    uuids: z.array(z.string()).describe("Array of webhook UUIDs"),
    metrics: z.array(z.string()).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks/metrics", params);
    return jsonResult(result);
  });

  // ===========================
  // ATTACHMENTS
  // ===========================

  server.tool("list_attachments", "List attachments with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/attachments", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_attachment", "Get an attachment by UUID.", { uuid: z.string().describe("UUID of the attachment") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/attachments/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("delete_attachment", "Delete an attachment by UUID.", { uuid: z.string().describe("UUID of the attachment to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/attachments/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("upload_attachment", "Upload a file attachment. Provide the file as a base64-encoded string. Returns the attachment UUID and name to use with send_linkedin_message or send_email. Max 20MB. Allowed types: png, gif, jpg, jpeg, pdf, doc(x), xls(x), ppt(x), mp4, mov.", {
    file_base64: z.string().describe("Base64-encoded file content"),
    file_name: z.string().describe("File name with extension (e.g. 'proposal.pdf')"),
    mime_type: z.string().describe("MIME type (e.g. 'application/pdf', 'image/png')"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const fileBuffer = Buffer.from(params.file_base64, "base64");
    const result = await grinfiUpload("/flows/api/attachments", fileBuffer, params.file_name, params.mime_type);
    return jsonResult(result);
  });

  // ===========================
  // ENRICHMENT
  // ===========================

  server.tool("list_enrichment_queue", "List enrichment queue entries with pagination.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/enrichment-queue", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_enrichment_metrics", "Get enrichment queue metrics (e.g. this month's enrichment count).", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/leads/api/enrichment-queue/metrics");
    return jsonResult(result);
  });

  // ===========================
  // AUTOMATIONS
  // ===========================

  server.tool("list_automations", "Get all automations (flows). Supports pagination, sorting, and search.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/flows/api/flows", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_automation", "Get a specific automation (flow) by UUID with full details.", {
    flow_uuid: z.string().describe("UUID of the automation"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/flows/${params.flow_uuid}`);
    return jsonResult(result);
  });

  server.tool("get_automation_metrics", "Get metrics for specified automations (flows).", {
    uuids: z.array(z.string()).describe("Array of automation UUIDs"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/flows/api/flows/metrics", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("start_automation", "Start an automation (flow) by UUID.", { flow_uuid: z.string() },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/start`);
    return jsonResult(result);
  });

  server.tool("stop_automation", "Stop a running automation (flow) by UUID.", { flow_uuid: z.string() },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/stop`);
    return jsonResult(result);
  });

  server.tool("archive_automation", "Archive an automation (flow).", {
    flow_uuid: z.string().describe("UUID of the automation to archive"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/archive`);
    return jsonResult(result);
  });

  server.tool("unarchive_automation", "Unarchive a previously archived automation (flow).", {
    flow_uuid: z.string().describe("UUID of the automation to unarchive"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/unarchive`);
    return jsonResult(result);
  });

  server.tool("delete_automation", "Delete an automation (flow) by UUID. This action is irreversible.", {
    flow_uuid: z.string().describe("UUID of the automation to delete"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/flows/${params.flow_uuid}`);
    return jsonResult(result);
  });

  server.tool("clone_automation", "Clone an existing automation (flow). Creates a copy with a new name.", {
    flow_uuid: z.string().describe("UUID of the automation to clone"),
    name: z.string().describe("Name for the cloned automation"),
    flow_workspace_uuid: z.string().optional().describe("Workspace UUID for the clone"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.flow_workspace_uuid) body.flow_workspace_uuid = params.flow_workspace_uuid;
    const result = await grinfiRequest("POST", `/flows/api/flows/${params.flow_uuid}/clone`, body);
    return jsonResult(result);
  });

  server.tool("update_automation", "Update an automation (flow) by UUID. Can update name, description, schedule, etc.", {
    flow_uuid: z.string().describe("UUID of the automation to update"),
    name: z.string().optional().describe("New automation name"),
    description: z.string().optional().describe("New description"),
    schedule: z.record(z.string(), z.unknown()).optional().describe("Schedule configuration"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { flow_uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/flows/api/flows/${flow_uuid}`, body);
    return jsonResult(result);
  });

  server.tool("add_contact_to_automation", "Add an existing contact to an automation by their UUIDs.", {
    flow_uuid: z.string(), lead_uuid: z.string(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", `/flows/api/flows/${params.flow_uuid}/leads/${params.lead_uuid}`);
    return jsonResult(result);
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
      custom_fields: z.record(z.string(), z.unknown()).optional(),
      update_lead_if_exists: z.boolean().optional(), move_to_list: z.boolean().optional(),
      flow_segment_id: z.number().optional(), skip_if_lead_exists: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const { flow_uuid, list_uuid, custom_fields, update_lead_if_exists, move_to_list, flow_segment_id, skip_if_lead_exists, ...leadFields } = params;
      const body: Record<string, unknown> = { lead: leadFields, list_uuid };
      if (custom_fields) body.custom_fields = custom_fields;
      if (update_lead_if_exists !== undefined) body.update_lead_if_exists = update_lead_if_exists;
      if (move_to_list !== undefined) body.move_to_list = move_to_list;
      if (flow_segment_id !== undefined) body.flow_segment_id = flow_segment_id;
      if (skip_if_lead_exists !== undefined) body.skip_if_lead_exists = skip_if_lead_exists;
      const result = await grinfiRequest("POST", `/flows/api/flows/${flow_uuid}/add-new-lead`, body);
      return jsonResult(result);
    }
  );

  server.tool("cancel_contact_from_automations", "Cancel a contact from specific automations.", {
    lead_uuid: z.string(), flow_uuids: z.array(z.string()),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel`, { flow_uuids: params.flow_uuids });
    return jsonResult(result);
  });

  server.tool("cancel_contact_from_all_automations", "Remove contact from ALL active automations permanently. Use after: sending manual reply, rejection, not-ICP classification. MUST call before sending manual messages to prevent conflicting automation messages.", { lead_uuid: z.string() },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel-all`);
    return jsonResult(result);
  });

  server.tool("continue_automation", "Resume a paused automation for a contact. Use only for neutral/early replies (e.g. 'ok', 'thanks' at 1-3 messages). Do NOT use if lead replied with interest, rejection, or after manual reply was sent.", { lead_uuid: z.string() },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/continue-automation", { lead_uuid: params.lead_uuid });
    return jsonResult(result);
  });

  // ===========================
  // TASKS
  // ===========================

  server.tool(
    "create_task",
    "SCHEDULE an action for the future — does NOT execute immediately. To send a LinkedIn message right now, use send_linkedin_message instead. Creates a manual task that will be executed at schedule_at time. Known task types: linkedin_send_message (default), linkedin_send_connection_request, linkedin_send_inmail, linkedin_like_latest_post, linkedin_endorse_skills.",
    {
      lead_uuid: z.string().describe("UUID of the contact (lead)"),
      sender_profile_uuid: z.string().describe("UUID of the sender profile to execute the task"),
      type: z.string().optional().describe("Task type (default: linkedin_send_message). Known types: linkedin_send_message, linkedin_send_connection_request, linkedin_send_inmail, linkedin_like_latest_post, linkedin_endorse_skills"),
      text: z.string().describe("Message text or task content"),
      schedule_at: z.string().describe("When to execute the task (ISO 8601 format, e.g. '2026-02-17T10:00:00.000000Z')"),
      timezone: z.string().optional().describe("Timezone (default: UTC)"),
      note: z.string().optional().describe("Optional note for the task"),
    },
    { readOnlyHint: false, destructiveHint: false },
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
      return jsonResult(result);
    }
  );

  server.tool("get_task", "Get a specific task by UUID.", { uuid: z.string().describe("UUID of the task") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool(
    "list_tasks",
    "List tasks with filters. Defaults to manual tasks only. Statuses: in_progress, closed (done), canceled, failed. Use schedule_at_before to filter by due date.",
    {
      limit: z.number().optional().describe("Number of results (default 20)"),
      offset: z.number().optional(), order_field: z.string().optional(),
      order_type: z.enum(["asc", "desc"]).optional(), search: z.string().optional(),
      automation: z.enum(["manual", "auto"]).optional().describe("Filter: 'manual' (default) for manual tasks, 'auto' for automation tasks"),
      status: z.enum(["in_progress", "closed", "canceled", "failed"]).optional(),
      type: z.string().optional().describe("Filter by task type (e.g. 'linkedin_send_message')"),
      lead_uuid: z.string().optional(), sender_profile_uuid: z.string().optional(),
      flow_uuid: z.string().optional(), assignee_uuid: z.string().optional(),
      schedule_at_before: z.string().optional().describe("Filter tasks scheduled before this ISO date"),
      schedule_at_after: z.string().optional().describe("Filter tasks scheduled after this ISO date"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      // Default to manual tasks to prevent accidental operations on automation tasks
      const safeParams = { ...params, automation: params.automation ?? "manual" };
      const query = buildQuery(safeParams, ["automation", "status", "type", "lead_uuid", "sender_profile_uuid", "flow_uuid", "assignee_uuid", "schedule_at_before", "schedule_at_after"]);
      const result = await grinfiRequest("GET", "/flows/api/tasks", undefined, query);
      return jsonResult(result);
    }
  );

  server.tool("complete_task", "Mark a MANUAL task as completed. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to complete") },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be completed via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/complete`);
    return jsonResult(result);
  });

  server.tool("cancel_task", "Cancel a MANUAL task. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to cancel") },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be cancelled via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/cancel`);
    return jsonResult(result);
  });

  server.tool("fail_task", "Mark a MANUAL task as failed. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to fail") },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be failed via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/fail`);
    return jsonResult(result);
  });

  server.tool("mass_cancel_tasks", "Cancel multiple MANUAL tasks at once. Do NOT use for automatic (automation-created) tasks.", {
    uuids: z.array(z.string()).describe("Array of manual task UUIDs to cancel"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const results: Array<{ uuid: string; status: string }> = [];
    for (const uuid of params.uuids) {
      try {
        const task = await grinfiRequest("GET", `/flows/api/tasks/${uuid}`) as { automation?: string };
        if (task.automation !== "manual") {
          results.push({ uuid, status: "BLOCKED: automatic task — skipped" });
          continue;
        }
        await grinfiRequest("PUT", `/flows/api/tasks/${uuid}/cancel`);
        results.push({ uuid, status: "cancelled" });
      } catch (err) {
        results.push({ uuid, status: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return jsonResult({ results, total: params.uuids.length, success: results.filter((r) => r.status === "cancelled").length });
  });

  server.tool("mass_complete_tasks", "Mark multiple MANUAL tasks as completed at once. Do NOT use for automatic (automation-created) tasks.", {
    uuids: z.array(z.string()).describe("Array of manual task UUIDs to complete"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const results: Array<{ uuid: string; status: string }> = [];
    for (const uuid of params.uuids) {
      try {
        const task = await grinfiRequest("GET", `/flows/api/tasks/${uuid}`) as { automation?: string };
        if (task.automation !== "manual") {
          results.push({ uuid, status: "BLOCKED: automatic task — skipped" });
          continue;
        }
        await grinfiRequest("PUT", `/flows/api/tasks/${uuid}/complete`);
        results.push({ uuid, status: "completed" });
      } catch (err) {
        results.push({ uuid, status: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return jsonResult({ results, total: params.uuids.length, success: results.filter((r) => r.status === "completed").length });
  });

  server.tool("mass_retry_tasks", "Retry multiple failed MANUAL tasks at once. Do NOT use for automatic (automation-created) tasks.", {
    uuids: z.array(z.string()).describe("Array of manual task UUIDs to retry"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const results: Array<{ uuid: string; status: string }> = [];
    for (const uuid of params.uuids) {
      try {
        const task = await grinfiRequest("GET", `/flows/api/tasks/${uuid}`) as { automation?: string };
        if (task.automation !== "manual") {
          results.push({ uuid, status: "BLOCKED: automatic task — skipped" });
          continue;
        }
        await grinfiRequest("PUT", `/flows/api/tasks/${uuid}/retry`);
        results.push({ uuid, status: "retried" });
      } catch (err) {
        results.push({ uuid, status: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return jsonResult({ results, total: params.uuids.length, success: results.filter((r) => r.status === "retried").length });
  });

  server.tool("mass_skip_tasks", "Skip multiple MANUAL tasks at once. Do NOT use for automatic (automation-created) tasks.", {
    uuids: z.array(z.string()).describe("Array of manual task UUIDs to skip"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const results: Array<{ uuid: string; status: string }> = [];
    for (const uuid of params.uuids) {
      try {
        const task = await grinfiRequest("GET", `/flows/api/tasks/${uuid}`) as { automation?: string };
        if (task.automation !== "manual") {
          results.push({ uuid, status: "BLOCKED: automatic task — skipped" });
          continue;
        }
        await grinfiRequest("PUT", `/flows/api/tasks/${uuid}/skip`);
        results.push({ uuid, status: "skipped" });
      } catch (err) {
        results.push({ uuid, status: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return jsonResult({ results, total: params.uuids.length, success: results.filter((r) => r.status === "skipped").length });
  });

  server.tool(
    "get_tasks_group_counts",
    "Get task counts grouped by status. Defaults to manual tasks.",
    {
      automation: z.enum(["manual", "auto"]).optional().describe("Defaults to 'manual'"),
      schedule_at_before: z.string().optional(),
      schedule_at_after: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const query: Record<string, string> = {};
      if (params.automation) query["filter[automation]"] = params.automation;
      if (params.schedule_at_before) query["filter[schedule_at_before]"] = params.schedule_at_before;
      if (params.schedule_at_after) query["filter[schedule_at_after]"] = params.schedule_at_after;
      const result = await grinfiRequest("GET", "/flows/api/tasks/group-counts", undefined, query);
      return jsonResult(result);
    }
  );

  server.tool("get_tasks_schedule", "Get the tasks schedule overview.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/flows/api/tasks/schedule");
    return jsonResult(result);
  });

  // ===========================
  // LINKEDIN MESSAGES (UNIBOX)
  // ===========================

  server.tool(
    "list_linkedin_messages",
    "List LinkedIn messages from the unified inbox. Returns messages from ALL sender profiles by default — no need to call per sender profile. Set type to 'inbox' for received, 'outbox' for sent. Use order_field='sent_at', order_type='asc' for chronological conversation. For UNREAD conversations, use 'get_unread_conversations' instead.",
    {
      limit: z.number().optional(), offset: z.number().optional(),
      order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
      lead_uuid: z.string().optional(),
      sender_profile_uuid: z.string().optional(), linkedin_account_uuid: z.string().optional(),
      linkedin_conversation_uuid: z.string().optional(),
      status: z.string().optional(), type: z.string().optional(), user_id: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const query = buildQuery(params, ["lead_uuid", "sender_profile_uuid", "linkedin_account_uuid", "linkedin_conversation_uuid", "status", "type", "user_id"]);
      const result = await grinfiRequest("GET", "/flows/api/linkedin-messages", undefined, query);
      return jsonResult(result);
    }
  );


    server.tool(
    "get_unread_conversations",
    "Get contacts that have unread LinkedIn or email messages. This fetches recent inbox messages, then checks each contact's unread_counts field. Returns a list of contacts with unread messages and the latest message from each. Use this when the user asks about unread or new messages.",
    {
      limit: z.number().optional().describe("How many recent inbox messages to scan (default 300, max 1000)"),
      sender_profile_uuid: z.string().optional().describe("Filter by sender profile UUID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        // Check global cache first (30s TTL)
        const cacheKey = `unread_${params.sender_profile_uuid ?? "all"}`;
        const cached = _globalUnreadCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < UNREAD_CACHE_TTL_MS) {
          return jsonResult(cached.data);
        }

        // Step 1: Fetch sender profiles to build ES query
        const spResult = await grinfiRequest("GET", "/flows/api/sender-profiles", undefined, {
          limit: "100", offset: "0",
        }) as { data?: Array<{ uuid: string; first_name?: string; last_name?: string }> };

        const senderProfiles = spResult.data ?? [];
        if (senderProfiles.length === 0) {
          return jsonResult({ error: "No sender profiles found" });
        }

        // Build the should clause: for each sender profile, require unread_counts > 0
        let profileUuids = senderProfiles.map((sp) => sp.uuid);

        // If filtering by specific sender_profile_uuid, only use that one
        if (params.sender_profile_uuid) {
          profileUuids = profileUuids.filter((u) => u === params.sender_profile_uuid);
          if (profileUuids.length === 0) {
            return jsonResult({ unread_conversations: [], total_unread: 0, note: "Sender profile not found" });
          }
        }

        const shouldClauses = profileUuids.map((uuid) => ({
          bool: {
            must: [
              { term: { "unread_counts.sender_profile_uuid": uuid } },
              { range: { "unread_counts.count": { gt: "0" } } },
            ],
          },
        }));

        // Step 2: POST to Elasticsearch-powered leads/list endpoint
        const esBody = {
          order_field: "markers.last_messaging_activity_at",
          order_type: "desc",
          limit: params.limit ?? 50,
          offset: 0,
          nested_sort_filter: { "markers.sender_profile_uuid": null },
          filter: {
            elasticQuery: {
              bool: {
                must: [{ bool: { should: shouldClauses } }],
              },
            },
            leadFilter: {},
          },
        };

        const esResult = await grinfiRequest("POST", "/leads/c1/api/leads/list", esBody) as {
          data?: Array<{
            lead: {
              uuid: string;
              name?: string;
              first_name?: string;
              last_name?: string;
              unread_counts?: Array<{ count: number; sender_profile_uuid: string }>;
            };
          }>;
          total?: number;
        };

        const items = esResult.data ?? [];

        // Step 3: Build result — unwrap .lead from each item
        const allUnread = items.map((item) => {
          const lead = item.lead;
          const totalUnread = (lead.unread_counts ?? []).reduce((s, u) => s + u.count, 0);
          const contactName = lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
          return {
            contact_name: contactName,
            contact_uuid: lead.uuid,
            unread_count: totalUnread,
            _grinfi_contact_url: `https://leadgen.grinfi.io/crm/contacts/${lead.uuid}`,
          };
        });

        const resultData = {
          unread_conversations: allUnread,
          total_unread: allUnread.length,
          total_in_filter: esResult.total ?? allUnread.length,
          sender_profiles_checked: profileUuids.length,
          note: "Use list_linkedin_messages with lead_uuid filter to read specific conversations",
        };

        _globalUnreadCache.set(cacheKey, { data: resultData, ts: Date.now() });
        return jsonResult(resultData);
      } catch (err) {
        return jsonResult({ error: `Failed to fetch unread conversations: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );

  server.tool("mark_conversation_as_read", "Mark a LinkedIn conversation as read in Grinfi. This updates the unread counter in the Grinfi interface.", {
    lead_uuid: z.string().describe("UUID of the contact (lead) whose conversation to mark as read"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", "/leads/api/leads/mass-action", {
      type: "contact_mark_read",
      filter: { all: false, ids: [params.lead_uuid], excludeIds: [] },
    });
    return jsonResult(result);
  });

  server.tool("send_linkedin_message", "Send a LinkedIn message to a contact IMMEDIATELY (right now). IMPORTANT: Always draft the message and get user confirmation before sending. To schedule for later, use create_task. Set linkedin_messenger_type to 'sn' for InMail (requires subject), 'basic' (default) for regular message. To attach files, first upload with upload_attachment, then pass UUIDs in attachments array.", {
    sender_profile_uuid: z.string(), lead_uuid: z.string(), text: z.string(),
    template_uuid: z.string().optional(),
    linkedin_messenger_type: z.enum(["basic", "sn"]).optional().default("basic").describe("'basic' for regular LinkedIn message, 'sn' for InMail"),
    subject: z.string().optional().describe("Subject line (required for InMail, ignored for basic messages)"),
    attachments: z.array(z.object({ uuid: z.string(), name: z.string() })).optional().describe("Array of attachment objects {uuid, name} from upload_attachment"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const body: Record<string, unknown> = {
      sender_profile_uuid: params.sender_profile_uuid, lead_uuid: params.lead_uuid, text: params.text,
      linkedin_messenger_type: params.linkedin_messenger_type || "basic",
    };
    if (params.template_uuid) body.template_uuid = params.template_uuid;
    if (params.subject) body.subject = params.subject;
    if (params.attachments && params.attachments.length > 0) {
      body.attachments = params.attachments;
    } else {
      body.attachments = [];
    }
    const result = await grinfiRequest("POST", "/flows/api/linkedin-messages", body);
    return jsonResult(result);
  });

  server.tool("delete_linkedin_message", "Delete a LinkedIn message by UUID.", {
    uuid: z.string().describe("UUID of the LinkedIn message to delete"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/linkedin-messages/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("retry_linkedin_message", "Retry sending a failed LinkedIn message.", {
    uuid: z.string().describe("UUID of the LinkedIn message to retry"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/linkedin-messages/${params.uuid}/retry`);
    return jsonResult(result);
  });

  // ===========================
  // EMAILS
  // ===========================

  server.tool("list_emails", "List emails from the unified inbox. Supports filters, pagination, and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(), lead_uuid: z.string().optional(),
    sender_profile_uuid: z.string().optional(), status: z.string().optional(),
    type: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const query = buildQuery(params, ["lead_uuid", "sender_profile_uuid", "status", "type"]);
    const result = await grinfiRequest("GET", "/emails/api/emails", undefined, query);
    return jsonResult(result);
  });

  server.tool("get_email", "Get email metadata by UUID: from/to addresses, subject, status, timestamps. Does NOT include the email HTML body — use get_email_body with the email_body_uuid from this response to get content.", {
    uuid: z.string().describe("UUID of the email"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/emails/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("send_email", "Send an email to a contact. Requires mailbox_uuid (use list_mailboxes to find it) and body (HTML content). The to field is an array of recipients [{to_email, to_name}].", {
    sender_profile_uuid: z.string().describe("UUID of the sender profile"),
    lead_uuid: z.string().describe("UUID of the contact (lead)"),
    mailbox_uuid: z.string().describe("UUID of the sending mailbox (use list_mailboxes to find)"),
    from_name: z.string().describe("Sender display name"),
    from_email: z.string().describe("Sender email address"),
    to: z.array(z.object({
      to_email: z.string().describe("Recipient email address"),
      to_name: z.string().optional().describe("Recipient name"),
    })).describe("Array of recipients [{to_email, to_name}]"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body in HTML format (e.g. '<p>Hello!</p>')"),
    cc: z.array(z.string()).optional().describe("CC email addresses"),
    bcc: z.array(z.string()).optional().describe("BCC email addresses"),
    attachments: z.array(z.object({ uuid: z.string(), name: z.string() })).optional().describe("Array of attachment objects {uuid, name} from upload_attachment"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const body: Record<string, unknown> = {
      sender_profile_uuid: params.sender_profile_uuid, lead_uuid: params.lead_uuid,
      mailbox_uuid: params.mailbox_uuid,
      from_name: params.from_name, from_email: params.from_email,
      to: params.to, subject: params.subject, body: params.body,
    };
    if (params.cc) body.cc = params.cc;
    if (params.bcc) body.bcc = params.bcc;
    if (params.attachments && params.attachments.length > 0) body.attachments = params.attachments;
    const result = await grinfiRequest("POST", "/emails/api/emails/send-email", body);
    return jsonResult(result);
  });

  server.tool("delete_email", "Delete an email by UUID.", { uuid: z.string().describe("UUID of the email to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/emails/api/emails/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_email_body", "Get email HTML content and attachments by email_body_uuid. First call get_email to get the email_body_uuid, then use this tool to read the actual email content.", {
    uuid: z.string().describe("UUID of the email body"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/email-bodies/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("list_email_bodies", "List email bodies (HTML content) with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/email-bodies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_email_thread", "Render the email conversation thread for a reply email. Returns formatted HTML thread. Use when you need the raw thread for a specific reply.", {
    reply_to_email_uuid: z.string().describe("UUID of the reply email to render thread for"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/emails/${params.reply_to_email_uuid}/thread`);
    return jsonResult(result);
  });

  server.tool(
    "get_email_llm_thread",
    "Get an email conversation thread optimized for AI analysis. Returns clean text format — use this when you need to understand the email conversation history before composing a reply.",
    {
      sender_profile_uuid: z.string().describe("UUID of the sender profile"),
      lead_uuid: z.string().describe("UUID of the contact"),
      lead_name: z.string().describe("Name of the contact (for personalization)"),
      limit: z.string().optional(),
      sent_at_recency_in_days: z.number().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const body: Record<string, unknown> = {
        sender_profile_uuid: params.sender_profile_uuid,
        lead_uuid: params.lead_uuid,
        lead_name: params.lead_name,
      };
      if (params.limit) body.limit = params.limit;
      if (params.sent_at_recency_in_days !== undefined) body.sent_at_recency_in_days = params.sent_at_recency_in_days;
      const result = await grinfiRequest("POST", "/emails/api/emails/llm-thread", body);
      return jsonResult(result);
    }
  );

  server.tool("get_latest_emails_by_leads", "Get the latest email for each of the specified lead UUIDs.", {
    lead_uuids: z.array(z.string()).describe("Array of lead UUIDs to get latest emails for"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/emails/api/emails/latest-by-leads", { lead_uuids: params.lead_uuids });
    return jsonResult(result);
  });

  // ===========================
  // MAILBOXES
  // ===========================

  server.tool("list_mailboxes", "List email mailboxes with pagination, sorting, and search. Shows all configured SMTP/IMAP/Gmail/Outlook mailboxes.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/mailboxes", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_mailbox", "Get a specific mailbox by UUID. Shows connection settings, status, sending limits, etc.", {
    uuid: z.string().describe("UUID of the mailbox"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/mailboxes/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_mailbox", "Create a new SMTP/IMAP mailbox. Provide email, sender name, connection settings.", {
    email: z.string().describe("Email address for the mailbox"),
    sender_name: z.string().describe("Display name for outgoing emails"),
    sender_profile_uuid: z.string().describe("UUID of the sender profile to associate with"),
    provider: z.string().optional(),
    connection_settings: z.record(z.string(), z.unknown()).optional(),
    automation_daily_limit: z.number().optional(),
    automation_task_interval: z.number().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/emails/api/mailboxes", params);
    return jsonResult(result);
  });

  server.tool("update_mailbox", "Update a mailbox by UUID. Can change sender name, connection settings, daily limits, etc.", {
    uuid: z.string().describe("UUID of the mailbox to update"),
    sender_name: z.string().optional(),
    connection_settings: z.record(z.string(), z.unknown()).optional(),
    automation_daily_limit: z.number().optional(),
    automation_task_interval: z.number().optional(),
    custom_tracking_domain_uuid: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/emails/api/mailboxes/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_mailbox", "Delete a mailbox by UUID. Optionally reassign automations to another mailbox.", {
    uuid: z.string().describe("UUID of the mailbox to delete"),
    automation_reassign_mailboxes: z.boolean().describe("Whether to reassign automations using this mailbox"),
    automation_mailbox_to_reassign: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const body: Record<string, unknown> = { automation_reassign_mailboxes: params.automation_reassign_mailboxes };
    if (params.automation_mailbox_to_reassign) body.automation_mailbox_to_reassign = params.automation_mailbox_to_reassign;
    const result = await grinfiRequest("DELETE", `/emails/api/mailboxes/${params.uuid}`, body);
    return jsonResult(result);
  });

  server.tool("activate_mailbox", "Activate a mailbox so it can send and sync emails.", {
    uuid: z.string().describe("UUID of the mailbox to activate"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/emails/api/mailboxes/${params.uuid}/activate`);
    return jsonResult(result);
  });

  server.tool("deactivate_mailbox", "Deactivate a mailbox to stop sending and syncing.", {
    uuid: z.string().describe("UUID of the mailbox to deactivate"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/emails/api/mailboxes/${params.uuid}/deactivate`);
    return jsonResult(result);
  });

  server.tool("list_mailbox_errors", "List mailbox errors for debugging. Shows send/sync errors with timestamps and details.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/mailbox-errors", undefined, buildQuery(params));
    return jsonResult(result);
  });

  // ===========================
  // CUSTOM TRACKING DOMAINS
  // ===========================

  server.tool("list_custom_tracking_domains", "List custom tracking domains used for email link/open tracking.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/custom-tracking-domains", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_custom_tracking_domain", "Get a custom tracking domain by UUID. Shows DNS status (CNAME, DKIM, SPF, DMARC).", {
    uuid: z.string().describe("UUID of the custom tracking domain"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/custom-tracking-domains/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_custom_tracking_domain", "Create a new custom tracking domain for email tracking.", {
    domain: z.string().describe("The custom tracking domain (e.g. 'track.yourcompany.com')"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/emails/api/custom-tracking-domains", { domain: params.domain });
    return jsonResult(result);
  });

  // ===========================
  // SENDER PROFILES
  // ===========================

  server.tool("list_sender_profiles", "Get all sender profiles. These represent the LinkedIn/email accounts you send from.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/flows/api/sender-profiles", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_sender_profile", "Get a sender profile by UUID.", { uuid: z.string() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/sender-profiles/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_sender_profile", "Create a new sender profile.", {
    first_name: z.string(), last_name: z.string(),
    label: z.string().optional(), assignee_user_id: z.number().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { first_name: params.first_name, last_name: params.last_name };
    if (params.label) body.label = params.label;
    if (params.assignee_user_id !== undefined) body.assignee_user_id = params.assignee_user_id;
    const result = await grinfiRequest("POST", "/flows/api/sender-profiles", body);
    return jsonResult(result);
  });

  server.tool("update_sender_profile", "Update a sender profile by UUID.", {
    uuid: z.string().describe("UUID of the sender profile to update"),
    first_name: z.string().optional(), last_name: z.string().optional(),
    label: z.string().optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/flows/api/sender-profiles/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_sender_profile", "Delete a sender profile by UUID.", {
    uuid: z.string().describe("UUID of the sender profile to delete"),
  },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/sender-profiles/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("enable_sender_profile", "Enable a sender profile.", {
    uuid: z.string().describe("UUID of the sender profile to enable"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/sender-profiles/${params.uuid}/enable`);
    return jsonResult(result);
  });

  server.tool("disable_sender_profile", "Disable a sender profile.", {
    uuid: z.string().describe("UUID of the sender profile to disable"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/sender-profiles/${params.uuid}/disable`);
    return jsonResult(result);
  });

  // ===========================
  // AI AGENTS
  // ===========================

  server.tool("list_ai_agents", "List AI agents with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/agents", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_ai_agent", "Get an AI agent by UUID.", { uuid: z.string().describe("UUID of the AI agent") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/agents/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // AI TEMPLATES
  // ===========================

  server.tool("list_ai_templates", "List AI templates with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/templates", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_ai_template", "Get an AI template by UUID.", { uuid: z.string().describe("UUID of the AI template") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/templates/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_ai_template", "Create a new AI template for generating messages.", {
    name: z.string().describe("Template name"),
    type: z.string().optional(), prompt: z.string().optional(),
    body: z.string().optional(), subject: z.string().optional(),
    fallback_body: z.string().optional(),
    enable_validation: z.boolean().optional(),
    template_category_uuid: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/templates", params);
    return jsonResult(result);
  });

  server.tool("render_ai_template", "Render an AI template with variables to generate a message.", {
    template_uuid: z.string().describe("UUID of the AI template to render"),
    variables: z.record(z.string(), z.unknown()).optional().describe("Variables to pass to the template"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const body: Record<string, unknown> = {};
    if (params.variables) body.variables = params.variables;
    const result = await grinfiRequest("POST", `/ai/api/templates/${params.template_uuid}/render`, body);
    return jsonResult(result);
  });

  // ===========================
  // AI VARIABLES
  // ===========================

  server.tool("list_ai_variables", "List AI variables with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/variables", undefined, buildQuery(params));
    return jsonResult(result);
  });

  // ===========================
  // AI ASK
  // ===========================

  server.tool("ai_ask", "Ask the Grinfi AI a question. Can be used for generating content, analyzing data, etc.", {
    question: z.string().describe("The question or prompt for the AI"),
    context: z.record(z.string(), z.unknown()).optional().describe("Additional context for the AI"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const body: Record<string, unknown> = { question: params.question };
    if (params.context) body.context = params.context;
    const result = await grinfiRequest("POST", "/ai/api/ask", body);
    return jsonResult(result);
  });

  // ===========================
  // LLMs
  // ===========================

  server.tool("list_llms", "List all LLM integrations (OpenAI, Anthropic, Google, etc.) configured in your account.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/ai/api/llms");
    return jsonResult(result);
  });

  server.tool("get_llm", "Get an LLM integration by UUID.", { uuid: z.string().describe("UUID of the LLM integration") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/llms/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_llm", "Create a new LLM integration. Supported providers: openai, google, anthropic, perplexity, deepseek, xai, meta.", {
    name: z.string().describe("Human-readable name"),
    provider: z.enum(["openai", "google", "anthropic", "perplexity", "deepseek", "xai", "meta"]).describe("LLM provider"),
    provider_api_token: z.string().describe("API token for the provider"),
    owner: z.enum(["gs", "customer"]).optional().describe("Who owns this integration (default: customer)"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/llms", params);
    return jsonResult(result);
  });

  server.tool("update_llm", "Update an LLM integration by UUID. Can update name and/or API token.", {
    uuid: z.string().describe("UUID of the LLM to update"),
    name: z.string().optional(), provider_api_token: z.string().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/ai/api/llms/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_llm", "Delete an LLM integration by UUID.", { uuid: z.string().describe("UUID of the LLM to delete") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/ai/api/llms/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("generate_llm_response", "Generate a response using a specific LLM integration. Pass messages and config.", {
    uuid: z.string().describe("UUID of the LLM integration to use"),
    job_type: z.enum(["ai_variable", "ai_template", "ai_agent"]).describe("Purpose of the generation"),
    messages: z.array(z.record(z.string(), z.unknown())).describe("Chat history / messages array"),
    config: z.record(z.string(), z.unknown()).optional().describe("Provider-specific config (model, temperature, max_tokens, etc.)"),
  },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
    const body: Record<string, unknown> = {
      job_type: params.job_type,
      messages: params.messages,
    };
    if (params.config) body.config = params.config;
    const result = await grinfiRequest("POST", `/ai/api/llms/${params.uuid}/generate`, body);
    return jsonResult(result);
  });

  server.tool("get_llm_metrics", "Get usage metrics for specified LLM integrations (e.g. credits used this month).", {
    uuids: z.array(z.string()).describe("Array of LLM UUIDs"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/llms/metrics", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("list_llm_logs", "List LLM generation logs with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/llm-logs", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_llm_log", "Get a specific LLM log entry by UUID.", { uuid: z.string().describe("UUID of the LLM log entry") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/llm-logs/${params.uuid}`);
    return jsonResult(result);
  });

  return server;
}

// --- HTTP Server with Streamable HTTP ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Track sessions: each session gets its own McpServer + Transport pair
// Track sessions: each session gets its own McpServer + Transport pair + optional tenant key
const sessions = new Map<string, {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  grinfiApiKey?: string;
}>();

interface AuthResult {
  authorized: boolean;
  mcpPath: boolean;
  grinfiApiKey?: string; // set for multi-tenant tokens
}

function extractAuth(req: IncomingMessage): AuthResult {
  const url = req.url ?? "";
  const ownerKey = process.env.MCP_API_KEY; // may be undefined

  // Pattern 1: /mcp/{key} (Claude.ai style - key in URL)
  const urlMatch = url.match(/^\/mcp\/([a-zA-Z0-9-]+)/);
  if (urlMatch) {
    const token = urlMatch[1];
    // Check owner key first
    if (ownerKey && token === ownerKey) {
      return { authorized: true, mcpPath: true };
    }
    // Check tenant store
    const tenantApiKey = getApiKeyByToken(token);
    if (tenantApiKey) {
      return { authorized: true, mcpPath: true, grinfiApiKey: tenantApiKey };
    }
    // Check OAuth access tokens
    const oauthJwt = getGrinfiJwtByAccessToken(token);
    if (oauthJwt) {
      return { authorized: true, mcpPath: true, grinfiApiKey: oauthJwt };
    }
    return { authorized: false, mcpPath: true };
  }

  // Pattern 2: /mcp or / with Authorization: Bearer {key} (standard MCP + OAuth)
  if (url === "/mcp" || url === "/" || url === "/mcp/") {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
      if (ownerKey && bearerToken === ownerKey) {
        return { authorized: true, mcpPath: true };
      }
      const tenantApiKey = getApiKeyByToken(bearerToken);
      if (tenantApiKey) {
        return { authorized: true, mcpPath: true, grinfiApiKey: tenantApiKey };
      }
      // Check OAuth access tokens
      const oauthJwt = getGrinfiJwtByAccessToken(bearerToken);
      if (oauthJwt) {
        return { authorized: true, mcpPath: true, grinfiApiKey: oauthJwt };
      }
    }
    return { authorized: false, mcpPath: true };
  }

  return { authorized: false, mcpPath: false };
}

// --- Rate limiting for /api/register ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // max registrations per IP per hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

/** Read full request body as string */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Validate a Grinfi API key by making a test request */
async function validateGrinfiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/leads/api/lists?limit=1", BASE_URL).toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Run handler inside tenant AsyncLocalStorage context if needed */
async function withTenantContext(grinfiApiKey: string | undefined, fn: () => Promise<void>): Promise<void> {
  if (grinfiApiKey) {
    await tenantStorage.run({ grinfiApiKey }, fn);
  } else {
    await fn();
  }
}

// --- Load tenants at startup ---
loadTenants();
initOAuthStore();
loadOAuthTokens();

// --- HTTP Server ---
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "";
  // --- OAuth 2.1 Endpoints ---
  const parsedOAuthUrl = new URL(url, "http://localhost");
  const ISSUER = "https://mcp.grinfi.io";

  // Protected Resource Metadata (RFC 9728)
  if (parsedOAuthUrl.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      resource: ISSUER,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp:full"],
      bearer_methods_supported: ["header"],
    }));
    return;
  }

  // Authorization Server Metadata (RFC 8414)
  if (parsedOAuthUrl.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp:full"],
    }));
    return;
  }

  // Dynamic Client Registration (RFC 7591)
  if (parsedOAuthUrl.pathname === "/oauth/register" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const client = registerClient(body);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client_metadata" }));
    }
    return;
  }

  // Authorization Endpoint - GET (show login page)
  if (parsedOAuthUrl.pathname === "/oauth/authorize" && req.method === "GET") {
    const sp = parsedOAuthUrl.searchParams;
    const clientId = sp.get("client_id") ?? "";
    const redirectUri = sp.get("redirect_uri") ?? "";
    const state = sp.get("state") ?? "";
    const codeChallenge = sp.get("code_challenge") ?? "";
    const codeChallengeMethod = sp.get("code_challenge_method") ?? "S256";
    const scope = sp.get("scope") ?? "mcp:full";

    const client = getClient(clientId);
    if (!client) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Invalid client_id</h1>");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Grinfi to Claude</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:40px;max-width:400px;width:100%;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
.logo{text-align:center;margin-bottom:24px}
.logo h1{font-size:24px;color:#1a1a1a;margin-top:12px}
.logo p{color:#666;font-size:14px;margin-top:4px}
.field{margin-bottom:16px}
.field label{display:block;font-size:14px;font-weight:500;color:#333;margin-bottom:6px}
.field input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;outline:none;transition:border-color 0.2s}
.field input:focus{border-color:#0ba10c}
.btn{width:100%;padding:12px;background:#0ba10c;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background 0.2s}
.btn:hover{background:#4a2db3}
.permissions{background:#f0fdf0;border:1px solid #0ba10c33;border-radius:8px;padding:14px 16px;margin-bottom:20px}
.perm-title{font-weight:600;font-size:13px;color:#1a1a2e;margin-bottom:8px}
.permissions ul{list-style:none;padding:0;margin:0}
.permissions li{font-size:13px;color:#444;padding:3px 0}
.error{color:#e53e3e;font-size:13px;margin-top:12px;text-align:center;display:none}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>Grinfi</h1>
    <p>Connect your account to Claude</p>
  </div>
  <form id="loginForm" method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
    <input type="hidden" name="scope" value="${scope}">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required placeholder="you@company.com" autocomplete="email">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="Your Grinfi password" autocomplete="current-password">
    </div>
    <button type="submit" class="btn">Connect to Claude</button>
    <div class="error" id="errorMsg"></div>
  </form>
</div>
</body>
</html>`);
    return;
  }

  // Authorization Endpoint - POST (handle login form or team selection)
  if (parsedOAuthUrl.pathname === "/oauth/authorize" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const bodyStr = Buffer.concat(chunks).toString();
      const formParams = new URLSearchParams(bodyStr);

      const clientId = formParams.get("client_id") ?? "";
      const redirectUri = formParams.get("redirect_uri") ?? "";
      const state = formParams.get("state") ?? "";
      const codeChallenge = formParams.get("code_challenge") ?? "";
      const codeChallengeMethod = formParams.get("code_challenge_method") ?? "S256";
      const scope = formParams.get("scope") ?? "mcp:full";

      const client = getClient(clientId);
      if (!client) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }

      // Check if this is a team selection (step 2) or login (step 1)
      const selectedTeamId = formParams.get("team_id");
      const sessionToken = formParams.get("session_token");

      let sessionJwt: string;

      if (selectedTeamId && sessionToken) {
        // Step 2: team was selected, use existing session token
        sessionJwt = sessionToken;
        console.log("OAuth: team selected:", selectedTeamId);
      } else {
        // Step 1: login with email/password
        const email = formParams.get("email") ?? "";
        const password = formParams.get("password") ?? "";

        const loginResp = await fetch("https://leadgen.grinfi.io/id/api/users/get-jwt-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!loginResp.ok) {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
h1{color:#e53e3e;margin-bottom:12px}a{color:#0ba10c}</style></head>
<body><div class="card"><h1>Login Failed</h1><p>Invalid email or password.</p><p style="margin-top:16px"><a href="javascript:history.back()">Try again</a></p></div></body></html>`);
          return;
        }

        const loginData = await loginResp.json() as { token?: string; jwt_token?: string; data?: { token?: string } };
        sessionJwt = (loginData.token ?? loginData.jwt_token ?? (loginData.data as Record<string, unknown>)?.token) as string;

        if (!sessionJwt) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no_token_received" }));
          return;
        }

        // Decode JWT to check how many teams user has
        let userTeams: Record<string, number> = {};
        try {
          const jwtPayload = JSON.parse(Buffer.from(sessionJwt.split(".")[1], "base64").toString());
          userTeams = (jwtPayload.user_teams as Record<string, number>) ?? {};
          console.log("OAuth: user logged in:", jwtPayload.usr?.email, "teams:", Object.keys(userTeams).length);
        } catch (e) {
          console.error("OAuth: failed to decode JWT:", e);
        }

        const teamIds = Object.keys(userTeams);

        // If user has multiple teams, show team selection page
        if (teamIds.length > 1) {
          // Fetch team names from API
          let teams: Array<{ id: string; name: string }> = teamIds.map((id) => ({ id, name: `Team ${id}` }));
          try {
            // Build teams from JWT user_teams (complete list) + API names where available
            const jwtTeamIds = Object.keys(userTeams);
            
            // Fetch one page from API to get names for recent teams
            const nameMap = new Map<string, string>();
            const teamsResp = await fetch("https://leadgen.grinfi.io/id/api/teams", {
              headers: { Authorization: `Bearer ${sessionJwt}` },
            });
            if (teamsResp.ok) {
              const teamsData = (await teamsResp.json()) as { data?: Array<{ id: number; name: string }> } | Array<{ id: number; name: string }>;
              const teamsArr = Array.isArray(teamsData) ? teamsData : teamsData.data ?? [];
              for (const t of teamsArr) {
                nameMap.set(String(t.id), t.name || `Team ${t.id}`);
              }
            }
            
            // Use all JWT team IDs, with names from API where available
            teams = jwtTeamIds.map((id) => ({
              id,
              name: nameMap.get(id) || `Team ${id}`,
            }));
            // Sort: named teams first (descending by id), then unnamed (descending by id)
            teams.sort((a, b) => {
              const aHasName = !a.name.startsWith("Team ");
              const bHasName = !b.name.startsWith("Team ");
              if (aHasName && !bHasName) return -1;
              if (!aHasName && bHasName) return 1;
              return Number(b.id) - Number(a.id);
            });
            console.log("OAuth: built", teams.length, "teams from JWT,", nameMap.size, "with names from API");
          } catch (e) {
            console.error("OAuth: failed to fetch teams:", e);
          }

          const teamOptions = teams
            .map((t) => `<option value="${t.id}">${t.id} — ${t.name}</option>`)
            .join("\n              ");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Select Team — Grinfi MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0ba10c 0%,#089a09 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,0.15)}
h1{font-size:22px;color:#1a1a2e;margin-bottom:8px;text-align:center}
p{color:#666;font-size:14px;margin-bottom:24px;text-align:center}
.select{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;color:#1a1a2e;background:#fff;appearance:auto}
.select:focus{outline:none;border-color:#0ba10c}
</style></head>
<body>
<div class="card">
  <h1>Select Team</h1>
  <p>Choose which team to connect with Claude</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
    <input type="hidden" name="scope" value="${scope}">
    <input type="hidden" name="session_token" value="${sessionJwt}">
    <div class="field">
      <label for="team_id">Team</label>
      <select name="team_id" id="team_id" class="select">
              ${teamOptions}
      </select>
    </div>
    <button type="submit" class="btn">Connect</button>
  </form>
</div>
</body></html>`);
          return;
        }

        // Single team — auto-select it
        if (teamIds.length === 1) {
          // Continue with this team ID below
          (formParams as unknown as Map<string, string>).set("team_id", teamIds[0]);
        }
      }

      // At this point we have sessionJwt and optionally a team_id
      const teamId = formParams.get("team_id") ?? selectedTeamId ?? "";

      // Decode JWT for logging
      try {
        const jwtPayload = JSON.parse(Buffer.from(sessionJwt.split(".")[1], "base64").toString());
        const finalTeam = teamId || String(jwtPayload.specific_team_id ?? "");
        console.log("OAuth: creating API key for team:", finalTeam, "user:", jwtPayload.usr?.email);
      } catch {}

      // Create a persistent API key
      const apiKeyHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionJwt}`,
      };
      if (teamId) apiKeyHeaders["Team-ID"] = teamId;

      const apiKeyResp = await fetch("https://leadgen.grinfi.io/id/api/jwt-tokens/create-api-key", {
        method: "POST",
        headers: apiKeyHeaders,
        body: JSON.stringify({ name: `Claude MCP (${new Date().toISOString().slice(0, 10)})` }),
      });

      let grinfiApiKey: string;
      if (apiKeyResp.ok) {
        const apiKeyData = (await apiKeyResp.json()) as Record<string, unknown>;
        console.log("OAuth: API key created, type:", apiKeyData.type, "jti:", apiKeyData.jti);
        grinfiApiKey =
          (apiKeyData.last_token as string) ??
          (apiKeyData.token as string) ??
          (apiKeyData.jwt_token as string) ??
          ((apiKeyData.data as Record<string, unknown>)?.last_token as string) ??
          ((apiKeyData.data as Record<string, unknown>)?.token as string) ??
          (sessionJwt as string);
      } else {
        const errBody = await apiKeyResp.text();
        console.error("OAuth: API key creation failed:", apiKeyResp.status, errBody);
        grinfiApiKey = sessionJwt as string;
      }
      console.log("OAuth: using key type:", grinfiApiKey === sessionJwt ? "session-jwt-fallback" : "persistent-api-key");

      // Generate authorization code
      const code = createAuthCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        grinfiJwt: grinfiApiKey,
        scope,
      });

      // Redirect back to Claude with auth code
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", detail: String(err) }));
    }
    return;
  }

  // Token Endpoint
  if (parsedOAuthUrl.pathname === "/oauth/token" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const bodyStr = Buffer.concat(chunks).toString();

      let tokenParams: URLSearchParams;
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        const json = JSON.parse(bodyStr);
        tokenParams = new URLSearchParams();
        for (const [k, v] of Object.entries(json)) tokenParams.set(k, String(v));
      } else {
        tokenParams = new URLSearchParams(bodyStr);
      }

      const grantType = tokenParams.get("grant_type") ?? "";
      const clientId = tokenParams.get("client_id") ?? "";

      if (grantType === "authorization_code") {
        const code = tokenParams.get("code") ?? "";
        const codeVerifier = tokenParams.get("code_verifier") ?? "";

        const authCode = consumeAuthCode(code);
        if (!authCode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }));
          return;
        }
        if (authCode.clientId !== clientId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Client ID mismatch" }));
          return;
        }
        if (!verifyPKCE(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
          return;
        }

        console.log("OAuth: exchanging code for tokens, clientId:", clientId);
        const tokens = issueTokens({ clientId, grinfiJwt: authCode.grinfiJwt, scope: authCode.scope });
        console.log("OAuth: tokens issued for client:", clientId);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(tokens));
        return;
      }

      if (grantType === "refresh_token") {
        const refreshTokenVal = tokenParams.get("refresh_token") ?? "";
        const tokens = refreshAccessToken(refreshTokenVal, clientId);
        if (!tokens) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(tokens));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", detail: String(err) }));
    }
    return;
  }

  // Token Revocation
  if (parsedOAuthUrl.pathname === "/oauth/revoke" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const revokeParams = new URLSearchParams(Buffer.concat(chunks).toString());
      revokeToken(revokeParams.get("token") ?? "");
    } catch { /* ignore */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // --- Landing page ---
  const parsedUrl = new URL(url, "http://localhost"); if (parsedUrl.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getLandingPageHtml());
    return;
  }

  // --- Health check ---
  if (url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "grinfi-mcp", tenants: getTenantCount() }));
    return;
  }

  // --- Registration API ---
  if (url === "/api/register" && req.method === "POST") {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress || "unknown";

    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Too many requests. Please try again later." }));
      return;
    }

    try {
      const body = await readBody(req);
      const { apiKey } = JSON.parse(body) as { apiKey?: string };

      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Please provide a valid API key." }));
        return;
      }

      const trimmedKey = apiKey.trim();

      // Validate key against Grinfi API
      const valid = await validateGrinfiKey(trimmedKey);
      if (!valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: "Invalid API key. Please check your key at Grinfi \u2192 Settings \u2192 API Keys."
        }));
        return;
      }

      const token = registerTenant(trimmedKey);
      const endpointUrl = `https://mcp.grinfi.io/mcp/${token}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token, url: endpointUrl }));
    } catch (error) {
      console.error("Registration error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Internal server error. Please try again." }));
    }
    return;
  }

  // --- MCP requests ---
  const auth = extractAuth(req);

  if (!auth.mcpPath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!auth.authorized) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.grinfi.io/.well-known/oauth-protected-resource"' });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Check for existing session
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    const tenantKey = auth.grinfiApiKey ?? session.grinfiApiKey;
    try {
      await withTenantContext(tenantKey, () => session.transport.handleRequest(req, res));
    } catch (error) {
      console.error("MCP session request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  // Session ID provided but session not found (e.g. after server restart)
  // Return 404 so client reinitializes instead of crashing
  if (sessionId && !sessions.has(sessionId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session expired. Please reconnect." }));
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
    const tenantKey = auth.grinfiApiKey;

    await withTenantContext(tenantKey, async () => {
      const mcpServer = createMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { transport, server: mcpServer, grinfiApiKey: tenantKey });
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
    });
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

// Prevent process crashes from killing all MCP connections
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (kept alive):", reason);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Grinfi MCP HTTP server running on http://0.0.0.0:${PORT}`);
  console.log(`Landing page: http://0.0.0.0:${PORT}/`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp/{token}`);
});
