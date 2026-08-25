/**
 * Restaurant Den Anker — dashboard Worker.
 *
 * Everything money-related is entered ex-GST, sourced by the owner from
 * Exact Online. Transaction counts come from Lightspeed. Nothing in this
 * file ever writes back to any outside system — it only stores what the
 * owner gives it, in its own KV storage (binding: TOKENS).
 */

const ENC = new TextEncoder();
const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ---------- small helpers ----------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- password hashing ----------
// A single keyed HMAC (rather than a many-iteration PBKDF2) is used
// deliberately: the Workers free plan gives each request only ~10ms of CPU
// time, and a slow KDF can blow that budget and fail the request. Keying the
// hash with a server-only secret (the "pepper", generated once and never
// exposed) means an attacker without access to this Worker's storage cannot
// brute-force the hash offline even though each check is cheap.

async function getOrCreatePepperKey(env) {
  let raw = await env.TOKENS.get("auth:password_pepper");
  if (!raw) {
    raw = bytesToBase64Url(randomBytes(32));
    await env.TOKENS.put("auth:password_pepper", raw);
    raw = await env.TOKENS.get("auth:password_pepper");
  }
  return crypto.subtle.importKey("raw", base64UrlToBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

async function hashPassword(env, password, saltBytes) {
  const key = await getOrCreatePepperKey(env);
  const data = new Uint8Array(saltBytes.length + ENC.encode(password).length);
  data.set(saltBytes, 0);
  data.set(ENC.encode(password), saltBytes.length);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return bytesToBase64Url(new Uint8Array(sig));
}

async function setPassword(env, password) {
  const salt = randomBytes(16);
  const hash = await hashPassword(env, password, salt);
  await env.TOKENS.put("auth:password", JSON.stringify({ hash, salt: bytesToBase64Url(salt) }));
}

async function checkPassword(env, password) {
  const raw = await env.TOKENS.get("auth:password");
  if (!raw) return false;
  const { hash, salt } = JSON.parse(raw);
  const saltBytes = base64UrlToBytes(salt);
  const candidate = await hashPassword(env, password, saltBytes);
  return timingSafeEqual(candidate, hash);
}

// ---------- session signing (HMAC-SHA256) ----------

async function getSigningKey(env) {
  let raw = await env.TOKENS.get("auth:signing_key");
  if (!raw) {
    raw = bytesToBase64Url(randomBytes(32));
    // Avoid a race where two first requests both generate a key: store,
    // then re-read to settle on whichever write actually landed.
    await env.TOKENS.put("auth:signing_key", raw);
    raw = await env.TOKENS.get("auth:signing_key");
  }
  return crypto.subtle.importKey("raw", base64UrlToBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function makeSessionCookie(env) {
  const key = await getSigningKey(env);
  const payload = { exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payloadB64 = bytesToBase64Url(ENC.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(payloadB64));
  const sigB64 = bytesToBase64Url(new Uint8Array(sig));
  const token = `${payloadB64}.${sigB64}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

async function hasValidSession(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return false;
  const key = await getSigningKey(env);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(sigB64),
    ENC.encode(payloadB64)
  );
  if (!valid) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---------- date / period helpers (calendar-day based, no timezone math —
// each stored entry is already the owner's own trading day) ----------

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}
function parseISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(d, n) {
  const nd = new Date(d.getTime());
  nd.setUTCDate(nd.getUTCDate() + n);
  return nd;
}
function addYears(d, n) {
  const nd = new Date(d.getTime());
  nd.setUTCFullYear(nd.getUTCFullYear() + n);
  return nd;
}
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function startOfWeek(d, weekStart) {
  // weekStart: 0=Sunday..6=Saturday, default 1=Monday
  const day = d.getUTCDay();
  const diff = (day - weekStart + 7) % 7;
  return addDays(d, -diff);
}

function resolvePeriod(periodKey, settings, customStart, customEnd) {
  const today = todayUTC();
  const weekStart = settings.weekStart ?? 1;
  let start, end;
  switch (periodKey) {
    case "this_week":
      start = startOfWeek(today, weekStart);
      end = today;
      break;
    case "last_week": {
      const thisWeekStart = startOfWeek(today, weekStart);
      start = addDays(thisWeekStart, -7);
      end = addDays(thisWeekStart, -1);
      break;
    }
    case "this_month":
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      end = today;
      break;
    case "last_month": {
      const firstOfThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      end = addDays(firstOfThisMonth, -1);
      start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
      break;
    }
    case "this_fy": {
      const fyStartMonth = (settings.fiscalYearStartMonth ?? 1) - 1; // 0-indexed
      let fyStartYear = today.getUTCFullYear();
      if (today.getUTCMonth() < fyStartMonth) fyStartYear -= 1;
      start = new Date(Date.UTC(fyStartYear, fyStartMonth, 1));
      end = today;
      break;
    }
    case "last_fy": {
      const fyStartMonth = (settings.fiscalYearStartMonth ?? 1) - 1;
      let fyStartYear = today.getUTCFullYear();
      if (today.getUTCMonth() < fyStartMonth) fyStartYear -= 1;
      const thisFYStart = new Date(Date.UTC(fyStartYear, fyStartMonth, 1));
      end = addDays(thisFYStart, -1);
      start = new Date(Date.UTC(fyStartYear - 1, fyStartMonth, 1));
      break;
    }
    case "custom":
      start = parseISODate(customStart);
      end = parseISODate(customEnd);
      break;
    default:
      throw new Error("unknown period");
  }
  if (end > today) end = today;
  return { start, end };
}

function comparisonPeriods(start, end) {
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(lengthDays - 1));
  const lastYearStart = addYears(start, -1);
  const lastYearEnd = addYears(end, -1);
  return {
    previous: { start: prevStart, end: prevEnd },
    lastYear: { start: lastYearStart, end: lastYearEnd },
  };
}

// ---------- data access ----------

async function loadEntriesInRange(env, start, end) {
  // Single-venue scale: list all entries and filter. Fine up to several
  // years of daily rows; revisit with a date-bucketed index if this ever
  // needs to scale further.
  const entries = [];
  let cursor;
  do {
    const page = await env.TOKENS.list({ prefix: "entry:", cursor });
    for (const key of page.keys) {
      const dateStr = key.name.slice("entry:".length);
      const d = parseISODate(dateStr);
      if (d >= start && d <= end) {
        const raw = await env.TOKENS.get(key.name);
        if (raw) entries.push({ date: dateStr, ...JSON.parse(raw) });
      }
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  entries.sort((a, b) => (a.date < b.date ? -1 : 1));
  return entries;
}

function sumField(entries, field) {
  let any = false;
  let total = 0;
  for (const e of entries) {
    if (e[field] !== undefined && e[field] !== null && e[field] !== "") {
      any = true;
      total += Number(e[field]) || 0;
    }
  }
  return { total, any };
}

function computeMetrics(entries) {
  const revenue = sumField(entries, "revenue");
  const cogs = sumField(entries, "costOfSales");
  const wages = sumField(entries, "wages");
  const superAmt = sumField(entries, "superAmount");
  const overheads = sumField(entries, "overheads");
  const transactions = sumField(entries, "transactions");

  const wagesAny = wages.any || superAmt.any;
  const wagesTotal = wages.total + superAmt.total;

  const out = {};

  out.revenue = revenue.any ? revenue.total : null;
  out.transactions = transactions.any ? transactions.total : null;

  if (revenue.any && transactions.any) {
    out.acs = transactions.total === 0 ? "dash" : revenue.total / transactions.total;
  } else {
    out.acs = null; // not configured
  }

  out.cogs = cogs.any ? cogs.total : null;
  out.cogsPct = cogs.any && revenue.any && revenue.total !== 0 ? cogs.total / revenue.total : null;

  out.wagePct = wagesAny && revenue.any && revenue.total !== 0 ? wagesTotal / revenue.total : null;
  out.wageAmount = wagesAny ? wagesTotal : null;

  out.overheads = overheads.any ? overheads.total : null;

  const profitInputsPresent = revenue.any && cogs.any && wagesAny && overheads.any;
  out.profit = profitInputsPresent ? revenue.total - cogs.total - wagesTotal - overheads.total : null;
  out.profitPct = profitInputsPresent && revenue.total !== 0 ? out.profit / revenue.total : null;

  out.hasAnyData = revenue.any || transactions.any || cogs.any || wagesAny || overheads.any;

  return out;
}

function pctChange(current, previous) {
  if (current === null || previous === null) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function buildComparison(curMetrics, prevMetrics, yoyMetrics) {
  const fields = ["revenue", "transactions", "acs", "cogs", "wagePct", "wageAmount", "overheads", "profit"];
  const out = {};
  for (const f of fields) {
    const cur = typeof curMetrics[f] === "number" ? curMetrics[f] : null;
    const prev = typeof prevMetrics[f] === "number" ? prevMetrics[f] : null;
    const yoy = typeof yoyMetrics[f] === "number" ? yoyMetrics[f] : null;
    out[f] = { vsPrevious: pctChange(cur, prev), vsLastYear: pctChange(cur, yoy) };
  }
  return out;
}

// ---------- request handling ----------

async function requireAuth(request, env) {
  return hasValidSession(request, env);
}

function csvParse(text) {
  // Minimal CSV parser: comma-separated, optional quoted fields, header row required.
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const splitLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => (row[h] = cells[idx]));
    rows.push(row);
  }
  return rows;
}

const CSV_FIELD_MAP = {
  date: "date",
  revenue: "revenue",
  cost_of_sales: "costOfSales",
  costofsales: "costOfSales",
  cogs: "costOfSales",
  wages: "wages",
  super: "superAmount",
  superannuation: "superAmount",
  overheads: "overheads",
  transactions: "transactions",
  transaction_count: "transactions",
};

const ENTRY_FIELDS = ["revenue", "costOfSales", "wages", "superAmount", "overheads", "transactions"];

function normalizeFromCSV(row) {
  const out = { date: row.date };
  for (const [csvKey, field] of Object.entries(CSV_FIELD_MAP)) {
    if (field === "date") continue;
    if (row[csvKey] !== undefined && row[csvKey] !== "") out[field] = Number(row[csvKey]);
  }
  return out;
}

async function storeEntryRows(env, rows, opts = {}) {
  const fromCSV = !!opts.fromCSV;
  let stored = 0;
  for (const rawRow of rows) {
    const row = fromCSV ? normalizeFromCSV(rawRow) : rawRow;
    const date = row.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = `entry:${date}`;
    const existingRaw = await env.TOKENS.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing };
    for (const field of ENTRY_FIELDS) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== "") {
        merged[field] = Number(row[field]);
      }
    }
    merged.enteredAt = new Date().toISOString();
    await env.TOKENS.put(key, JSON.stringify(merged));
    stored++;
  }
  return stored;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---- public auth endpoints ----
      if (pathname === "/api/status" && request.method === "GET") {
        const passwordSet = !!(await env.TOKENS.get("auth:password"));
        const authed = passwordSet && (await hasValidSession(request, env));
        return json({ passwordSet, authed });
      }

      if (pathname === "/api/setup-password" && request.method === "POST") {
        const already = await env.TOKENS.get("auth:password");
        if (already) return json({ error: "already_set" }, 400);
        const body = await request.json().catch(() => ({}));
        const password = (body.password || "").toString();
        if (password.length < 8) return json({ error: "too_short" }, 400);
        await setPassword(env, password);
        const cookie = await makeSessionCookie(env);
        return json({ ok: true }, 200, { "Set-Cookie": cookie });
      }

      if (pathname === "/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const password = (body.password || "").toString();
        const ok = await checkPassword(env, password);
        if (!ok) return json({ error: "invalid" }, 401);
        const cookie = await makeSessionCookie(env);
        return json({ ok: true }, 200, { "Set-Cookie": cookie });
      }

      if (pathname === "/api/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
      }

      // ---- ingest endpoint: separate auth via INGEST_TOKEN secret, not the session cookie ----
      if (pathname === "/api/ingest" && request.method === "POST") {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
          return json({ error: "unauthorized" }, 401);
        }
        const contentType = request.headers.get("Content-Type") || "";
        let rows;
        if (contentType.includes("application/json")) {
          const body = await request.json();
          rows = Array.isArray(body) ? body : body.rows || [];
        } else {
          const text = await request.text();
          rows = csvParse(text);
        }
        const stored = await storeEntryRows(env, rows, { fromCSV: !contentType.includes("application/json") });
        await env.TOKENS.put("meta:last_ingest", new Date().toISOString());
        return json({ ok: true, stored });
      }

      // ---- everything below requires a valid session ----
      if (pathname.startsWith("/api/")) {
        const authed = await requireAuth(request, env);
        if (!authed) return json({ error: "unauthenticated" }, 401);
      }

      if (pathname === "/api/settings" && request.method === "GET") {
        const raw = await env.TOKENS.get("settings");
        const defaults = {
          venueName: "Restaurant Den Anker",
          weekStart: 1,
          defaultPeriod: "this_week",
          color: "#B8863E",
          timezone: "Europe/Brussels",
          fiscalYearStartMonth: 10,
          targets: {},
        };
        const settings = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
        return json(settings);
      }

      if (pathname === "/api/settings" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        await env.TOKENS.put("settings", JSON.stringify(body));
        return json({ ok: true });
      }

      if (pathname === "/api/entries" && request.method === "GET") {
        const start = parseISODate(url.searchParams.get("start"));
        const end = parseISODate(url.searchParams.get("end"));
        const entries = await loadEntriesInRange(env, start, end);
        return json({ entries });
      }

      if (pathname === "/api/entries" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const stored = await storeEntryRows(env, [body]);
        return json({ ok: true, stored });
      }

      if (pathname === "/api/data" && request.method === "GET") {
        const settingsRaw = await env.TOKENS.get("settings");
        const settings = settingsRaw ? JSON.parse(settingsRaw) : { weekStart: 1 };
        const periodKey = url.searchParams.get("period") || "this_week";
        const customStart = url.searchParams.get("start");
        const customEnd = url.searchParams.get("end");

        const { start, end } = resolvePeriod(periodKey, settings, customStart, customEnd);
        const { previous, lastYear } = comparisonPeriods(start, end);

        const [curEntries, prevEntries, yoyEntries] = await Promise.all([
          loadEntriesInRange(env, start, end),
          loadEntriesInRange(env, previous.start, previous.end),
          loadEntriesInRange(env, lastYear.start, lastYear.end),
        ]);

        const curMetrics = computeMetrics(curEntries);
        const prevMetrics = computeMetrics(prevEntries);
        const yoyMetrics = computeMetrics(yoyEntries);
        const comparison = buildComparison(curMetrics, prevMetrics, yoyMetrics);

        const trend = curEntries.map((e) => ({
          date: e.date,
          revenue: e.revenue ?? null,
        }));

        const lastIngest = await env.TOKENS.get("meta:last_ingest");

        return json({
          period: { key: periodKey, start: toISODate(start), end: toISODate(end) },
          metrics: curMetrics,
          comparison,
          trend,
          lastSynced: lastIngest || null,
          dataSource: "manual", // this build is running in upload/manual mode
        });
      }

      // ---- static assets (the dashboard frontend) ----
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: "server_error", message: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
