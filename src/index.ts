#!/usr/bin/env node

/**
 * Grinfi MCP server — stdio transport (for local CLI usage).
 *
 * Usage (single team):
 *   GRINFI_API_KEY=xxx node dist/index.js
 *
 * Usage (multi-team):
 *   GRINFI_TEAM_KEYS="134:key1,559:key2" GRINFI_ACTIVE_TEAM=134 node dist/index.js
 *
 * Environment variables:
 *   GRINFI_API_KEY      - Your Grinfi API key (required for single-team mode)
 *   GRINFI_TEAM_KEYS    - Comma-separated list of teamId:apiKey pairs (multi-team mode)
 *   GRINFI_ACTIVE_TEAM  - Default active team ID (optional, defaults to first in GRINFI_TEAM_KEYS)
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Multi-team state ---

interface TeamEntry { teamId: string; apiKey: string; }

// Extract team ID from JWT payload (specific_team_id field)
function teamIdFromJwt(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return String(payload.specific_team_id ?? "");
  } catch { return ""; }
}

// Parse GRINFI_TEAM_KEYS — supports both "teamId:apiKey" and plain "apiKey" formats
function parseTeamKeys(): TeamEntry[] {
  const raw = process.env.GRINFI_TEAM_KEYS ?? "";
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(apiKey => {
    // If it looks like a JWT (contains dots, no colon before first dot), extract team ID from it
    const firstDot = apiKey.indexOf(".");
    const firstColon = apiKey.indexOf(":");
    if (firstDot !== -1 && (firstColon === -1 || firstDot < firstColon)) {
      const teamId = teamIdFromJwt(apiKey);
      return { teamId, apiKey };
    }
    // Legacy "teamId:apiKey" format
    const idx = firstColon;
    return { teamId: apiKey.slice(0, idx), apiKey: apiKey.slice(idx + 1) };
  }).filter(e => e.teamId && e.apiKey);
}

const teamKeys: TeamEntry[] = parseTeamKeys();
let activeTeamId: string = process.env.GRINFI_ACTIVE_TEAM ?? teamKeys[0]?.teamId ?? "";

// --- Helpers ---

const BASE_URL = "https://leadgen.grinfi.io";

function getApiKey(): string {
  // Multi-team mode
  if (teamKeys.length > 0) {
    const entry = teamKeys.find(e => e.teamId === activeTeamId) ?? teamKeys[0];
    return entry.apiKey;
  }
  // Single-team mode
  const key = process.env.GRINFI_API_KEY;
  if (!key) {
    throw new Error(
      "GRINFI_API_KEY environment variable is not set. " +
        "Get your API key from Grinfi.io → Settings → API Keys."
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

// Multipart/form-data upload helper. Used for file imports and attachments.
async function grinfiUpload(
  path: string,
  filePath: string,
  fieldName = "file",
  filename?: string,
  extraFields?: Record<string, string>,
): Promise<unknown> {
  const buffer = await readFile(filePath);
  const formData = new FormData();
  // Buffer is Uint8Array-compatible; cast for stricter @types/node Blob signature.
  formData.append(
    fieldName,
    new Blob([buffer as unknown as BlobPart]),
    filename ?? basename(filePath),
  );
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) formData.append(k, v);
  }

  const url = new URL(path, BASE_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
    },
    body: formData,
  });

  if (response.status === 204) {
    return { success: true, message: "Upload completed successfully (204 No Content)" };
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

  // ===========================
  // CONTACTS
  // ===========================

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
      if (params.disable_aggregation !== undefined) body.disable_aggregation = params.disable_aggregation;
      const result = await grinfiRequest("POST", "/leads/api/leads/lookup-one", body);
      return jsonResult(result, true);
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
      return jsonResult(result, true);
    }
  );

  server.tool("get_contact", "Get a contact by their UUID.", { uuid: z.string().describe("UUID of the contact") }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/leads/${params.uuid}`);
    return jsonResult(result, true);
  });

  server.tool(
    "update_contact",
    "Update a contact's fields by UUID. To change pipeline stage, use change_contact_pipeline_stage tool instead.",
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
      return jsonResult(result, true);
    }
  );

  server.tool("delete_contact", "Delete a contact by UUID. This action is irreversible.", { uuid: z.string().describe("UUID of the contact to delete") }, async (params) => {
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
    "Change the pipeline stage of one or more contacts. Use list_pipeline_stages to get available stage UUIDs first.",
    {
      contact_uuids: z.array(z.string()).describe("Array of contact UUIDs to change"),
      pipeline_stage_uuid: z.string().describe("UUID of the target pipeline stage"),
    },
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
    "Perform a mass action on leads. Types: contact_change_pipeline_stage, contact_mark_read, etc. For pipeline stage changes prefer change_contact_pipeline_stage tool.",
    {
      type: z.string().describe("Mass action type (e.g. 'contact_change_pipeline_stage', 'contact_mark_read')"),
      filter: z.record(z.string(), z.unknown()).describe("Filter to select leads"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Action-specific payload"),
    },
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/lists", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_list", "Get a specific contact list by UUID.", { uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/lists/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_list", "Create a new contact list.", { name: z.string().describe("Name of the new list") }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/lists", { name: params.name });
    return jsonResult(result);
  });

  server.tool("update_list", "Update (rename) a contact list.", {
    uuid: z.string().describe("UUID of the list"),
    name: z.string().describe("New list name"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/leads/api/lists/${params.uuid}`, { name: params.name });
    return jsonResult(result);
  });

  server.tool("delete_list", "Delete a contact list by UUID. This action is irreversible.", {
    uuid: z.string().describe("UUID of the list"),
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/lists/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_list_metrics", "Get metrics (lead counts) for specified lists.", {
    uuids: z.array(z.string()).describe("Array of list UUIDs"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/companies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_company", "Get a company by its UUID.", { uuid: z.string().describe("UUID of the company") }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/companies/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("lookup_companies", "Lookup companies by LinkedIn ID, website, or name. Pass an array of lookup objects.", {
    lookups: z.array(z.record(z.string(), z.unknown())).describe("Array of lookup criteria objects"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/companies/lookup", { lookups: params.lookups });
    return jsonResult(result);
  });

  server.tool("search_company_leads", "Get leads (contacts) belonging to specified companies.", {
    uuids: z.array(z.string()).describe("Array of company UUIDs"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/companies/leads", { uuids: params.uuids });
    return jsonResult(result, true);
  });

  server.tool("enrich_companies", "Trigger advanced enrichment for companies. Provide either a filter or an array of company UUIDs.", {
    uuids: z.array(z.string()).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }, async (params) => {
    const body: Record<string, unknown> = {};
    if (params.uuids) body.uuids = params.uuids;
    if (params.filter) body.filter = params.filter;
    const result = await grinfiRequest("POST", "/leads/api/companies/enrich", body);
    return jsonResult(result);
  });

  server.tool(
    "companies_mass_action",
    "Perform a mass action on companies. Types: assign_tag, remove_tag, move_to_list, change_pipeline_stage, delete, etc.",
    {
      type: z.string().describe("Mass action type"),
      filter: z.record(z.string(), z.unknown()).describe("Filter to select companies"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Action-specific payload"),
    },
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

  server.tool("list_tags", "List all tags in your account.", {}, async () => {
    const result = await grinfiRequest("GET", "/leads/api/tags");
    return jsonResult(result);
  });

  server.tool("create_tag", "Create a new tag.", {
    name: z.string().describe("Tag name"),
    color: z.string().optional().describe("Tag color"),
  }, async (params) => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.color) body.color = params.color;
    const result = await grinfiRequest("POST", "/leads/api/tags", body);
    return jsonResult(result);
  });

  server.tool("update_tag", "Update a tag's name or color.", {
    uuid: z.string().describe("UUID of the tag"),
    name: z.string().optional(), color: z.string().optional(),
  }, async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/leads/api/tags/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_tag", "Delete a tag by UUID.", { uuid: z.string().describe("UUID of the tag to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/tags/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_tag_metrics", "Get metrics (leads count, companies count) for specified tags.", {
    uuids: z.array(z.string()).describe("Array of tag UUIDs"),
    metrics: z.array(z.enum(["leads_count", "companies_count"])).describe("Metrics to retrieve"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/tags/metrics", { uuids: params.uuids, metrics: params.metrics });
    return jsonResult(result);
  });

  // ===========================
  // PIPELINE STAGES
  // ===========================

  server.tool("list_pipeline_stages", "List pipeline stages. Filter by object type (lead or company). Returns UUID, name, category, and order for each stage.", {
    object: z.enum(["lead", "company"]).optional().describe("Filter by object type (default: lead)"),
    type: z.enum(["custom", "new", "approaching", "engaging", "replied"]).optional().describe("Filter by stage type"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/pipeline-stages", params);
    return jsonResult(result);
  });

  server.tool("update_pipeline_stage", "Update a pipeline stage's name, category, or order.", {
    uuid: z.string().describe("UUID of the pipeline stage"),
    name: z.string().optional(), category: z.enum(["cold", "engaging", "positive", "negative"]).optional(),
    order: z.number().optional(),
  }, async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/leads/api/pipeline-stages/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_pipeline_stage", "Delete a custom pipeline stage by UUID.", {
    uuid: z.string().describe("UUID of the pipeline stage"),
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/pipeline-stages/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // CUSTOM FIELDS
  // ===========================

  server.tool("list_custom_fields", "List all custom fields. Custom fields can be for leads or companies.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/custom-fields", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("create_custom_field", "Create a new custom field for leads or companies.", {
    name: z.string().describe("Field name"),
    object: z.enum(["lead", "company"]).describe("Object type"),
    order: z.number().optional(),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/custom-fields", params);
    return jsonResult(result);
  });

  server.tool("upsert_custom_field_value", "Set (upsert) a custom field value on a lead or company.", {
    custom_field_uuid: z.string().describe("UUID of the custom field"),
    object_type: z.enum(["lead", "company"]).describe("Object type"),
    object_uuid: z.string().describe("UUID of the lead or company"),
    value: z.unknown().optional().describe("Field value (or null to clear)"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/notes", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_note", "Get a note by its UUID.", { uuid: z.string().describe("UUID of the note") }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/notes/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_note", "Create a note on a lead or company.", {
    object: z.enum(["lead", "company"]).describe("Object type"),
    object_uuid: z.string().describe("UUID of the lead or company"),
    note: z.string().describe("Note text content"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/notes", params);
    return jsonResult(result);
  });

  server.tool("update_note", "Update a note's text.", {
    uuid: z.string().describe("UUID of the note"),
    note: z.string().describe("Updated note text"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/leads/api/notes/${params.uuid}`, { note: params.note });
    return jsonResult(result);
  });

  server.tool("delete_note", "Delete a note by UUID.", { uuid: z.string().describe("UUID of the note to delete") }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/blacklist/leads", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("add_to_leads_blacklist", "Add a lead to the blacklist.", {
    name: z.string().optional(), linkedin: z.string().optional(),
    ln_id: z.string().optional(), personal_email: z.string().optional(),
    work_email: z.string().optional(), company_name: z.string().optional(),
  }, async (params) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("POST", "/leads/api/blacklist/leads", body);
    return jsonResult(result);
  });

  server.tool("list_companies_blacklist", "List blacklisted companies with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/blacklist/companies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("add_to_companies_blacklist", "Add a company to the blacklist.", {
    name: z.string().optional(), domain: z.string().optional(),
    linkedin: z.string().optional(), ln_id: z.string().optional(),
  }, async (params) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("POST", "/leads/api/blacklist/companies", body);
    return jsonResult(result);
  });

  // ===========================
  // WEBHOOKS
  // ===========================

  server.tool("list_webhooks", "List all webhooks configured in your account.", {}, async () => {
    const result = await grinfiRequest("GET", "/integrations/c1/api/webhooks");
    return jsonResult(result);
  });

  server.tool("get_webhook", "Get a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook") }, async (params) => {
    const result = await grinfiRequest("GET", `/integrations/c1/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_webhook", "Create a new webhook. Specify the event to listen for and the target URL to call.", {
    name: z.string().describe("Webhook name"),
    event: z.string().describe("Event to trigger on (e.g. 'contact_exported', 'lead_created', 'lead_updated')"),
    target_url: z.string().describe("URL to send the webhook payload to"),
    request_method: z.string().optional().describe("HTTP method (default: POST)"),
    filters: z.string().optional().describe("Optional filters"),
  }, async (params) => {
    const body = { ...params, request_method: params.request_method || "POST" };
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks", body);
    return jsonResult(result);
  });

  server.tool("update_webhook", "Update a webhook by UUID.", {
    uuid: z.string().describe("UUID of the webhook to update"),
    name: z.string().optional(), event: z.string().optional(),
    target_url: z.string().optional(), request_method: z.string().optional(),
    filters: z.string().optional(),
  }, async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/integrations/c1/api/webhooks/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_webhook", "Delete a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/integrations/c1/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("test_webhook", "Test a webhook by sending a test payload.", {
    event: z.string().describe("Event name to test"),
    target_url: z.string().describe("Target URL to send the test to"),
    request_method: z.string().optional(),
    lead_uuid: z.string().optional(),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks/test", params);
    return jsonResult(result);
  });

  server.tool("get_webhook_metrics", "Get metrics for specified webhooks.", {
    uuids: z.array(z.string()).describe("Array of webhook UUIDs"),
    metrics: z.array(z.string()).optional(),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/integrations/c1/api/webhooks/metrics", params);
    return jsonResult(result);
  });

  // ===========================
  // ATTACHMENTS
  // ===========================

  server.tool("list_attachments", "List attachments with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/attachments", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_attachment", "Get an attachment by UUID.", { uuid: z.string().describe("UUID of the attachment") }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/attachments/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("delete_attachment", "Delete an attachment by UUID.", { uuid: z.string().describe("UUID of the attachment to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/attachments/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // ENRICHMENT
  // ===========================

  server.tool("list_enrichment_queue", "List enrichment queue entries with pagination.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/enrichment-queue", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_enrichment_metrics", "Get enrichment queue metrics (e.g. this month's enrichment count).", {}, async () => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/flows/api/flows", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_automation", "Get a specific automation (flow) by UUID with full details.", {
    flow_uuid: z.string().describe("UUID of the automation"),
  }, async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/flows/${params.flow_uuid}`);
    return jsonResult(result);
  });

  server.tool("get_automation_metrics", "Get metrics for specified automations (flows).", {
    uuids: z.array(z.string()).describe("Array of automation UUIDs"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/flows/api/flows/metrics", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("start_automation", "Start an automation (flow) by UUID.", { flow_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/start`);
    return jsonResult(result);
  });

  server.tool("stop_automation", "Stop a running automation (flow) by UUID.", { flow_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/stop`);
    return jsonResult(result);
  });

  server.tool("archive_automation", "Archive an automation (flow).", {
    flow_uuid: z.string().describe("UUID of the automation to archive"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/archive`);
    return jsonResult(result);
  });

  server.tool("unarchive_automation", "Unarchive a previously archived automation (flow).", {
    flow_uuid: z.string().describe("UUID of the automation to unarchive"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/${params.flow_uuid}/unarchive`);
    return jsonResult(result);
  });

  server.tool("delete_automation", "Delete an automation (flow) by UUID. This action is irreversible.", {
    flow_uuid: z.string().describe("UUID of the automation to delete"),
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/flows/${params.flow_uuid}`);
    return jsonResult(result);
  });

  server.tool("clone_automation", "Clone an existing automation (flow). Creates a copy with a new name.", {
    flow_uuid: z.string().describe("UUID of the automation to clone"),
    name: z.string().describe("Name for the cloned automation"),
    flow_workspace_uuid: z.string().optional().describe("Workspace UUID for the clone"),
  }, async (params) => {
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
  }, async (params) => {
    const { flow_uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/flows/api/flows/${flow_uuid}`, body);
    return jsonResult(result);
  });

  server.tool("add_contact_to_automation", "Add an existing contact to an automation by their UUIDs.", {
    flow_uuid: z.string(), lead_uuid: z.string(),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel`, { flow_uuids: params.flow_uuids });
    return jsonResult(result);
  });

  server.tool("cancel_contact_from_all_automations", "Cancel a contact from ALL active automations.", { lead_uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/flows/leads/${params.lead_uuid}/cancel-all`);
    return jsonResult(result);
  });

  server.tool("continue_automation", "Continue (resume) an automation for a specific contact.", { lead_uuid: z.string() }, async (params) => {
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

  server.tool("get_task", "Get a specific task by UUID.", { uuid: z.string().describe("UUID of the task") }, async (params) => {
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
    async (params) => {
      // Default to manual tasks to prevent accidental operations on automation tasks
      const safeParams = { ...params, automation: params.automation ?? "manual" };
      const query = buildQuery(safeParams, ["automation", "status", "type", "lead_uuid", "sender_profile_uuid", "flow_uuid", "assignee_uuid", "schedule_at_before", "schedule_at_after"]);
      const result = await grinfiRequest("GET", "/flows/api/tasks", undefined, query);
      return jsonResult(result);
    }
  );

  server.tool("complete_task", "Mark a MANUAL task as completed. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to complete") }, async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be completed via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/complete`);
    return jsonResult(result);
  });

  server.tool("cancel_task", "Cancel a MANUAL task. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to cancel") }, async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be cancelled via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/cancel`);
    return jsonResult(result);
  });

  server.tool("fail_task", "Mark a MANUAL task as failed. Do NOT use for automatic (automation-created) tasks.", { uuid: z.string().describe("UUID of the manual task to fail") }, async (params) => {
    const task = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`) as { automation?: string };
    if (task.automation !== "manual") {
      return jsonResult({ error: "BLOCKED: This is an automatic task (created by automation). Only MANUAL tasks can be failed via this tool." });
    }
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/fail`);
    return jsonResult(result);
  });

  server.tool("mass_cancel_tasks", "Cancel multiple MANUAL tasks at once. Do NOT use for automatic (automation-created) tasks.", {
    uuids: z.array(z.string()).describe("Array of manual task UUIDs to cancel"),
  }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
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
    async (params) => {
      const query: Record<string, string> = {};
      query["filter[automation]"] = params.automation ?? "manual";
      if (params.schedule_at_before) query["filter[schedule_at_before]"] = params.schedule_at_before;
      if (params.schedule_at_after) query["filter[schedule_at_after]"] = params.schedule_at_after;
      const result = await grinfiRequest("GET", "/flows/api/tasks/group-counts", undefined, query);
      return jsonResult(result);
    }
  );

  server.tool("get_tasks_schedule", "Get the tasks schedule overview.", {}, async () => {
    const result = await grinfiRequest("GET", "/flows/api/tasks/schedule");
    return jsonResult(result);
  });

  // ===========================
  // LINKEDIN MESSAGES (UNIBOX)
  // ===========================

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
    async (params) => {
      try {
        // Step 1: Fetch sender profiles to build Elasticsearch query
        const spResult = await grinfiRequest("GET", "/flows/api/sender-profiles", undefined, {
          limit: "100", offset: "0",
        }) as { data?: Array<{ uuid: string; first_name?: string; last_name?: string }> };

        const senderProfiles = spResult.data ?? [];
        if (senderProfiles.length === 0) {
          return jsonResult({ error: "No sender profiles found" });
        }

        // Build the should clause: for each sender profile, require unread_counts > 0
        let profileUuids = senderProfiles.map((sp: { uuid: string }) => sp.uuid);

        // If filtering by specific sender_profile_uuid, only use that one
        if (params.sender_profile_uuid) {
          profileUuids = profileUuids.filter((u: string) => u === params.sender_profile_uuid);
          if (profileUuids.length === 0) {
            return jsonResult({ unread_conversations: [], total_unread: 0, note: "Sender profile not found" });
          }
        }

        const shouldClauses = profileUuids.map((uuid: string) => ({
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
        const allUnread = items.map((item: { lead: { uuid: string; name?: string; first_name?: string; last_name?: string; unread_counts?: Array<{ count: number }> } }) => {
          const lead = item.lead;
          const totalUnread = (lead.unread_counts ?? []).reduce((s: number, u: { count: number }) => s + u.count, 0);
          const contactName = lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
          return {
            contact_name: contactName,
            contact_uuid: lead.uuid,
            unread_count: totalUnread,
            _grinfi_contact_url: `https://leadgen.grinfi.io/crm/contacts/${lead.uuid}`,
          };
        });

        return jsonResult({
          unread_conversations: allUnread,
          total_unread: allUnread.length,
          total_in_filter: esResult.total ?? allUnread.length,
          sender_profiles_checked: profileUuids.length,
          note: "Use list_linkedin_messages with lead_uuid filter to read specific conversations",
        });
      } catch (err) {
        return jsonResult({ error: `Failed to fetch unread conversations: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  );

  server.tool("mark_conversation_as_read", "Mark a LinkedIn conversation as read in Grinfi. This updates the unread counter in the Grinfi interface.", {
    lead_uuid: z.string().describe("UUID of the contact (lead) whose conversation to mark as read"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/leads/api/leads/mass-action", {
      type: "contact_mark_read",
      filter: { all: false, ids: [params.lead_uuid], excludeIds: [] },
    });
    return jsonResult(result);
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
    return jsonResult(result);
  });

  server.tool("delete_linkedin_message", "Delete a LinkedIn message by UUID.", {
    uuid: z.string().describe("UUID of the LinkedIn message to delete"),
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/linkedin-messages/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("retry_linkedin_message", "Retry sending a failed LinkedIn message.", {
    uuid: z.string().describe("UUID of the LinkedIn message to retry"),
  }, async (params) => {
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
  }, async (params) => {
    const query = buildQuery(params, ["lead_uuid", "sender_profile_uuid", "status", "type"]);
    const result = await grinfiRequest("GET", "/emails/api/emails", undefined, query);
    return jsonResult(result);
  });

  server.tool("get_email", "Get a specific email by UUID. Returns full email details including from/to, subject, status, timestamps.", {
    uuid: z.string().describe("UUID of the email"),
  }, async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/emails/${params.uuid}`);
    return jsonResult(result);
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
    return jsonResult(result);
  });

  server.tool("delete_email", "Delete an email by UUID.", { uuid: z.string().describe("UUID of the email to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/emails/api/emails/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("get_email_body", "Get an email body (HTML content, subject, attachments) by UUID.", {
    uuid: z.string().describe("UUID of the email body"),
  }, async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/email-bodies/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("list_email_bodies", "List email bodies (HTML content) with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/email-bodies", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_email_thread", "Render the email conversation thread for a reply email.", {
    reply_to_email_uuid: z.string().describe("UUID of the reply email to render thread for"),
  }, async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/emails/${params.reply_to_email_uuid}/thread`);
    return jsonResult(result);
  });

  server.tool(
    "get_email_llm_thread",
    "Get an email conversation thread formatted for LLM processing. Optimized for AI analysis and response generation.",
    {
      sender_profile_uuid: z.string().describe("UUID of the sender profile"),
      lead_uuid: z.string().describe("UUID of the contact"),
      lead_name: z.string().describe("Name of the contact (for personalization)"),
      limit: z.string().optional(),
      sent_at_recency_in_days: z.number().optional(),
    },
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
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/mailboxes", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_mailbox", "Get a specific mailbox by UUID. Shows connection settings, status, sending limits, etc.", {
    uuid: z.string().describe("UUID of the mailbox"),
  }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
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
  }, async (params) => {
    const body: Record<string, unknown> = { automation_reassign_mailboxes: params.automation_reassign_mailboxes };
    if (params.automation_mailbox_to_reassign) body.automation_mailbox_to_reassign = params.automation_mailbox_to_reassign;
    const result = await grinfiRequest("DELETE", `/emails/api/mailboxes/${params.uuid}`, body);
    return jsonResult(result);
  });

  server.tool("activate_mailbox", "Activate a mailbox so it can send and sync emails.", {
    uuid: z.string().describe("UUID of the mailbox to activate"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/emails/api/mailboxes/${params.uuid}/activate`);
    return jsonResult(result);
  });

  server.tool("deactivate_mailbox", "Deactivate a mailbox to stop sending and syncing.", {
    uuid: z.string().describe("UUID of the mailbox to deactivate"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/emails/api/mailboxes/${params.uuid}/deactivate`);
    return jsonResult(result);
  });

  server.tool("list_mailbox_errors", "List mailbox errors for debugging. Shows send/sync errors with timestamps and details.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    search: z.string().optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/mailbox-errors", undefined, buildQuery(params));
    return jsonResult(result);
  });

  // ===========================
  // CUSTOM TRACKING DOMAINS
  // ===========================

  server.tool("list_custom_tracking_domains", "List custom tracking domains used for email link/open tracking.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/emails/api/custom-tracking-domains", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_custom_tracking_domain", "Get a custom tracking domain by UUID. Shows DNS status (CNAME, DKIM, SPF, DMARC).", {
    uuid: z.string().describe("UUID of the custom tracking domain"),
  }, async (params) => {
    const result = await grinfiRequest("GET", `/emails/api/custom-tracking-domains/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_custom_tracking_domain", "Create a new custom tracking domain for email tracking.", {
    domain: z.string().describe("The custom tracking domain (e.g. 'track.yourcompany.com')"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/flows/api/sender-profiles", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_sender_profile", "Get a sender profile by UUID.", { uuid: z.string() }, async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/sender-profiles/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_sender_profile", "Create a new sender profile.", {
    first_name: z.string(), last_name: z.string(),
    label: z.string().optional(), assignee_user_id: z.number().optional(),
  }, async (params) => {
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
  }, async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/flows/api/sender-profiles/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_sender_profile", "Delete a sender profile by UUID.", {
    uuid: z.string().describe("UUID of the sender profile to delete"),
  }, async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/sender-profiles/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("enable_sender_profile", "Enable a sender profile.", {
    uuid: z.string().describe("UUID of the sender profile to enable"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/sender-profiles/${params.uuid}/enable`);
    return jsonResult(result);
  });

  server.tool("disable_sender_profile", "Disable a sender profile.", {
    uuid: z.string().describe("UUID of the sender profile to disable"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/agents", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_ai_agent", "Get an AI agent by UUID.", { uuid: z.string().describe("UUID of the AI agent") }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/templates", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_ai_template", "Get an AI template by UUID.", { uuid: z.string().describe("UUID of the AI template") }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/templates", params);
    return jsonResult(result);
  });

  server.tool("render_ai_template", "Render an AI template with variables to generate a message.", {
    template_uuid: z.string().describe("UUID of the AI template to render"),
    variables: z.record(z.string(), z.unknown()).optional().describe("Variables to pass to the template"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/variables", undefined, buildQuery(params));
    return jsonResult(result);
  });

  // ===========================
  // AI ASK
  // ===========================

  server.tool("ai_ask", "Ask the Grinfi AI a question. Can be used for generating content, analyzing data, etc.", {
    question: z.string().describe("The question or prompt for the AI"),
    context: z.record(z.string(), z.unknown()).optional().describe("Additional context for the AI"),
  }, async (params) => {
    const body: Record<string, unknown> = { question: params.question };
    if (params.context) body.context = params.context;
    const result = await grinfiRequest("POST", "/ai/api/ask", body);
    return jsonResult(result);
  });

  // ===========================
  // LLMs
  // ===========================

  server.tool("list_llms", "List all LLM integrations (OpenAI, Anthropic, Google, etc.) configured in your account.", {}, async () => {
    const result = await grinfiRequest("GET", "/ai/api/llms");
    return jsonResult(result);
  });

  server.tool("get_llm", "Get an LLM integration by UUID.", { uuid: z.string().describe("UUID of the LLM integration") }, async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/llms/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_llm", "Create a new LLM integration. Supported providers: openai, google, anthropic, perplexity, deepseek, xai, meta.", {
    name: z.string().describe("Human-readable name"),
    provider: z.enum(["openai", "google", "anthropic", "perplexity", "deepseek", "xai", "meta"]).describe("LLM provider"),
    provider_api_token: z.string().describe("API token for the provider"),
    owner: z.enum(["gs", "customer"]).optional().describe("Who owns this integration (default: customer)"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/llms", params);
    return jsonResult(result);
  });

  server.tool("update_llm", "Update an LLM integration by UUID. Can update name and/or API token.", {
    uuid: z.string().describe("UUID of the LLM to update"),
    name: z.string().optional(), provider_api_token: z.string().optional(),
  }, async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/ai/api/llms/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_llm", "Delete an LLM integration by UUID.", { uuid: z.string().describe("UUID of the LLM to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/ai/api/llms/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("generate_llm_response", "Generate a response using a specific LLM integration. Pass messages and config.", {
    uuid: z.string().describe("UUID of the LLM integration to use"),
    job_type: z.enum(["ai_variable", "ai_template", "ai_agent"]).describe("Purpose of the generation"),
    messages: z.array(z.record(z.string(), z.unknown())).describe("Chat history / messages array"),
    config: z.record(z.string(), z.unknown()).optional().describe("Provider-specific config (model, temperature, max_tokens, etc.)"),
  }, async (params) => {
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
  }, async (params) => {
    const result = await grinfiRequest("POST", "/ai/api/llms/metrics", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("list_llm_logs", "List LLM generation logs with pagination and sorting.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  }, async (params) => {
    const result = await grinfiRequest("GET", "/ai/api/llm-logs", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_llm_log", "Get a specific LLM log entry by UUID.", { uuid: z.string().describe("UUID of the LLM log entry") }, async (params) => {
    const result = await grinfiRequest("GET", `/ai/api/llm-logs/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // CSV IMPORT / EXPORT (file operations)
  // ===========================

  server.tool(
    "upload_csv",
    "Upload a CSV file to Grinfi. Returns a file_import UUID that you then pass to import_leads_from_file or import_companies_from_file. The file_path must be an absolute path on the local machine where the MCP server is running.",
    {
      file_path: z.string().describe("Absolute path to the CSV file on the local machine"),
      filename: z.string().optional().describe("Override the filename sent to Grinfi (defaults to the basename of file_path)"),
    },
    async (params) => {
      const result = await grinfiUpload(
        "/leads/api/file-imports/upload-csv",
        params.file_path,
        "file",
        params.filename,
      );
      return jsonResult(result);
    },
  );

  server.tool(
    "import_leads_from_file",
    "Import contacts (leads) from a previously uploaded CSV. Provide the file_import_uuid from upload_csv along with column mapping and target list/data source.",
    {
      file_import_uuid: z.string().describe("UUID returned by upload_csv"),
      list_uuid: z.string().describe("Target list UUID for imported contacts"),
      column_mapping: z.record(z.string(), z.string()).describe("Map CSV column names to Grinfi field names (e.g. {\"Email\":\"email\",\"Full Name\":\"name\"})"),
      data_source_uuid: z.string().optional().describe("Optional data source to assign to imported contacts"),
      update_if_exists: z.boolean().optional(),
      move_to_list: z.boolean().optional(),
      skip_first_row: z.boolean().optional().describe("Skip header row (default true)"),
    },
    async (params) => {
      const { file_import_uuid, ...rest } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("POST", `/leads/api/file-imports/${file_import_uuid}/import-leads`, body);
      return jsonResult(result);
    },
  );

  server.tool(
    "import_companies_from_file",
    "Import companies from a previously uploaded CSV. Provide the file_import_uuid from upload_csv along with column mapping.",
    {
      file_import_uuid: z.string().describe("UUID returned by upload_csv"),
      column_mapping: z.record(z.string(), z.string()).describe("Map CSV column names to Grinfi company field names"),
      list_uuids: z.array(z.string()).optional().describe("Optional list UUIDs to assign companies to"),
      data_source_uuid: z.string().optional(),
      update_if_exists: z.boolean().optional(),
      skip_first_row: z.boolean().optional(),
    },
    async (params) => {
      const { file_import_uuid, ...rest } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("POST", `/leads/api/file-imports/${file_import_uuid}/import-companies`, body);
      return jsonResult(result);
    },
  );

  server.tool(
    "export_leads_csv",
    "Queue a CSV export of contacts matching a filter. Returns a file_export UUID. Use download_export to fetch the actual file once the export is ready.",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter to select contacts to export"),
      fields: z.array(z.string()).optional().describe("Specific fields to include in the export"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.fields) body.fields = params.fields;
      const result = await grinfiRequest("POST", "/leads/api/file-exports/leads", body);
      return jsonResult(result);
    },
  );

  server.tool(
    "export_companies_csv",
    "Queue a CSV export of companies matching a filter. Returns a file_export UUID. Use download_export to fetch the actual file once the export is ready.",
    {
      filter: z.record(z.string(), z.unknown()).optional(),
      fields: z.array(z.string()).optional(),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.fields) body.fields = params.fields;
      const result = await grinfiRequest("POST", "/leads/api/file-exports/companies", body);
      return jsonResult(result);
    },
  );

  server.tool(
    "download_export",
    "Get the download URL/payload for a previously queued export (from export_leads_csv or export_companies_csv). The export must be ready (job completed).",
    {
      file_export_uuid: z.string().describe("UUID returned by export_leads_csv or export_companies_csv"),
    },
    async (params) => {
      const result = await grinfiRequest("POST", "/leads/api/file-exports/download", { uuid: params.file_export_uuid });
      return jsonResult(result);
    },
  );

  // ===========================
  // LEAD ENRICHMENT & ANALYTICS
  // ===========================

  server.tool(
    "enrich_leads",
    "Trigger advanced LinkedIn enrichment for contacts. Provide either a filter or an array of lead UUIDs. Mirrors enrich_companies but for contacts.",
    {
      uuids: z.array(z.string()).optional().describe("Array of lead UUIDs to enrich"),
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter to select contacts to enrich"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.uuids) body.uuids = params.uuids;
      if (params.filter) body.filter = params.filter;
      const result = await grinfiRequest("PUT", "/leads/api/leads/advanced-enrichment", body);
      return jsonResult(result);
    },
  );

  server.tool(
    "count_leads",
    "Count contacts matching a filter. Useful for analytics or before running mass actions.",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter to count by"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      const result = await grinfiRequest("POST", "/leads/api/leads/count", body);
      return jsonResult(result);
    },
  );

  server.tool(
    "get_leads_metrics",
    "Get team engagement metrics for contacts (counts, engagement, status breakdowns).",
    {
      filter: z.record(z.string(), z.unknown()).optional(),
      metrics: z.array(z.string()).optional().describe("Specific metrics to retrieve"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.metrics) body.metrics = params.metrics;
      const result = await grinfiRequest("POST", "/leads/api/leads/metrics", body);
      return jsonResult(result);
    },
  );

  // ===========================
  // AUTOMATION FOLDERS
  // ===========================

  server.tool("list_automation_folders", "List all automation folders (workspaces) for organizing automations.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/flows/api/flow-workspaces");
    return jsonResult(result);
  });

  server.tool("create_automation_folder", "Create a new automation folder.", {
    name: z.string().describe("Name of the folder"),
    order: z.number().optional().describe("Display order position"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.order !== undefined) body.order = params.order;
    const result = await grinfiRequest("POST", "/flows/api/flow-workspaces", body);
    return jsonResult(result);
  });

  server.tool("update_automation_folder", "Update an automation folder's name or display order.", {
    uuid: z.string().describe("UUID of the automation folder"),
    name: z.string().optional(),
    order: z.number().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/flows/api/flow-workspaces/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_automation_folder", "Delete an automation folder by UUID.", {
    uuid: z.string().describe("UUID of the automation folder to delete"),
  },
    { readOnlyHint: false, destructiveHint: true },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/flows/api/flow-workspaces/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool(
    "list_flow_leads",
    "Search contacts enrolled in automations. Returns which contacts are in which flows, along with status (active, paused, completed, failed).",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter (e.g. by flow_uuid, lead_uuid, status)"),
      limit: z.number().optional(), offset: z.number().optional(),
      order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.filter) body.filter = params.filter;
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.offset !== undefined) body.offset = params.offset;
      if (params.order_field) body.order_field = params.order_field;
      if (params.order_type) body.order_type = params.order_type;
      const result = await grinfiRequest("POST", "/flows/api/flows-leads/list", body);
      return jsonResult(result, true);
    },
  );

  server.tool(
    "delete_flow_lead_history",
    "Delete a contact's automation history (removes them from ALL flows and clears enrollment records). Different from cancel_contact_from_all_automations: this also removes historical records.",
    {
      lead_uuid: z.string().describe("UUID of the contact"),
    },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/flows/api/flows/leads/${params.lead_uuid}`);
      return jsonResult(result);
    },
  );

  // ===========================
  // AI AGENTS / TEMPLATES — CRUD
  // ===========================

  server.tool(
    "create_ai_agent",
    "Create a new AI agent. AI agents are configurable assistants that can be invoked from automations or templates.",
    {
      name: z.string().describe("Agent name"),
      description: z.string().optional(),
      llm_uuid: z.string().optional().describe("UUID of the LLM integration to use"),
      system_prompt: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional().describe("Provider-specific config"),
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("POST", "/ai/api/agents", body);
      return jsonResult(result);
    },
  );

  server.tool(
    "update_ai_agent",
    "Update an AI agent by UUID.",
    {
      uuid: z.string().describe("UUID of the AI agent"),
      name: z.string().optional(),
      description: z.string().optional(),
      llm_uuid: z.string().optional(),
      system_prompt: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/ai/api/agents/${uuid}`, body);
      return jsonResult(result);
    },
  );

  server.tool(
    "delete_ai_agent",
    "Delete an AI agent by UUID.",
    { uuid: z.string().describe("UUID of the AI agent to delete") },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/ai/api/agents/${params.uuid}`);
      return jsonResult(result);
    },
  );

  server.tool(
    "update_ai_template",
    "Update an AI template by UUID. Lets you change name, prompt, body, subject, etc.",
    {
      uuid: z.string().describe("UUID of the AI template"),
      name: z.string().optional(),
      type: z.string().optional(),
      prompt: z.string().optional(),
      body: z.string().optional(),
      subject: z.string().optional(),
      fallback_body: z.string().optional(),
      enable_validation: z.boolean().optional(),
      template_category_uuid: z.string().optional(),
    },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/ai/api/templates/${uuid}`, body);
      return jsonResult(result);
    },
  );

  server.tool(
    "delete_ai_template",
    "Delete an AI template by UUID.",
    { uuid: z.string().describe("UUID of the AI template to delete") },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/ai/api/templates/${params.uuid}`);
      return jsonResult(result);
    },
  );

  // ===========================
  // CLOSURES (gaps in existing CRUD)
  // ===========================

  server.tool(
    "upload_attachment",
    "Upload a file as an attachment. Used for adding documents/images to contacts, automations, or LinkedIn/email messages. The file_path must be an absolute path on the local machine.",
    {
      file_path: z.string().describe("Absolute path to the file on the local machine"),
      filename: z.string().optional().describe("Override the filename (defaults to the basename of file_path)"),
    },
    async (params) => {
      const result = await grinfiUpload(
        "/leads/api/attachments",
        params.file_path,
        "file",
        params.filename,
      );
      return jsonResult(result);
    },
  );

  server.tool(
    "remove_from_leads_blacklist",
    "Remove a contact from the leads blacklist by UUID. Pairs with add_to_leads_blacklist.",
    { uuid: z.string().describe("UUID of the blacklist entry to remove") },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/leads/api/blacklist/leads/${params.uuid}`);
      return jsonResult(result);
    },
  );

  server.tool(
    "remove_from_companies_blacklist",
    "Remove a company from the companies blacklist by UUID. Pairs with add_to_companies_blacklist.",
    { uuid: z.string().describe("UUID of the blacklist entry to remove") },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/leads/api/blacklist/companies/${params.uuid}`);
      return jsonResult(result);
    },
  );

  server.tool(
    "update_custom_field",
    "Update a custom field's name or display order. To set a value on a contact/company, use upsert_custom_field_value instead.",
    {
      uuid: z.string().describe("UUID of the custom field"),
      name: z.string().optional(),
      order: z.number().optional(),
    },
    async (params) => {
      const { uuid, ...fields } = params;
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
      const result = await grinfiRequest("PUT", `/leads/api/custom-fields/${uuid}`, body);
      return jsonResult(result);
    },
  );

  server.tool(
    "delete_custom_field",
    "Delete a custom field by UUID. This will remove the field and all its values from contacts/companies. Irreversible.",
    { uuid: z.string().describe("UUID of the custom field to delete") },
    async (params) => {
      const result = await grinfiRequest("DELETE", `/leads/api/custom-fields/${params.uuid}`);
      return jsonResult(result);
    },
  );

  // ===========================
  // FAILED-TASK TRIAGE — diagnose / restart / skip / restart-from-top
  // ===========================

  server.tool(
    "diagnose_failed_tasks",
    "Diagnose failed/canceled automation tasks across a flow / sender / period. Read-only. Returns failure breakdown by automation_error_code (replied / too_many_attempts / unknown), per-sender counts, sample task records (with first-line error_summary), and free-text pattern hints (captcha/proxy/rate-limit detection). Use BEFORE bulk_retry to confirm there is something retryable and to spot patterns that need a human (proxy down, account banned, etc.). Filter by period (24h/7d/30d), flow_uuid, sender_profile_uuid, status (failed/canceled/both). DOES NOT mutate state.",
    {
      flow_uuid: z.string().optional().describe("Optional flow UUID — scope diagnosis to one automation. Resolve via list_automations."),
      sender_profile_uuid: z.string().optional().describe("Optional sender profile UUID — scope diagnosis to one sender. Resolve via list_sender_profiles."),
      period: z.enum(["24h", "7d", "30d"]).optional().describe("Lookback window (default '24h'). Filters tasks by schedule_at >= now - period."),
      limit: z.number().int().min(1).max(200).optional().describe("Max sample tasks to fetch for pattern hints + samples block (default 100, cap 200)."),
      status: z.enum(["failed", "canceled", "both"]).optional().describe("Status of tasks to diagnose. 'failed' (default), 'canceled' (where 'replied' code typically appears), 'both' for combined view."),
      verbose: z.boolean().optional().describe("If true, return full error_msg per sample (no truncation). Default false — error_msg trimmed to 500 chars; error_summary always provided as first-line digest."),
      include_internal: z.boolean().optional().describe("If true, include internal task types (util_timer, trigger_*) in samples / by_sender / pattern_hints. Default false — internal types are noise that mask real outreach failures."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const periodMs: Record<"24h" | "7d" | "30d", number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
      };
      const period = params.period ?? "24h";
      const since = new Date(Date.now() - periodMs[period]).toISOString();
      const sampleLimit = params.limit ?? 100;
      const verbose = params.verbose ?? false;
      const includeInternal = params.include_internal ?? false;

      const status = params.status ?? "failed";
      const statusFilter: unknown = status === "both" ? ["failed", "canceled"] : status;

      const filter: Record<string, unknown> = {
        status: statusFilter,
        schedule_at: { ">=": since },
      };
      if (params.flow_uuid) filter.flow_uuid = params.flow_uuid;
      if (params.sender_profile_uuid) filter.sender_profile_uuid = params.sender_profile_uuid;

      const internalTypes = ["util_timer", "trigger_message_replied", "trigger_completed", "trigger_paused"];
      if (!includeInternal) {
        filter.type = { "!=": internalTypes };
      }

      const [byErrorCode, bySender, samplesResult] = await Promise.all([
        grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: "automation_error_code" }),
        grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: "sender_profile_uuid" }),
        grinfiRequest("POST", "/flows/api/tasks/list", { filter, limit: sampleLimit, order_field: "schedule_at", order_type: "desc" }),
      ]);

      function toCountArr(payload: unknown): { value: string; count: number }[] {
        if (payload && typeof payload === "object") {
          const obj = payload as Record<string, unknown>;
          const dataField = obj.data;
          if (Array.isArray(dataField)) return dataField as { value: string; count: number }[];
          const arr: { value: string; count: number }[] = [];
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "number") {
              arr.push({ value: k === "" ? "unclassified" : k, count: v });
            }
          }
          return arr;
        }
        return [];
      }

      const byErrCodeArr = toCountArr(byErrorCode);
      const bySenderArr = toCountArr(bySender);

      const senderUuids = bySenderArr.map((b) => b.value).filter((u): u is string => typeof u === "string" && u.length > 0 && u !== "unclassified");
      const senderNames: Record<string, string> = {};
      await Promise.all(
        senderUuids.map(async (uuid) => {
          try {
            const r = await grinfiRequest("GET", `/flows/api/sender-profiles/${uuid}`) as { name?: string; email?: string };
            senderNames[uuid] = r.name ?? r.email ?? uuid;
          } catch {
            senderNames[uuid] = uuid;
          }
        }),
      );

      const samplesArr = Array.isArray((samplesResult as { data?: unknown }).data)
        ? ((samplesResult as { data: Record<string, unknown>[] }).data)
        : [];
      const flowUuids = Array.from(new Set(samplesArr.map((s) => s.flow_uuid as string).filter((u): u is string => typeof u === "string" && u.length > 0)));
      const flowNames: Record<string, string> = {};
      await Promise.all(
        flowUuids.map(async (uuid) => {
          try {
            const r = await grinfiRequest("GET", `/flows/api/flows/${uuid}`) as { name?: string };
            flowNames[uuid] = r.name ?? uuid;
          } catch {
            flowNames[uuid] = uuid;
          }
        }),
      );

      function firstLine(s: string): string {
        const i = s.indexOf("\n");
        return i === -1 ? s : s.slice(0, i);
      }

      const samples = samplesArr.map((t) => {
        const errorMsgRaw = typeof t.error_msg === "string" ? t.error_msg : "";
        const errorSummary = errorMsgRaw ? firstLine(errorMsgRaw).slice(0, 200) : "";
        const errorMsg = verbose ? errorMsgRaw : (errorMsgRaw.length > 500 ? errorMsgRaw.slice(0, 500) + "…" : errorMsgRaw);
        const senderUuid = t.sender_profile_uuid as string | undefined;
        const flowUuid = t.flow_uuid as string | undefined;
        return {
          uuid: t.uuid,
          type: t.type,
          status: t.status,
          automation_error_code: t.automation_error_code ?? null,
          schedule_at: t.schedule_at,
          flow_uuid: flowUuid,
          flow_name: flowUuid ? flowNames[flowUuid] : undefined,
          sender_profile_uuid: senderUuid,
          sender_name: senderUuid ? senderNames[senderUuid] : undefined,
          lead_uuid: t.lead_uuid,
          attempts: t.attempts,
          error_summary: errorSummary,
          error_msg: errorMsg,
        };
      });

      const patternHints: string[] = [];
      const allErrors = samples.map((s) => (s.error_msg ?? "").toLowerCase()).join(" ");
      if (/captcha|recaptcha|verify\s+you/.test(allErrors)) {
        patternHints.push("CAPTCHA detected — at least one sender hit a LinkedIn challenge. Manual cookie refresh likely needed.");
      }
      if (/proxy|connection\s+refused|connect\s+timeout|connect\s+to\s+server|couldn'?t\s+connect|failed\s+to\s+connect|enotfound|econnrefused|etimedout|curl\s+error\s+7|curl\s+error\s+28/.test(allErrors)) {
        patternHints.push("Proxy/network connectivity issues detected (cURL connect errors, refused connections). Check sender proxy via diagnose_linkedin_browser or replace_proxy.");
      }
      if (/rate\s*limit|429|too\s+many\s+requests/.test(allErrors)) {
        patternHints.push("Rate-limit signals detected — back off, reduce daily caps, or wait for cooldown before retry.");
      }
      if (/banned|suspended|account\s+restricted|account\s+is\s+disabled/.test(allErrors)) {
        patternHints.push("Account ban/suspension detected — DO NOT retry. Investigate sender account state manually.");
      }
      if (/unauthorized|401|cookie\s+expired|session\s+expired|jwt.*expired/.test(allErrors)) {
        patternHints.push("Auth/cookie issues detected — sender's LinkedIn session likely expired. Refresh cookies via cloud browser.");
      }
      if (/timeout\b|timed\s*out/.test(allErrors)) {
        patternHints.push("Timeout errors detected — backend or LinkedIn response slow. Could be transient (safe to retry) or proxy slowness (investigate).");
      }
      if (byErrCodeArr.find((b) => b.value === "replied" && b.count > 0)) {
        patternHints.push("Some tasks have automation_error_code='replied' — these are leads that responded. NEVER retry replied tasks. The bulk_retry tool already excludes them.");
      }
      if (byErrCodeArr.find((b) => b.value === "unclassified" && b.count > 0)) {
        patternHints.push("Some failures are unclassified by backend (null automation_error_code). The error_msg samples below may reveal patterns. Use include_unclassified=true with restart_failed_tasks to retry these.");
      }

      const bySenderEnriched = bySenderArr.map((b) => ({
        sender_profile_uuid: b.value,
        sender_name: senderNames[b.value] ?? b.value,
        count: b.count,
      }));

      return jsonResult({
        period,
        status,
        scope: {
          flow_uuid: params.flow_uuid ?? null,
          sender_profile_uuid: params.sender_profile_uuid ?? null,
          since,
          include_internal: includeInternal,
        },
        by_error_code: byErrCodeArr,
        by_sender: bySenderEnriched,
        samples,
        pattern_hints: patternHints,
        samples_count: samples.length,
      });
    },
  );

  // Shared filter builder for restart/skip/restart-from-top
  function buildTaskTriageFilter(p: {
    flow_uuid?: string;
    sender_profile_uuid?: string;
    period?: "24h" | "7d" | "30d";
    automation_error_code?: string;
    include_unclassified?: boolean;
    task_uuids?: string[];
  }): Record<string, unknown> {
    const periodMs: Record<string, number> = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };
    const period = p.period ?? "24h";
    const since = new Date(Date.now() - periodMs[period]).toISOString();
    const filter: Record<string, unknown> = {
      status: "failed",
      schedule_at: { ">=": since },
    };
    if (p.flow_uuid) filter.flow_uuid = p.flow_uuid;
    if (p.sender_profile_uuid) filter.sender_profile_uuid = p.sender_profile_uuid;
    if (p.automation_error_code) {
      filter.automation_error_code = p.automation_error_code;
    } else if (!(p.include_unclassified ?? false)) {
      filter.automation_error_code = ["too_many_attempts", "unknown"];
    }
    if (p.task_uuids && p.task_uuids.length > 0) {
      filter.id = p.task_uuids;
    }
    return filter;
  }

  server.tool(
    "restart_failed_tasks",
    "Bulk-retry failed automation tasks using a filter (or explicit task UUIDs). Re-queues matching tasks to run again from where they failed; status: failed → restarted → in_progress. Hard-coded skip: 'replied' (lead has responded — never retry). Use diagnose_failed_tasks FIRST to confirm there's something retryable. Pass dry_run:true to preview matched_count without mutation. include_unclassified:true catches NULL automation_error_code (workaround for backend classifier gap).",
    {
      flow_uuid: z.string().optional().describe("Scope to one automation"),
      sender_profile_uuid: z.string().optional().describe("Scope to one sender"),
      period: z.enum(["24h", "7d", "30d"]).optional().describe("Lookback window (default 24h)"),
      automation_error_code: z.enum(["too_many_attempts", "unknown", "replied"]).optional().describe("Filter to specific error code"),
      include_unclassified: z.boolean().optional().describe("If true, catch tasks with NULL automation_error_code. Workaround for backend gap. Safe — status:'failed' alone never includes 'replied' tasks (those are canceled). Default false."),
      task_uuids: z.array(z.string()).optional().describe("Explicit task UUIDs to retry. Overrides filter."),
      dry_run: z.boolean().optional().describe("If true, only count what would be retried — no mutation."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      const filter = buildTaskTriageFilter(params);

      if (params.dry_run) {
        try {
          const counts = await grinfiRequest("POST", "/flows/api/tasks/group-counts", {
            filter,
            group_field: "type",
          }) as Record<string, unknown>;
          let total = 0;
          for (const v of Object.values(counts)) {
            if (typeof v === "number") total += v;
          }
          return jsonResult({
            dry_run: true,
            matched_count: total,
            filter,
            note: "No mutation performed. Run without dry_run to actually retry.",
          });
        } catch (err) {
          return jsonResult({
            dry_run: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-retry", { filter });
      return jsonResult({ result, filter });
    },
  );

  server.tool(
    "skip_failed_tasks",
    "Bulk-skip failed automation tasks: lead PROGRESSES to next node without re-executing the failed step (status: failed → skipped). Use when failure isn't worth retrying (data quality issue, optional webhook node, etc.) and you just want the lead to continue. UI equivalent: 'Skip' button on failed-task modal. ⚠ STATE MUTATION — leads progress through their flow. Pair with diagnose_failed_tasks first; pass dry_run:true to preview.",
    {
      flow_uuid: z.string().optional(),
      sender_profile_uuid: z.string().optional(),
      period: z.enum(["24h", "7d", "30d"]).optional(),
      automation_error_code: z.enum(["too_many_attempts", "unknown", "replied"]).optional(),
      include_unclassified: z.boolean().optional(),
      task_uuids: z.array(z.string()).optional().describe("Explicit task UUIDs to skip"),
      dry_run: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
      const filter = buildTaskTriageFilter(params);
      if (params.dry_run) {
        try {
          const counts = await grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: "type" }) as Record<string, unknown>;
          let total = 0;
          for (const v of Object.values(counts)) if (typeof v === "number") total += v;
          return jsonResult({ dry_run: true, matched_count: total, filter, note: "No mutation. Run without dry_run to actually skip." });
        } catch (err) {
          return jsonResult({ dry_run: true, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-skip", { filter });
      return jsonResult({ result, filter });
    },
  );

  server.tool(
    "restart_failed_tasks_from_top",
    "Re-enrol matched leads from the START of a flow (node 1), bypassing the failed task position. Optionally swap to a different sender via new_sender_profile_uuid. UI equivalent: 'Restart from top' on failed-task modal. ⚠ MAJOR STATE MUTATION — leads will receive initial flow messages again (including connection requests/initial emails). Treat as fresh enrolment. ALWAYS use dry_run:true first; ALWAYS confirm with user before running for-real.",
    {
      flow_uuid: z.string().describe("Flow UUID to restart leads in (REQUIRED)"),
      sender_profile_uuid: z.string().optional().describe("Optional: scope to leads currently on this sender"),
      period: z.enum(["24h", "7d", "30d"]).optional(),
      automation_error_code: z.enum(["too_many_attempts", "unknown", "replied"]).optional(),
      include_unclassified: z.boolean().optional(),
      new_sender_profile_uuid: z.string().optional().describe("If provided, leads restart on this sender instead of their original."),
      dry_run: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params) => {
      const filter = buildTaskTriageFilter({
        flow_uuid: params.flow_uuid,
        sender_profile_uuid: params.sender_profile_uuid,
        period: params.period,
        automation_error_code: params.automation_error_code,
        include_unclassified: params.include_unclassified,
      });
      if (params.dry_run) {
        try {
          const counts = await grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: "type" }) as Record<string, unknown>;
          let total = 0;
          for (const v of Object.values(counts)) if (typeof v === "number") total += v;
          return jsonResult({
            dry_run: true,
            matched_count: total,
            filter,
            warning: "Each matched lead will receive initial flow messages AGAIN. Treat as fresh enrolment.",
          });
        } catch (err) {
          return jsonResult({ dry_run: true, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const body: Record<string, unknown> = {
        filter,
        flow_uuid: params.flow_uuid,
        flow_origin: "automation",
        new_contact_source_id: 1,
      };
      if (params.new_sender_profile_uuid) body.sender_profile_uuid = params.new_sender_profile_uuid;
      const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-restart-from-top", body);
      return jsonResult({ result, body });
    },
  );

  // ===========================
  // WORKSPACE HEALTH CHECK & DASHBOARD
  // ===========================

  server.tool(
    "workspace_health_check",
    "Single-call workspace dashboard — operational overview in one tool call. Returns 6 sections: 1) today (sends/replies counts per type), 2) yesterday (same shape), 3) linkedin_health (browser fleet status, cookies, daily caps), 4) email_health (mailboxes status + errors), 5) active_flows (running automations with in-progress task counts), 6) failed_tasks (failed counts today/yesterday/7d by task type). All sections fetched in parallel for speed. Pass dry_run:true to drop detail rows and only return aggregated counters.",
    {
      dry_run: z.boolean().optional().describe("If true, return only summary counters (no per-browser/per-mailbox/per-flow detail rows)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const dry = params.dry_run ?? false;
      const now = Date.now();
      const todayStart = new Date(now);
      todayStart.setUTCHours(0, 0, 0, 0);
      const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

      const todayIso = todayStart.toISOString();
      const yesterdayIso = yesterdayStart.toISOString();
      const sevenDaysAgoIso = sevenDaysAgo.toISOString();

      const internalTypes = ["util_timer", "trigger_message_replied", "trigger_completed", "trigger_paused"];

      async function fetchCounts(filter: Record<string, unknown>, groupField: string): Promise<{ value: string; count: number }[]> {
        try {
          const res = await grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: groupField }) as Record<string, unknown>;
          const arr: { value: string; count: number }[] = [];
          for (const [k, v] of Object.entries(res)) {
            if (typeof v === "number") arr.push({ value: k === "" ? "(unset)" : k, count: v });
          }
          if (arr.length === 0 && Array.isArray(res.data)) {
            return (res.data as { value: string; count: number }[]);
          }
          return arr;
        } catch {
          return [];
        }
      }

      const [
        todayCompletedByType,
        yesterdayCompletedByType,
        browsersResult,
        mailboxesResult,
        flowsResult,
        failedToday,
        failedYesterday,
        failed7d,
      ] = await Promise.all([
        fetchCounts({
          status: "closed",
          schedule_at: { ">=": todayIso },
          type: { "!=": internalTypes },
        }, "type"),
        fetchCounts({
          status: "closed",
          schedule_at: { ">=": yesterdayIso, "<": todayIso },
          type: { "!=": internalTypes },
        }, "type"),
        grinfiRequest("POST", "/browsers/api/linkedin-browsers/list", { limit: 100, offset: 0 }).catch(() => ({ data: [] })),
        grinfiRequest("GET", "/emails/api/mailboxes", undefined, { limit: "100" }).catch(() => ({ data: [] })),
        grinfiRequest("POST", "/flows/api/flows/list", { limit: 100, offset: 0, filter: { status: "in_progress" } }).catch(() => ({ data: [] })),
        fetchCounts({
          status: "failed",
          schedule_at: { ">=": todayIso },
          type: { "!=": internalTypes },
        }, "type"),
        fetchCounts({
          status: "failed",
          schedule_at: { ">=": yesterdayIso, "<": todayIso },
          type: { "!=": internalTypes },
        }, "type"),
        fetchCounts({
          status: "failed",
          schedule_at: { ">=": sevenDaysAgoIso },
          type: { "!=": internalTypes },
        }, "type"),
      ]);

      function aggregateActivity(byType: { value: string; count: number }[]): Record<string, number> {
        const agg: Record<string, number> = {
          messages_sent: 0,
          connect_requests_sent: 0,
          inmails_sent: 0,
          emails_sent: 0,
          tasks_completed_total: 0,
        };
        for (const e of byType) {
          agg.tasks_completed_total += e.count;
          if (e.value === "linkedin_send_message") agg.messages_sent += e.count;
          else if (e.value === "linkedin_send_connection_request") agg.connect_requests_sent += e.count;
          else if (e.value === "linkedin_send_inmail") agg.inmails_sent += e.count;
          else if (e.value === "gs_send_email") agg.emails_sent += e.count;
        }
        return agg;
      }

      const today = aggregateActivity(todayCompletedByType);
      const yesterday = aggregateActivity(yesterdayCompletedByType);

      const browsers = Array.isArray((browsersResult as { data?: unknown }).data) ? (browsersResult as { data: Record<string, unknown>[] }).data : [];
      const linkedinHealth = {
        total_browsers: browsers.length,
        active: browsers.filter((b) => b.status === "active").length,
        paused: browsers.filter((b) => b.status === "paused").length,
        banned: browsers.filter((b) => b.status === "banned").length,
        cookie_expired: browsers.filter((b) => b.cookie_status === "expired" || b.cookie_status === "invalid").length,
        capacity_remaining: browsers.reduce((sum, b) => sum + Math.max(0, ((b.daily_limit as number) ?? 0) - ((b.usage_today as number) ?? 0)), 0),
        details: dry ? null : browsers.map((b) => ({
          id: b.id,
          name: b.name ?? b.email ?? null,
          status: b.status,
          cookie_status: b.cookie_status,
          health_score: b.health_score,
          remaining_today: Math.max(0, ((b.daily_limit as number) ?? 0) - ((b.usage_today as number) ?? 0)),
        })),
      };

      const mailboxes = Array.isArray((mailboxesResult as { data?: unknown }).data) ? (mailboxesResult as { data: Record<string, unknown>[] }).data : [];
      const emailHealth = {
        total_mailboxes: mailboxes.length,
        active: mailboxes.filter((m) => m.send_status === "active").length,
        sync_errors: mailboxes.filter((m) => ((m.sync_errors_count as number) ?? 0) > 0).length,
        send_errors: mailboxes.filter((m) => ((m.send_errors_count as number) ?? 0) > 0).length,
        details: dry ? null : mailboxes.map((m) => ({
          uuid: m.uuid,
          email: m.email,
          send_status: m.send_status,
          sync_status: m.sync_status,
          send_errors_count: m.send_errors_count,
          sync_errors_count: m.sync_errors_count,
          last_send_at: m.last_send_at,
        })),
      };

      const flows = Array.isArray((flowsResult as { data?: unknown }).data) ? (flowsResult as { data: Record<string, unknown>[] }).data : [];
      const activeFlows = {
        total: flows.length,
        details: dry ? null : flows.map((f) => ({
          uuid: f.uuid,
          name: f.name,
          status: f.status,
          created_at: f.created_at,
        })),
      };

      const failedSummary = {
        today_total: failedToday.reduce((s, e) => s + e.count, 0),
        yesterday_total: failedYesterday.reduce((s, e) => s + e.count, 0),
        last_7d_total: failed7d.reduce((s, e) => s + e.count, 0),
        last_7d_by_type: dry ? null : failed7d.sort((a, b) => b.count - a.count).slice(0, 10),
      };

      return jsonResult({
        timestamp: new Date().toISOString(),
        today,
        yesterday,
        linkedin_health: linkedinHealth,
        email_health: emailHealth,
        active_flows: activeFlows,
        failed_tasks: failedSummary,
      });
    },
  );

  server.tool(
    "get_dashboard",
    "Fetch a CRM analytics widget (composite from existing metrics endpoints). Supported widget_type values: activities_over_time (sends/replies per day or week), conversion_funnel (lead counts per pipeline stage), pipeline_distribution (same as funnel but as percentages), sender_performance (per-sender event totals), response_rate (replies / sent ratio per sender or overall). Use for dashboard/report/summary questions. Use search_contacts for row-level data.",
    {
      widget_type: z.enum(["activities_over_time", "pipeline_distribution", "conversion_funnel", "sender_performance", "response_rate"]).describe("Widget type"),
      period_from: z.string().optional().describe("Start date ISO (default: 30 days ago)"),
      period_to: z.string().optional().describe("End date ISO (default: now)"),
      flow_uuids: z.array(z.string()).optional().describe("Filter by flows"),
      sender_profile_uuids: z.array(z.string()).optional().describe("Filter by senders"),
      granularity: z.enum(["day", "week", "month"]).optional().describe("Time granularity (for activities_over_time). Default: day"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const periodTo = params.period_to ?? new Date().toISOString();
      const periodFrom = params.period_from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const baseFilter: Record<string, unknown> = {
        schedule_at: { ">=": periodFrom, "<=": periodTo },
      };
      if (params.flow_uuids && params.flow_uuids.length > 0) baseFilter.flow_uuid = params.flow_uuids;
      if (params.sender_profile_uuids && params.sender_profile_uuids.length > 0) baseFilter.sender_profile_uuid = params.sender_profile_uuids;

      const internalTypes = ["util_timer", "trigger_message_replied", "trigger_completed", "trigger_paused"];
      baseFilter.type = { "!=": internalTypes };

      async function fetchCounts(filter: Record<string, unknown>, groupField: string): Promise<{ value: string; count: number }[]> {
        try {
          const res = await grinfiRequest("POST", "/flows/api/tasks/group-counts", { filter, group_field: groupField }) as Record<string, unknown>;
          const arr: { value: string; count: number }[] = [];
          for (const [k, v] of Object.entries(res)) {
            if (typeof v === "number") arr.push({ value: k === "" ? "(unset)" : k, count: v });
          }
          return arr;
        } catch {
          return [];
        }
      }

      switch (params.widget_type) {
        case "activities_over_time": {
          const granularity = params.granularity ?? "day";
          const filter = { ...baseFilter, status: "closed" };
          const buckets = await fetchCounts(filter, granularity);
          const sortedBuckets = buckets.sort((a, b) => a.value.localeCompare(b.value));
          return jsonResult({
            widget: "activities_over_time",
            period_from: periodFrom,
            period_to: periodTo,
            granularity,
            total: sortedBuckets.reduce((s, b) => s + b.count, 0),
            series: sortedBuckets.map((b) => ({ date: b.value, count: b.count })),
          });
        }

        case "pipeline_distribution":
        case "conversion_funnel": {
          const stages = await grinfiRequest("GET", "/leads/api/pipeline-stages") as { data?: Record<string, unknown>[] };
          const stageList = Array.isArray(stages.data) ? stages.data : [];
          const leadStages = stageList.filter((s) => s.object_type === "lead").sort((a, b) => ((a.order as number) ?? 0) - ((b.order as number) ?? 0));

          const counts = await Promise.all(
            leadStages.map(async (stage) => {
              try {
                const r = await grinfiRequest("POST", "/leads/api/leads/count", { filter: { pipeline_stage_uuid: stage.uuid } }) as Record<string, unknown>;
                const count = (r.count as number | undefined) ?? (r.total as number | undefined) ?? 0;
                return { stage_uuid: stage.uuid as string, name: stage.name as string, category: stage.category as string, order: stage.order as number, count };
              } catch {
                return { stage_uuid: stage.uuid as string, name: stage.name as string, category: stage.category as string, order: stage.order as number, count: 0 };
              }
            }),
          );

          const total = counts.reduce((s, c) => s + c.count, 0);

          if (params.widget_type === "pipeline_distribution") {
            return jsonResult({
              widget: "pipeline_distribution",
              total,
              stages: counts.map((c) => ({
                ...c,
                pct: total > 0 ? Math.round((c.count / total) * 1000) / 10 : 0,
              })),
            });
          } else {
            const stagesWithConv = counts.map((c, i) => {
              const prev = i > 0 ? counts[i - 1].count : 0;
              const conversionPctFromPrev = i > 0 && prev > 0 ? Math.round((c.count / prev) * 1000) / 10 : null;
              return { ...c, conversion_pct_from_prev: conversionPctFromPrev };
            });
            return jsonResult({
              widget: "conversion_funnel",
              total_leads: total,
              stages: stagesWithConv,
            });
          }
        }

        case "sender_performance": {
          const filter = { ...baseFilter, status: "closed" };
          const bySender = await fetchCounts(filter, "sender_profile_uuid");
          const senderInfo: Record<string, string> = {};
          await Promise.all(
            bySender.map(async (s) => {
              try {
                const r = await grinfiRequest("GET", `/flows/api/sender-profiles/${s.value}`) as { name?: string; email?: string };
                senderInfo[s.value] = r.name ?? r.email ?? s.value;
              } catch {
                senderInfo[s.value] = s.value;
              }
            }),
          );
          const sorted = bySender.sort((a, b) => b.count - a.count);
          const total = sorted.reduce((s, e) => s + e.count, 0);
          return jsonResult({
            widget: "sender_performance",
            period_from: periodFrom,
            period_to: periodTo,
            total,
            senders: sorted.map((s) => ({
              sender_profile_uuid: s.value,
              sender_name: senderInfo[s.value] ?? s.value,
              count: s.count,
              pct: total > 0 ? Math.round((s.count / total) * 1000) / 10 : 0,
            })),
          });
        }

        case "response_rate": {
          const sentFilter = {
            ...baseFilter,
            status: "closed",
            type: ["linkedin_send_message", "linkedin_send_connection_request", "linkedin_send_inmail", "gs_send_email"],
          };
          const repliedFilter = {
            ...baseFilter,
            status: "canceled",
            automation_error_code: "replied",
          };
          const [sentBySender, repliedBySender] = await Promise.all([
            fetchCounts(sentFilter, "sender_profile_uuid"),
            fetchCounts(repliedFilter, "sender_profile_uuid"),
          ]);
          const sentMap = new Map(sentBySender.map((s) => [s.value, s.count]));
          const repliedMap = new Map(repliedBySender.map((s) => [s.value, s.count]));
          const allSenders = Array.from(new Set([...sentMap.keys(), ...repliedMap.keys()]));

          const senderInfo: Record<string, string> = {};
          await Promise.all(
            allSenders.map(async (uuid) => {
              try {
                const r = await grinfiRequest("GET", `/flows/api/sender-profiles/${uuid}`) as { name?: string; email?: string };
                senderInfo[uuid] = r.name ?? r.email ?? uuid;
              } catch {
                senderInfo[uuid] = uuid;
              }
            }),
          );

          const senders = allSenders.map((uuid) => {
            const sent = sentMap.get(uuid) ?? 0;
            const replied = repliedMap.get(uuid) ?? 0;
            const rate = sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0;
            return { sender_profile_uuid: uuid, sender_name: senderInfo[uuid] ?? uuid, sent, replied, response_rate_pct: rate };
          }).sort((a, b) => b.response_rate_pct - a.response_rate_pct);

          const totalSent = senders.reduce((s, e) => s + e.sent, 0);
          const totalReplied = senders.reduce((s, e) => s + e.replied, 0);
          return jsonResult({
            widget: "response_rate",
            period_from: periodFrom,
            period_to: periodTo,
            overall: {
              sent: totalSent,
              replied: totalReplied,
              response_rate_pct: totalSent > 0 ? Math.round((totalReplied / totalSent) * 1000) / 10 : 0,
            },
            by_sender: senders,
          });
        }

        default: {
          return jsonResult({ error: `Unknown widget_type: ${params.widget_type}` });
        }
      }
    },
  );

  server.tool(
    "send_volume_report",
    "Count outreach EVENTS (tasks) over a period with flexible group_by. Use cases: 'how many messages sent last week?', 'connect requests per sender', 'sends per day per flow'. DIFFERS from workspace_health_check (which is operational today/yesterday): this is period-aware reporting with group_by flexibility. When group_by='type', task type names are remapped to user-friendly form (linkedin_send_message → messages_sent, linkedin_send_connection_request → connect_requests_sent, gs_send_email → emails_sent). Internal types (util_timer, trigger_*) excluded by default. Each entry includes pct_of_total.",
    {
      period: z.enum(["24h", "7d", "30d", "90d"]).optional().describe("Lookback window (default '7d')"),
      group_by: z.enum(["type", "status", "flow_uuid", "sender_profile_uuid", "mailbox_uuid", "day", "week"]).optional().describe("Grouping field (default 'type')"),
      flow_uuid: z.string().optional().describe("Optional: scope to one automation"),
      sender_profile_uuid: z.string().optional().describe("Optional: scope to one sender"),
      include_internal: z.boolean().optional().describe("Include util_timer/trigger_* task types (default false)"),
      status: z.enum(["closed", "failed", "canceled", "in_progress", "all"]).optional().describe("Task status filter (default 'closed' = completed events)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const periodMs: Record<string, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
        "90d": 90 * 24 * 60 * 60 * 1000,
      };
      const period = params.period ?? "7d";
      const since = new Date(Date.now() - periodMs[period]).toISOString();
      const groupBy = params.group_by ?? "type";

      const filter: Record<string, unknown> = {
        schedule_at: { ">=": since },
      };
      if (params.status && params.status !== "all") {
        filter.status = params.status;
      } else if (!params.status) {
        filter.status = "closed";
      }
      if (params.flow_uuid) filter.flow_uuid = params.flow_uuid;
      if (params.sender_profile_uuid) filter.sender_profile_uuid = params.sender_profile_uuid;

      const internalTypes = ["util_timer", "trigger_message_replied", "trigger_completed", "trigger_paused"];
      if (!(params.include_internal ?? false)) {
        filter.type = { "!=": internalTypes };
      }

      const groupCounts = await grinfiRequest("POST", "/flows/api/tasks/group-counts", {
        filter,
        group_field: groupBy,
      }) as Record<string, unknown>;

      const entries: { value: string; count: number }[] = [];
      for (const [k, v] of Object.entries(groupCounts)) {
        if (typeof v === "number") {
          entries.push({ value: k === "" ? "(unset)" : k, count: v });
        }
      }
      if (entries.length === 0 && Array.isArray((groupCounts as { data?: unknown }).data)) {
        const arr = (groupCounts as { data: { value: string; count: number }[] }).data;
        entries.push(...arr);
      }

      const total = entries.reduce((sum, e) => sum + e.count, 0);

      const typeFriendlyNames: Record<string, string> = {
        linkedin_send_message: "messages_sent",
        linkedin_send_connection_request: "connect_requests_sent",
        linkedin_send_inmail: "inmails_sent",
        linkedin_view_profile: "profile_views",
        linkedin_send_post_engagement: "post_engagements",
        gs_send_email: "emails_sent",
        gs_add_tag: "tags_assigned",
        gs_remove_tag: "tags_removed",
        gs_change_pipeline_stage: "pipeline_stage_changes",
        gs_add_to_list: "list_additions",
        gs_run_ai_agent: "ai_agent_runs",
        gs_phone_call: "phone_calls",
        gs_custom_action: "custom_actions",
      };

      const enriched = entries
        .sort((a, b) => b.count - a.count)
        .map((e) => {
          const friendlyKey = groupBy === "type" ? (typeFriendlyNames[e.value] ?? e.value) : e.value;
          return {
            key: friendlyKey,
            raw_key: e.value,
            count: e.count,
            pct_of_total: total > 0 ? Math.round((e.count / total) * 1000) / 10 : 0,
          };
        });

      return jsonResult({
        period,
        since,
        group_by: groupBy,
        scope: {
          flow_uuid: params.flow_uuid ?? null,
          sender_profile_uuid: params.sender_profile_uuid ?? null,
          status: filter.status,
          include_internal: params.include_internal ?? false,
        },
        total,
        groups: enriched,
      });
    },
  );

  server.tool(
    "diagnose_mailbox",
    "Run a deep health diagnosis on a single mailbox by UUID. Returns send/sync status, connection settings (host:port masked-password), proxy info, error counts, last activity timestamps, automation daily_limit + interval, plus a list of detected issues (send_status=error, sync_errors over threshold, no activity for 24h+, etc.) and recommendations. Use to investigate why a mailbox is failing; for the listing of all mailboxes use list_mailboxes, for raw error list use list_mailbox_errors.",
    {
      uuid: z.string().describe("UUID of the mailbox to diagnose"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const mailbox = await grinfiRequest("GET", `/emails/api/mailboxes/${params.uuid}`) as Record<string, unknown>;
      const cs = mailbox.connection_settings as Record<string, Record<string, unknown>> | undefined;
      const masked = cs ? {
        send: cs.send ? { ...cs.send, password: cs.send.password ? "***MASKED***" : null } : null,
        sync: cs.sync ? { ...cs.sync, password: cs.sync.password ? "***MASKED***" : null } : null,
      } : null;
      const proxy = mailbox.proxy_settings as Record<string, unknown> | null | undefined;
      const maskedProxy = proxy ? { ...proxy, password: proxy.password ? "***MASKED***" : null } : null;

      const sendStatus = mailbox.send_status as string;
      const syncStatus = mailbox.sync_status as string;
      const sendErrors = (mailbox.send_errors_count as number | undefined) ?? 0;
      const syncErrors = (mailbox.sync_errors_count as number | undefined) ?? 0;
      const lastSendAt = mailbox.last_send_at as string | null | undefined;
      const lastSyncAt = mailbox.last_sync_at as string | null | undefined;

      const issues: string[] = [];
      const recommendations: string[] = [];

      if (sendStatus !== "active") {
        issues.push(`send_status is '${sendStatus}' (expected 'active')`);
        recommendations.push("Use update_mailbox to fix or activate_mailbox to re-enable.");
      }
      if (syncStatus !== "active") {
        issues.push(`sync_status is '${syncStatus}' (expected 'active')`);
      }
      if (sendErrors > 5) {
        issues.push(`${sendErrors} send errors accumulated`);
        recommendations.push("Check list_mailbox_errors for the actual error messages. Common causes: SMTP auth failure, rate limit, blacklisted IP.");
      }
      if (syncErrors > 5) {
        issues.push(`${syncErrors} sync errors accumulated`);
        recommendations.push("IMAP sync issues — verify credentials, check 'Less secure apps' for Gmail, or app password for 2FA accounts.");
      }
      if (lastSendAt) {
        const lastSendMs = new Date(lastSendAt).getTime();
        const hoursSince = (Date.now() - lastSendMs) / (1000 * 60 * 60);
        if (hoursSince > 24) {
          issues.push(`No send activity for ${Math.round(hoursSince)}h (last send: ${lastSendAt})`);
        }
      } else {
        issues.push("Mailbox has never sent any email (last_send_at is null)");
      }
      if (!lastSyncAt) {
        issues.push("Mailbox has never synced (last_sync_at is null) — likely connection problem on initial setup");
      }
      if (issues.length === 0) {
        issues.push("No issues detected. Mailbox appears healthy.");
      }

      return jsonResult({
        uuid: mailbox.uuid,
        email: mailbox.email,
        provider: mailbox.provider,
        sender_name: mailbox.sender_name,
        send_status: sendStatus,
        sync_status: syncStatus,
        send_errors_count: sendErrors,
        sync_errors_count: syncErrors,
        last_send_at: lastSendAt,
        last_sync_at: lastSyncAt,
        automation_daily_limit: mailbox.automation_daily_limit,
        automation_task_interval: mailbox.automation_task_interval,
        connection_settings: masked,
        proxy_settings: maskedProxy,
        sender_profile_uuid: mailbox.sender_profile_uuid,
        team_id: mailbox.team_id,
        issues,
        recommendations,
        is_healthy: sendStatus === "active" && syncStatus === "active" && sendErrors <= 5 && syncErrors <= 5,
      });
    },
  );

  server.tool(
    "get_health_snapshots",
    "Fleet-wide health snapshot of all LinkedIn sending accounts in one call. Returns each browser with status (active/paused/banned/etc.), cookie_status (valid/expired), health_score, daily_limit + usage today, last_run_at, proxy info. Use for morning triage or fleet overview without making N separate get_linkedin_browser calls. For deep single-account diagnosis use diagnose_linkedin_browser, for per-account limits-only check use check_linkedin_limits (alias).",
    {
      limit: z.number().optional().describe("Max browsers to return (default 50)"),
      include_paused: z.boolean().optional().describe("Include browsers with status=paused (default true)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const body: Record<string, unknown> = {
        limit: params.limit ?? 50,
        offset: 0,
      };
      const result = await grinfiRequest("POST", "/browsers/api/linkedin-browsers/list", body) as Record<string, unknown>;
      const browsers = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];

      const filtered = (params.include_paused ?? true) ? browsers : browsers.filter((b) => b.status !== "paused");

      const snapshots = filtered.map((b) => {
        const dailyLimit = (b.daily_limit as number | undefined) ?? null;
        const usageToday = (b.usage_today as number | undefined) ?? null;
        const remaining = dailyLimit !== null && usageToday !== null ? Math.max(0, dailyLimit - usageToday) : null;
        return {
          id: b.id,
          uuid: b.uuid,
          name: b.name ?? b.email ?? null,
          status: b.status,
          cookie_status: b.cookie_status ?? null,
          health_score: b.health_score ?? null,
          daily_limit: dailyLimit,
          usage_today: usageToday,
          remaining_today: remaining,
          last_run_at: b.last_run_at ?? null,
          proxy: b.proxy ?? null,
          sender_profile_uuid: b.sender_profile_uuid ?? null,
        };
      });

      const byStatus: Record<string, number> = {};
      let totalUsageToday = 0;
      let totalDailyLimit = 0;
      for (const s of snapshots) {
        const k = String(s.status ?? "unknown");
        byStatus[k] = (byStatus[k] ?? 0) + 1;
        if (typeof s.usage_today === "number") totalUsageToday += s.usage_today;
        if (typeof s.daily_limit === "number") totalDailyLimit += s.daily_limit;
      }

      const flags: string[] = [];
      const cookieExpired = snapshots.filter((s) => s.cookie_status === "expired").length;
      const lowHealth = snapshots.filter((s) => typeof s.health_score === "number" && (s.health_score as number) < 50).length;
      const overlimit = snapshots.filter((s) => s.remaining_today === 0 && (s.daily_limit ?? 0) > 0).length;
      if (cookieExpired > 0) flags.push(`${cookieExpired} browser(s) have expired cookies — refresh via cloud browser.`);
      if (lowHealth > 0) flags.push(`${lowHealth} browser(s) have low health score (<50). Consider diagnose_linkedin_browser for root cause.`);
      if (overlimit > 0) flags.push(`${overlimit} browser(s) hit their daily limit. They will resume tomorrow.`);

      return jsonResult({
        total: snapshots.length,
        by_status: byStatus,
        usage_today_total: totalUsageToday,
        daily_limit_total: totalDailyLimit,
        capacity_remaining: totalDailyLimit - totalUsageToday,
        flags,
        snapshots,
      });
    },
  );

  // ===========================
  // LINKEDIN BROWSERS
  // ===========================

  server.tool("list_linkedin_browsers", "List all LinkedIn browser profiles with pagination.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = {};
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.offset !== undefined) body.offset = params.offset;
    if (params.order_field) body.order_field = params.order_field;
    if (params.order_type) body.order_type = params.order_type;
    const result = await grinfiRequest("POST", "/browsers/api/linkedin-browsers/list", body);
    return jsonResult(result);
  });

  server.tool("get_linkedin_browser", "Get a LinkedIn browser profile by ID.", {
    id: z.number().describe("LinkedIn browser ID (integer)"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/browsers/api/linkedin-browsers/${params.id}`);
    return jsonResult(result);
  });

  server.tool(
    "diagnose_linkedin_browser",
    "Run a deep health diagnosis on a single LinkedIn sending account (browser/seat) by ID. Returns status, cookie_status, health_score, daily_limit + usage today, last_run_at, proxy info, plus a list of detected issues (cookie expired, low health, hit daily limit, no proxy assigned, etc.) with recommendations. For lightweight fleet overview use get_health_snapshots; for proxy-only connectivity check use check_linkedin_proxy (todo).",
    {
      id: z.number().describe("LinkedIn browser ID (integer)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const browser = await grinfiRequest("GET", `/browsers/api/linkedin-browsers/${params.id}`) as Record<string, unknown>;

      const status = browser.status as string;
      const cookieStatus = browser.cookie_status as string | null | undefined;
      const healthScore = browser.health_score as number | null | undefined;
      const dailyLimit = browser.daily_limit as number | null | undefined;
      const usageToday = browser.usage_today as number | null | undefined;
      const lastRunAt = browser.last_run_at as string | null | undefined;
      const proxy = browser.proxy as Record<string, unknown> | null | undefined;

      const maskedProxy = proxy ? { ...proxy, password: proxy.password ? "***MASKED***" : null } : null;

      const issues: string[] = [];
      const recommendations: string[] = [];

      if (status !== "active") {
        issues.push(`status is '${status}' (expected 'active')`);
        if (status === "banned") recommendations.push("Account banned by LinkedIn — DO NOT retry. Investigate manually, may need to retire this seat.");
        if (status === "paused") recommendations.push("Account is paused. Use run_linkedin_browser to resume.");
        if (status === "stopped") recommendations.push("Account stopped. Check why (manual stop, error, or rate limit).");
      }
      if (cookieStatus === "expired" || cookieStatus === "invalid") {
        issues.push(`cookie_status is '${cookieStatus}' — LinkedIn session expired`);
        recommendations.push("Use share_linkedin_browser to get cloud browser URL, log into LinkedIn, refresh cookie.");
      }
      if (typeof healthScore === "number" && healthScore < 50) {
        issues.push(`health_score is ${healthScore} (low; LinkedIn limiting actions)`);
        recommendations.push("Reduce daily activity (lower daily_limit), let account 'cool down' for 1-2 days, then resume.");
      }
      if (dailyLimit !== null && dailyLimit !== undefined && usageToday !== null && usageToday !== undefined) {
        const remaining = dailyLimit - usageToday;
        if (remaining <= 0) {
          issues.push(`Daily limit hit (${usageToday}/${dailyLimit}). Will resume tomorrow.`);
        } else if (remaining < 5) {
          issues.push(`Near daily limit (${usageToday}/${dailyLimit}, only ${remaining} actions left today)`);
        }
      }
      if (!maskedProxy) {
        issues.push("No proxy assigned — direct connection from server IP. LinkedIn may detect this as suspicious.");
        recommendations.push("Assign a residential proxy via set_linkedin_browser_proxy.");
      }
      if (lastRunAt) {
        const lastRunMs = new Date(lastRunAt).getTime();
        const hoursSince = (Date.now() - lastRunMs) / (1000 * 60 * 60);
        if (hoursSince > 48) {
          issues.push(`No activity for ${Math.round(hoursSince)}h (last run: ${lastRunAt})`);
        }
      } else {
        issues.push("Browser has never run (last_run_at is null) — never started or stuck on initial setup");
      }
      if (issues.length === 0) {
        issues.push("No issues detected. Browser appears healthy.");
      }

      return jsonResult({
        id: browser.id,
        uuid: browser.uuid,
        name: browser.name ?? null,
        email: browser.email ?? null,
        status,
        cookie_status: cookieStatus,
        health_score: healthScore,
        daily_limit: dailyLimit,
        usage_today: usageToday,
        remaining_today: (dailyLimit ?? 0) - (usageToday ?? 0),
        last_run_at: lastRunAt,
        proxy: maskedProxy,
        sender_profile_uuid: browser.sender_profile_uuid,
        team_id: browser.team_id,
        issues,
        recommendations,
        is_healthy: status === "active" && cookieStatus !== "expired" && cookieStatus !== "invalid" && (typeof healthScore !== "number" || healthScore >= 50),
      });
    },
  );

  server.tool("create_linkedin_browser", "Create a new LinkedIn browser profile linked to a sender profile.", {
    sender_profile_uuid: z.string().describe("UUID of the sender profile to link"),
    proxy_country_code: z.string().optional().describe("Proxy country code (e.g. US, DE)"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { sender_profile_uuid: params.sender_profile_uuid };
    if (params.proxy_country_code) body.proxy_country_code = params.proxy_country_code;
    const result = await grinfiRequest("POST", "/browsers/api/linkedin-browsers", body);
    return jsonResult(result);
  });

  server.tool("delete_linkedin_browser", "Delete a LinkedIn browser profile by ID. This action is irreversible.", {
    id: z.number().describe("LinkedIn browser ID to delete"),
  },
    { readOnlyHint: false, destructiveHint: true },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/browsers/api/linkedin-browsers/${params.id}`);
    return jsonResult(result);
  });

  server.tool("run_linkedin_browser", "Start a LinkedIn browser session to begin executing queued actions.", {
    id: z.number().describe("LinkedIn browser ID"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", `/browsers/api/linkedin-browsers/${params.id}/run`);
    return jsonResult(result);
  });

  server.tool("stop_linkedin_browser", "Stop a running LinkedIn browser session.", {
    id: z.number().describe("LinkedIn browser ID"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", `/browsers/api/linkedin-browsers/${params.id}/stop`);
    return jsonResult(result);
  });

  server.tool("set_linkedin_browser_proxy", "Change the proxy configuration for a LinkedIn browser.", {
    id: z.number().describe("LinkedIn browser ID"),
    proxy_country_code: z.string().describe("Proxy country code (e.g. US, DE)"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", `/browsers/api/linkedin-browsers/${params.id}/set-proxy`, {
      proxy_country_code: params.proxy_country_code,
    });
    return jsonResult(result);
  });

  server.tool("share_linkedin_browser", "Share a LinkedIn browser profile with team members by email.", {
    id: z.number().describe("LinkedIn browser ID"),
    recipients: z.array(z.string()).describe("Email addresses of team members to share with"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("POST", `/browsers/api/linkedin-browsers/${params.id}/share`, {
      recipients: params.recipients,
    });
    return jsonResult(result);
  });

  // ===========================
  // DATA SOURCES (LinkedIn import jobs)
  // ===========================

  server.tool("list_data_sources", "List LinkedIn import jobs (data sources) with pagination.", {
    limit: z.number().optional(), offset: z.number().optional(),
    order_field: z.string().optional(), order_type: z.enum(["asc", "desc"]).optional(),
  },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
    const result = await grinfiRequest("GET", "/leads/api/data-sources", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_data_source", "Get a data source (LinkedIn import job) by UUID.", {
    uuid: z.string().describe("UUID of the data source"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/data-sources/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_data_source", "Create a new LinkedIn import job. Imports contacts from LinkedIn searches, lists, or Sales Navigator into a contact list.", {
    type: z.enum(["csv_leads", "sn_leads_search", "sn_leads_saved_search", "sn_leads_list", "sn_accounts_search", "sn_accounts_saved_search", "sn_accounts_list", "ln_leads_search", "ln_accounts_search", "ln_my_network", "ln_my_messenger", "post_engagement", "recruiter_leads_search"]).describe("Type of import source"),
    list_uuid: z.string().describe("UUID of the contact list to import into"),
    payload: z.record(z.string(), z.unknown()).optional().describe("Import configuration specific to the data source type"),
    tags: z.array(z.string()).optional().describe("Tags to apply to imported contacts"),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const body: Record<string, unknown> = { type: params.type, list_uuid: params.list_uuid };
    if (params.payload) body.payload = params.payload;
    if (params.tags) body.tags = params.tags;
    const result = await grinfiRequest("POST", "/leads/api/data-sources", body);
    return jsonResult(result);
  });

  server.tool("update_data_source", "Update a data source by UUID.", {
    uuid: z.string().describe("UUID of the data source"),
    type: z.string().optional(),
    list_uuid: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).nullable().optional(),
  },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
    const { uuid, ...fields } = params;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) body[k] = v; }
    const result = await grinfiRequest("PUT", `/leads/api/data-sources/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_data_source", "Delete a data source (import job) by UUID.", {
    uuid: z.string().describe("UUID of the data source to delete"),
  },
    { readOnlyHint: false, destructiveHint: true },
    async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/data-sources/${params.uuid}`);
    return jsonResult(result);
  });

  // ===========================
  // ACCOUNT (current user, teams)
  // ===========================

  server.tool("get_current_user", "Get the current authenticated user's profile and configuration.", {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
    const result = await grinfiRequest("GET", "/id/api/users/current");
    return jsonResult(result);
  });

  server.tool("list_teams", "List all teams (workspaces) available to the current user via the Grinfi API. Different from list_my_teams (which lists locally-configured team API keys). Use to discover team IDs.", {
    limit: z.number().optional(), offset: z.number().optional(),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", "/id/api/teams", undefined, buildQuery(params));
    return jsonResult(result);
  });

  server.tool("get_team", "Get details of a specific team by numeric ID.", {
    id: z.number().describe("Team ID (integer, not UUID)"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
    const result = await grinfiRequest("GET", `/id/api/teams/${params.id}`);
    return jsonResult(result);
  });

  // ===========================
  // INTEGRATIONS / DIAGNOSTICS — outbound log, external API call, LLM smoke test
  // ===========================

  server.tool(
    "call_external_api",
    "Dispatch a one-off outbound HTTP request to a PUBLIC external URL. Use for ad-hoc third-party API calls (Calendly, custom endpoints), probing partner APIs, or debugging integrations. Returns downstream status code, headers, and response body. SECURITY: only public URLs allowed — localhost / 127.x / private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x) are blocked. Max body 1MB. Timeout 30s. Use test_webhook for testing registered webhooks instead.",
    {
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP method"),
      url: z.string().url().describe("Public external URL (must be HTTPS or HTTP, no localhost/private IPs)"),
      headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
      body: z.unknown().optional().describe("Request body (JSON-serializable for POST/PUT/PATCH)"),
      timeout_ms: z.number().int().min(1000).max(60000).optional().describe("Request timeout in ms (default 30000, max 60000)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        return jsonResult({ error: "Invalid URL" });
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return jsonResult({ error: "Only http:// and https:// URLs are allowed" });
      }
      const hostname = parsedUrl.hostname.toLowerCase();

      if (hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".localhost")) {
        return jsonResult({ error: `Localhost URL blocked (SSRF protection): ${hostname}` });
      }
      if (hostname === "::1" || hostname === "[::1]") {
        return jsonResult({ error: "IPv6 localhost blocked (SSRF protection)" });
      }
      const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipv4Match) {
        const [a, b] = ipv4Match.slice(1).map(Number);
        const isPrivate =
          a === 10 ||
          a === 127 ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          (a === 169 && b === 254) ||
          a === 0 ||
          a >= 224;
        if (isPrivate) {
          return jsonResult({ error: `Private/reserved IP blocked (SSRF protection): ${hostname}` });
        }
      }

      const timeoutMs = params.timeout_ms ?? 30000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const init: RequestInit = {
          method: params.method,
          headers: params.headers ?? {},
          signal: ctrl.signal,
        };
        if (params.body !== undefined && (params.method === "POST" || params.method === "PUT" || params.method === "PATCH")) {
          if (typeof params.body === "string") {
            init.body = params.body;
          } else {
            init.body = JSON.stringify(params.body);
            if (!params.headers || !Object.keys(params.headers).some((k) => k.toLowerCase() === "content-type")) {
              (init.headers as Record<string, string>)["Content-Type"] = "application/json";
            }
          }
        }
        const response = await fetch(params.url, init);
        const latencyMs = Date.now() - startedAt;
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => { responseHeaders[k] = v; });
        const text = await response.text();
        const trimmed = text.length > 1_000_000 ? text.slice(0, 1_000_000) + "\n\n[TRUNCATED — body exceeded 1MB]" : text;
        let parsedBody: unknown = trimmed;
        try { parsedBody = JSON.parse(trimmed); } catch { /* keep as text */ }

        return jsonResult({
          ok: response.ok,
          status: response.status,
          status_text: response.statusText,
          latency_ms: latencyMs,
          headers: responseHeaders,
          body: parsedBody,
          body_length: text.length,
        });
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          ok: false,
          latency_ms: latencyMs,
          error: message,
          aborted: ctrl.signal.aborted,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  server.tool("list_outbound_log", "Read the outbound HTTP request log — every webhook delivery, automation API call, enrichment request the system has made to external URLs. Each entry shows status, retry_count, errors, request_method/url/headers/body, executor_type ('webhook'/'automation'/'enrichment'), executor_key (event name like 'contact_replied_linkedin_message'). Use to diagnose webhook delivery failures, audit recent deliveries, debug partner integrations, or see what data was sent to which endpoint. Use get_webhook_logs if you only want delivery history for one specific webhook UUID.", {
    limit: z.number().optional().describe("Number of entries (default 20)"),
    offset: z.number().optional(),
    order_field: z.string().optional().describe("default: created_at"),
    order_type: z.enum(["asc", "desc"]).optional().describe("default: desc"),
    status: z.enum(["done", "pending", "failed", "in_progress"]).optional().describe("Filter by delivery status"),
    executor_type: z.string().optional().describe("Filter by executor type (webhook / automation / enrichment)"),
    executor_key: z.string().optional().describe("Filter by event name (e.g. 'contact_replied_linkedin_message')"),
  },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const query: Record<string, string> = {};
      if (params.limit !== undefined) query.limit = String(params.limit);
      if (params.offset !== undefined) query.offset = String(params.offset);
      if (params.order_field) query.order_field = params.order_field;
      if (params.order_type) query.order_type = params.order_type;
      if (params.status) query["filter[status]"] = params.status;
      if (params.executor_type) query["filter[executor_type]"] = params.executor_type;
      if (params.executor_key) query["filter[executor_key]"] = params.executor_key;
      const result = await grinfiRequest("GET", "/integrations/c1/api/request-schedules", undefined, query);
      return jsonResult(result);
    },
  );

  server.tool("test_llm_connection", "Smoke-test a stored LLM integration by running a tiny completion ('respond with the word OK'). Returns ok:true with latency_ms on success, or ok:false with error details. Use after create_llm/update_llm to verify the credential and model work, or to audit if a stored key is still active. Costs ~5 tokens of provider credits per test.", {
    uuid: z.string().describe("UUID of the LLM integration to test"),
    job_type: z.enum(["ai_variable", "ai_template", "ai_agent"]).optional().describe("Job type for the test call (default: ai_template)"),
  },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params) => {
      const startedAt = Date.now();
      try {
        const result = await grinfiRequest("POST", `/ai/api/llms/${params.uuid}/generate`, {
          job_type: params.job_type ?? "ai_template",
          messages: [{ role: "user", content: "Respond with exactly the word 'OK' and nothing else." }],
          config: { max_tokens: 10 },
        }) as Record<string, unknown>;
        const latencyMs = Date.now() - startedAt;
        const responseText = typeof result.text === "string" ? result.text
          : typeof result.content === "string" ? result.content
          : typeof result.response === "string" ? result.response
          : JSON.stringify(result).slice(0, 200);
        return jsonResult({
          ok: true,
          latency_ms: latencyMs,
          llm_uuid: params.uuid,
          response_preview: responseText.slice(0, 100),
        });
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          ok: false,
          latency_ms: latencyMs,
          llm_uuid: params.uuid,
          error: message,
        });
      }
    },
  );

  // --- Multi-team tools (only registered when GRINFI_TEAM_KEYS is set) ---

  if (teamKeys.length > 0) {
    server.tool("list_my_teams", "List all Grinfi teams available in this connection and show which one is currently active.", {}, async () => {
      return jsonResult({
        mode: "multi-team",
        active_team_id: activeTeamId,
        teams: teamKeys.map(e => ({
          team_id: e.teamId,
          active: e.teamId === activeTeamId,
        })),
        hint: "Use switch_team tool with the team_id to switch between teams.",
      });
    });

    server.tool("switch_team", "Switch the active Grinfi team. All subsequent tool calls will use the selected team's API key.", {
      team_id: z.string().describe("Team ID to switch to"),
    }, async (params) => {
      const entry = teamKeys.find(e => e.teamId === params.team_id);
      if (!entry) {
        return jsonResult({
          success: false,
          error: `Team ${params.team_id} not found. Available teams: ${teamKeys.map(e => e.teamId).join(", ")}`,
        });
      }
      activeTeamId = params.team_id;
      return jsonResult({
        success: true,
        active_team_id: activeTeamId,
        message: `Switched to team ${activeTeamId}. All subsequent operations will use this team.`,
      });
    });
  }

  return server;
}

// --- Start the server (stdio) ---

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start Grinfi MCP server:", error);
  process.exit(1);
});
