interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VECDOCSRV_BASE_URL: string;
  DEFAULT_NAMESPACE_PREFIX: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

type JsonRecord = Record<string, unknown>;

type SessionData = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  namespaceId: string;
};

type OAuthState = {
  nonce: string;
  redirectPath: string;
};

type GoogleUser = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
};

type BindingColumns = {
  namespace: string | null;
  sub: string | null;
  email: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  name: string | null;
  picture: string | null;
};

const SESSION_COOKIE = "note_search_session";
const STATE_COOKIE = "note_search_oauth_state";

function json(status: number, payload: JsonRecord): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function htmlRedirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("location", location);
  return new Response(null, { status: 302, headers });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - input.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signValue(value: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(sig));
}

async function encodeSignedJson(payload: JsonRecord, secret: string): Promise<string> {
  const jsonText = JSON.stringify(payload);
  const body = base64UrlEncode(new TextEncoder().encode(jsonText));
  const sig = await signValue(body, secret);
  return `${body}.${sig}`;
}

async function decodeSignedJson<T>(value: string | null, secret: string): Promise<T | null> {
  if (!value || !value.includes(".")) return null;
  const [body, sig] = value.split(".", 2);
  const expected = await signValue(body, secret);
  if (sig !== expected) return null;
  try {
    const bytes = base64UrlDecode(body);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function parseCookies(request: Request): Record<string, string> {
  const raw = request.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
  }
  return out;
}

function setCookie(headers: Headers, name: string, value: string, maxAgeSeconds: number): void {
  headers.append(
    "set-cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function clearCookie(headers: Headers, name: string): void {
  headers.append(
    "set-cookie",
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function randomString(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requiredEnv(env: Env, key: keyof Env): string {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(`missing_env_${String(key)}`);
  return value;
}

function buildGoogleAuthUrl(request: Request, env: Env, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", requiredEnv(env, "GOOGLE_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", new URL("/auth/google/callback", request.url).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeGoogleCode(code: string, request: Request, env: Env): Promise<{ access_token: string }> {
  const body = new URLSearchParams({
    code,
    client_id: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requiredEnv(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: new URL("/auth/google/callback", request.url).toString(),
    grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`google_token_http_${response.status}`);
  return await response.json() as { access_token: string };
}

async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`google_userinfo_http_${response.status}`);
  const user = await response.json() as GoogleUser;
  if (!user.sub || !user.email) throw new Error("google_userinfo_invalid");
  return user;
}

async function detectBindingColumns(env: Env): Promise<BindingColumns> {
  const result = await env.DB.prepare("PRAGMA table_info(google_account_bindings)").all<{ name: string }>();
  const names = (result.results || []).map((row) => row.name);
  const pick = (candidates: string[]) => candidates.find((item) => names.includes(item)) || null;
  return {
    namespace: pick(["namespace_id", "namespaceId", "namespace"]),
    sub: pick(["google_sub", "sub", "google_account_sub", "google_subject"]),
    email: pick(["google_email", "email", "google_account_email"]),
    createdAt: pick(["created_at", "createdAt"]),
    updatedAt: pick(["updated_at", "updatedAt"]),
    name: pick(["google_name", "name"]),
    picture: pick(["google_picture", "picture", "avatar_url"])
  };
}

async function getOrCreateNamespace(user: GoogleUser, env: Env): Promise<string> {
  const cols = await detectBindingColumns(env);
  if (!cols.namespace) throw new Error("google_account_bindings_missing_namespace_column");

  const whereParts: string[] = [];
  const bindValues: unknown[] = [];
  if (cols.sub) {
    whereParts.push(`${cols.sub} = ?`);
    bindValues.push(user.sub);
  }
  if (cols.email) {
    whereParts.push(`${cols.email} = ?`);
    bindValues.push(user.email);
  }
  if (whereParts.length > 0) {
    const query = `SELECT ${cols.namespace} AS namespace_id FROM google_account_bindings WHERE ${whereParts.join(" OR ")} LIMIT 1`;
    const result = await env.DB.prepare(query).bind(...bindValues).all<{ namespace_id: string }>();
    const existing = result.results?.[0]?.namespace_id?.trim();
    if (existing) return existing;
  }

  const namespaceId = `${env.DEFAULT_NAMESPACE_PREFIX || "ns_user_"}${(await sha1Hex(user.sub)).slice(0, 12)}`;
  const insertColumns: string[] = [cols.namespace];
  const insertValues: unknown[] = [namespaceId];
  if (cols.sub) {
    insertColumns.push(cols.sub);
    insertValues.push(user.sub);
  }
  if (cols.email) {
    insertColumns.push(cols.email);
    insertValues.push(user.email);
  }
  if (cols.createdAt) {
    insertColumns.push(cols.createdAt);
    insertValues.push(new Date().toISOString());
  }
  if (cols.updatedAt) {
    insertColumns.push(cols.updatedAt);
    insertValues.push(new Date().toISOString());
  }
  if (cols.name && user.name) {
    insertColumns.push(cols.name);
    insertValues.push(user.name);
  }
  if (cols.picture && user.picture) {
    insertColumns.push(cols.picture);
    insertValues.push(user.picture);
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `INSERT INTO google_account_bindings (${insertColumns.join(", ")}) VALUES (${placeholders})`;
  await env.DB.prepare(sql).bind(...insertValues).run();
  return namespaceId;
}

async function currentSession(request: Request, env: Env): Promise<SessionData | null> {
  const cookies = parseCookies(request);
  return decodeSignedJson<SessionData>(cookies[SESSION_COOKIE] ?? null, requiredEnv(env, "SESSION_SECRET"));
}

async function handleGoogleLogin(request: Request, env: Env): Promise<Response> {
  const redirectPath = new URL(request.url).searchParams.get("redirect") || "/";
  const statePayload: OAuthState = { nonce: randomString(), redirectPath };
  const signedState = await encodeSignedJson(statePayload, requiredEnv(env, "SESSION_SECRET"));
  const headers = new Headers();
  setCookie(headers, STATE_COOKIE, signedState, 600);
  return htmlRedirect(buildGoogleAuthUrl(request, env, signedState), headers);
}

async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const cookies = parseCookies(request);
  const savedState = cookies[STATE_COOKIE] || "";
  if (!code || !state || !savedState || state !== savedState) {
    return json(400, { ok: false, error: "invalid_oauth_state" });
  }
  const parsedState = await decodeSignedJson<OAuthState>(savedState, requiredEnv(env, "SESSION_SECRET"));
  if (!parsedState) {
    return json(400, { ok: false, error: "invalid_oauth_state" });
  }

  const token = await exchangeGoogleCode(code, request, env);
  const user = await fetchGoogleUser(token.access_token);
  const namespaceId = await getOrCreateNamespace(user, env);
  const session: SessionData = {
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    namespaceId
  };
  const headers = new Headers();
  setCookie(headers, SESSION_COOKIE, await encodeSignedJson(session as unknown as JsonRecord, requiredEnv(env, "SESSION_SECRET")), 60 * 60 * 24 * 14);
  clearCookie(headers, STATE_COOKIE);
  return htmlRedirect(parsedState.redirectPath || "/", headers);
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) {
    return json(200, { ok: true, authenticated: false });
  }
  return json(200, {
    ok: true,
    authenticated: true,
    email: session.email,
    name: session.name || "",
    picture: session.picture || "",
    namespaceId: session.namespaceId
  });
}

async function handleLogout(): Promise<Response> {
  const headers = new Headers();
  clearCookie(headers, SESSION_COOKIE);
  clearCookie(headers, STATE_COOKIE);
  return new Response(null, { status: 204, headers });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json(401, { ok: false, error: "unauthorized" });
  const payload = await request.json().catch(() => null) as { query?: string; limit?: number; vectorLimit?: number } | null;
  const query = String(payload?.query || "").trim();
  if (!query) return json(400, { ok: false, error: "missing_query" });
  const upstream = await fetch(`${env.VECDOCSRV_BASE_URL}/api/v1/text-docs/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      namespaceId: session.namespaceId,
      limit: payload?.limit ?? 8,
      vectorLimit: payload?.vectorLimit ?? 30
    })
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function handleNoteDetail(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json(401, { ok: false, error: "unauthorized" });

  const upstream = await fetch(
    `${env.VECDOCSRV_BASE_URL}/api/v1/text-docs/${encodeURIComponent(id)}?namespaceId=${encodeURIComponent(session.namespaceId)}&hydrateBody=true`
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true, service: "cfpages-note-search" });
      }
      if (request.method === "GET" && url.pathname === "/auth/google/login") {
        return handleGoogleLogin(request, env);
      }
      if (request.method === "GET" && url.pathname === "/auth/google/callback") {
        return handleGoogleCallback(request, env);
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        return handleLogout();
      }
      if (request.method === "GET" && url.pathname === "/api/me") {
        return handleMe(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/search") {
        return handleSearch(request, env);
      }
      const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (noteMatch && request.method === "GET") {
        return handleNoteDetail(request, env, decodeURIComponent(noteMatch[1]));
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("cfpages-note-search request failed", error);
      return json(500, {
        ok: false,
        error: "internal_error",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
