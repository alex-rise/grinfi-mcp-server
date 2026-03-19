/**
 * OAuth 2.1 storage for MCP server.
 * Manages: dynamic client registrations, authorization codes, access/refresh tokens.
 * All stored in JSON files alongside tenants.json.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");

// =====================
// OAuth Clients (Dynamic Client Registration)
// =====================

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: string;
}

const CLIENTS_FILE = join(DATA_DIR, "oauth-clients.json");
const clientsCache = new Map<string, OAuthClient>();

function loadClients(): OAuthClient[] {
  try {
    return JSON.parse(readFileSync(CLIENTS_FILE, "utf-8")) as OAuthClient[];
  } catch {
    return [];
  }
}

function saveClients(clients: OAuthClient[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CLIENTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(clients, null, 2), "utf-8");
  renameSync(tmp, CLIENTS_FILE);
}

export function initOAuthStore(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const clients = loadClients();
  clientsCache.clear();
  for (const c of clients) clientsCache.set(c.client_id, c);
  console.log(`OAuth: loaded ${clientsCache.size} client(s)`);
}

export function registerClient(body: {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}): OAuthClient {
  const client: OAuthClient = {
    client_id: randomUUID(),
    client_name: body.client_name ?? "Unknown",
    redirect_uris: body.redirect_uris ?? [],
    grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: body.response_types ?? ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method ?? "none",
    created_at: new Date().toISOString(),
  };

  clientsCache.set(client.client_id, client);
  const all = loadClients();
  all.push(client);
  saveClients(all);
  return client;
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clientsCache.get(clientId);
}

// =====================
// Authorization Codes (short-lived, 5 min TTL)
// =====================

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  grinfiJwt: string;
  scope: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();

export function createAuthCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  grinfiJwt: string;
  scope: string;
}): string {
  const code = randomUUID();
  authCodes.set(code, {
    code,
    ...params,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  const ac = authCodes.get(code);
  if (!ac) return null;
  authCodes.delete(code);
  if (Date.now() > ac.expiresAt) return null;
  return ac;
}

// =====================
// Access & Refresh Tokens
// =====================

interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  grinfiJwt: string;
  scope: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

const TOKENS_FILE = join(DATA_DIR, "oauth-tokens.json");
const tokensCache = new Map<string, TokenRecord>(); // accessToken -> record
const refreshIndex = new Map<string, string>(); // refreshToken -> accessToken

function loadTokens(): TokenRecord[] {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as TokenRecord[];
  } catch {
    return [];
  }
}

function saveTokens(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const records = Array.from(tokensCache.values());
  const tmp = TOKENS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(records, null, 2), "utf-8");
  renameSync(tmp, TOKENS_FILE);
}

export function loadOAuthTokens(): void {
  const records = loadTokens();
  tokensCache.clear();
  refreshIndex.clear();
  for (const r of records) {
    tokensCache.set(r.accessToken, r);
    refreshIndex.set(r.refreshToken, r.accessToken);
  }
  console.log(`OAuth: loaded ${tokensCache.size} token(s)`);
}

export function issueTokens(params: {
  clientId: string;
  grinfiJwt: string;
  scope: string;
}): { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string } {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const expiresIn = 3600; // 1 hour

  const record: TokenRecord = {
    accessToken,
    refreshToken,
    clientId: params.clientId,
    grinfiJwt: params.grinfiJwt,
    scope: params.scope,
    accessExpiresAt: Date.now() + expiresIn * 1000,
    refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000, // 30 days
  };

  tokensCache.set(accessToken, record);
  refreshIndex.set(refreshToken, accessToken);
  saveTokens();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    token_type: "Bearer",
    scope: params.scope,
  };
}

export function refreshAccessToken(refreshToken: string, clientId: string): ReturnType<typeof issueTokens> | null {
  const oldAccessToken = refreshIndex.get(refreshToken);
  if (!oldAccessToken) return null;

  const old = tokensCache.get(oldAccessToken);
  if (!old) return null;
  if (old.clientId !== clientId) return null;
  if (Date.now() > old.refreshExpiresAt) return null;

  // Revoke old tokens
  tokensCache.delete(oldAccessToken);
  refreshIndex.delete(refreshToken);

  // Issue new tokens (rotation)
  return issueTokens({
    clientId: old.clientId,
    grinfiJwt: old.grinfiJwt,
    scope: old.scope,
  });
}

export function getGrinfiJwtByAccessToken(accessToken: string): string | null {
  const record = tokensCache.get(accessToken);
  if (!record) return null;
  if (Date.now() > record.accessExpiresAt) {
    // Expired but keep refresh token alive
    return null;
  }
  return record.grinfiJwt;
}

export function revokeToken(token: string): boolean {
  // Try as access token
  if (tokensCache.has(token)) {
    const record = tokensCache.get(token)!;
    tokensCache.delete(token);
    refreshIndex.delete(record.refreshToken);
    saveTokens();
    return true;
  }
  // Try as refresh token
  const at = refreshIndex.get(token);
  if (at) {
    tokensCache.delete(at);
    refreshIndex.delete(token);
    saveTokens();
    return true;
  }
  return false;
}

// =====================
// PKCE Verification
// =====================

export function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === "S256") {
    const hash = createHash("sha256").update(codeVerifier).digest("base64url");
    return hash === codeChallenge;
  }
  if (method === "plain") {
    return codeVerifier === codeChallenge;
  }
  return false;
}
