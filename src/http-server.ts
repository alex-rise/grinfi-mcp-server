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

// --- Helpers ---

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
    const result = await grinfiRequest("GET", "/leads/api/webhooks");
    return jsonResult(result);
  });

  server.tool("get_webhook", "Get a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook") }, async (params) => {
    const result = await grinfiRequest("GET", `/leads/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("create_webhook", "Create a new webhook. Specify the event to listen for and the target URL to call.", {
    name: z.string().describe("Webhook name"),
    event: z.string().describe("Event to trigger on (e.g. 'contact_exported', 'lead_created', 'lead_updated')"),
    target_url: z.string().describe("URL to send the webhook payload to"),
    request_method: z.string().optional().describe("HTTP method (default: POST)"),
    filters: z.string().optional().describe("Optional filters"),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/webhooks", params);
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
    const result = await grinfiRequest("PUT", `/leads/api/webhooks/${uuid}`, body);
    return jsonResult(result);
  });

  server.tool("delete_webhook", "Delete a webhook by UUID.", { uuid: z.string().describe("UUID of the webhook to delete") }, async (params) => {
    const result = await grinfiRequest("DELETE", `/leads/api/webhooks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool("test_webhook", "Test a webhook by sending a test payload.", {
    event: z.string().describe("Event name to test"),
    target_url: z.string().describe("Target URL to send the test to"),
    request_method: z.string().optional(),
    lead_uuid: z.string().optional(),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/webhooks/test", params);
    return jsonResult(result);
  });

  server.tool("get_webhook_metrics", "Get metrics for specified webhooks.", {
    uuids: z.array(z.string()).describe("Array of webhook UUIDs"),
    metrics: z.array(z.string()).optional(),
  }, async (params) => {
    const result = await grinfiRequest("POST", "/leads/api/webhooks/metrics", params);
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
      return jsonResult(result);
    }
  );

  server.tool("get_task", "Get a specific task by UUID.", { uuid: z.string().describe("UUID of the task") }, async (params) => {
    const result = await grinfiRequest("GET", `/flows/api/tasks/${params.uuid}`);
    return jsonResult(result);
  });

  server.tool(
    "list_tasks",
    "List tasks with filters. Use automation='manual' for manual tasks. Statuses: in_progress, closed (done), canceled, failed. Use schedule_at_before to filter by due date.",
    {
      limit: z.number().optional().describe("Number of results (default 20)"),
      offset: z.number().optional(), order_field: z.string().optional(),
      order_type: z.enum(["asc", "desc"]).optional(), search: z.string().optional(),
      automation: z.enum(["manual", "auto"]).optional().describe("Filter: 'manual' for manual tasks, 'auto' for automation tasks"),
      status: z.enum(["in_progress", "closed", "canceled", "failed"]).optional(),
      type: z.string().optional().describe("Filter by task type (e.g. 'linkedin_send_message')"),
      lead_uuid: z.string().optional(), sender_profile_uuid: z.string().optional(),
      flow_uuid: z.string().optional(), assignee_uuid: z.string().optional(),
      schedule_at_before: z.string().optional().describe("Filter tasks scheduled before this ISO date"),
      schedule_at_after: z.string().optional().describe("Filter tasks scheduled after this ISO date"),
    },
    async (params) => {
      const query = buildQuery(params, ["automation", "status", "type", "lead_uuid", "sender_profile_uuid", "flow_uuid", "assignee_uuid", "schedule_at_before", "schedule_at_after"]);
      const result = await grinfiRequest("GET", "/flows/api/tasks", undefined, query);
      return jsonResult(result);
    }
  );

  server.tool("complete_task", "Mark a task as completed.", { uuid: z.string().describe("UUID of the task to complete") }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/complete`);
    return jsonResult(result);
  });

  server.tool("cancel_task", "Cancel a task.", { uuid: z.string().describe("UUID of the task to cancel") }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/cancel`);
    return jsonResult(result);
  });

  server.tool("fail_task", "Mark a task as failed.", { uuid: z.string().describe("UUID of the task to fail") }, async (params) => {
    const result = await grinfiRequest("PUT", `/flows/api/tasks/${params.uuid}/fail`);
    return jsonResult(result);
  });

  server.tool("mass_cancel_tasks", "Cancel multiple tasks at once.", {
    uuids: z.array(z.string()).describe("Array of task UUIDs to cancel"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-cancel", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("mass_complete_tasks", "Mark multiple tasks as completed at once.", {
    uuids: z.array(z.string()).describe("Array of task UUIDs to complete"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-complete", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("mass_retry_tasks", "Retry multiple failed tasks at once.", {
    uuids: z.array(z.string()).describe("Array of task UUIDs to retry"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-retry", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool("mass_skip_tasks", "Skip multiple tasks at once.", {
    uuids: z.array(z.string()).describe("Array of task UUIDs to skip"),
  }, async (params) => {
    const result = await grinfiRequest("PUT", "/flows/api/tasks/mass-skip", { uuids: params.uuids });
    return jsonResult(result);
  });

  server.tool(
    "get_tasks_group_counts",
    "Get task counts grouped by status. Use automation='manual' for manual tasks.",
    {
      automation: z.enum(["manual", "auto"]).optional(),
      schedule_at_before: z.string().optional(),
      schedule_at_after: z.string().optional(),
    },
    async (params) => {
      const query: Record<string, string> = {};
      if (params.automation) query["filter[automation]"] = params.automation;
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
        return jsonResult({ unread_conversations: [], total_unread: 0, note: "No inbox messages found" });
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

      return jsonResult({
        unread_conversations: unreadConversations,
        total_unread: unreadConversations.length,
        scanned_messages: messagesResult.data.length,
        total_inbox_messages: messagesResult.total,
        note: "Showing contacts with unread_counts > 0 from recent inbox messages",
      });
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

  return server;
}

// --- HTTP Server with Streamable HTTP ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Track sessions: each session gets its own McpServer + Transport pair
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

function extractAuth(req: IncomingMessage): { authorized: boolean; mcpPath: boolean } {
  const url = req.url ?? "";
  const expectedKey = getMcpApiKey();

  // Pattern 1: /mcp/{key} (Claude.ai style - key in URL)
  const urlMatch = url.match(/^\/mcp\/([a-zA-Z0-9]+)/);
  if (urlMatch) {
    return { authorized: urlMatch[1] === expectedKey, mcpPath: true };
  }

  // Pattern 2: /mcp with Authorization: Bearer {key} (standard MCP)
  if (url === "/mcp") {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader === `Bearer ${expectedKey}`) {
      return { authorized: true, mcpPath: true };
    }
    return { authorized: false, mcpPath: true };
  }

  return { authorized: false, mcpPath: false };
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "grinfi-mcp" }));
    return;
  }

  // Check if this is an MCP request
  const auth = extractAuth(req);

  if (!auth.mcpPath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!auth.authorized) {
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
