// ─────────────────────────────────────────────────────────────────
//  CUSTOM KPI SECTIONS
//  Users (usually through Ask AI) define a section of KPIs and where the data comes from:
//    existing → KPIs that already exist in BodyData (just grouped into a new section)
//    manual   → the user uploads a CSV/JSON export (AI maps columns to the KPIs once)
//    api      → BodyData calls an HTTPS JSON API on a schedule (token stored server-side)
//    mcp      → BodyData asks Claude to read a remote MCP server on a schedule
//    agent    → the BodyData Agent on the user's own computer downloads the export with
//               the user's own signed-in browser session, then uploads it here
//  Data lands as normal daily snapshots with c_<section>_<kpi> keys, so charts, Ask AI
//  and comparisons work for it like any other metric.
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const cron = require("node-cron");
const SP = require("./source-profiles");
const F = require("./formula");
const { currentUser, runAs } = require("./tenancy");

const TYPES = ["existing", "manual", "api", "mcp", "agent", "derived"];   // derived: computed from other metrics by formula (formula.js)
const TOOL_TYPES = TYPES.filter(t => t !== "derived");
const SCHEDULES = ["none", "daily", "weekly", "monthly"];
const MAX_KPIS = 500;
const SAME_AS_HINT = "weight (body weight, lbs), bodyFat (total body fat %), fatMass (total fat mass, lbs), leanMass (total lean mass, lbs), muscleMass (skeletal muscle mass, lbs), boneMass (bone mineral content, lbs), bmi, bmr (resting/basal metabolic rate, kcal/day), restingHR (resting heart rate, bpm), vo2max (VO2 max, mL/kg/min), hrv (ms), spo2 (%), respiratoryRate, bloodPressureSystolic, bloodPressureDiastolic";   // per section — a full lab panel can have 100+ markers
const DUE_MS = { daily: 20 * 3600e3, weekly: 6.5 * 864e5, monthly: 28 * 864e5 };

module.exports = function registerSections(app, d) {
  const { auth, dbGetMeta, dbSetMeta, dbInsertSnapshot, getCoachingSettings, AnthropicClient, model, parseCSVText, slug, isoDay, invalidate, loadDays } = d;

  const secretKey = (id) => "section_secret_" + id;   // meta keys matching /secret/ are never sent to the browser
  async function getSections() { const m = await dbGetMeta(); return Array.isArray(m.kpi_sections) ? m.kpi_sections : []; }
  async function putSections(list) { await dbSetMeta({ kpi_sections: list }); }
  async function aiClient(feature = "sections") {
    const { anthropicKey } = await getCoachingSettings();
    if (!anthropicKey) throw new Error("Needs an Anthropic API key (AI Coach settings).");
    const U = d.usage?.(); if (!U) return new AnthropicClient({ apiKey: anthropicKey });
    await U.checkBudget();   // over this month's AI allowance → friendly error
    return U.client(anthropicKey, feature);
  }

  const checkFormula = (f, label) => {
    const t = String(f || "").trim(); if (!t) throw new Error(`"${label}" needs a formula.`);
    try { F.parse(t); } catch (e) { throw new Error(`Formula for "${label}": ${e.message}`); }
    return t;
  };
  // ── Validate + normalise a section definition (from Ask AI or the UI)
  async function normalise(input, existing) {
    const s = input || {};
    const name = String(s.name || "").trim().slice(0, 60);
    if (!name) throw new Error("A section needs a name.");
    const src = s.source || {};
    const type = TYPES.includes(src.type) ? src.type : "manual";
    const known = new Set(Object.keys(d.catalog(await loadDays())));
    // The AI sees raw stored field names (e.g. sleepDuration); the dashboard uses mapped names (sleepDur).
    const K = await import("./shared/kpi.mjs");
    const toBoardKey = (raw) => {
      if (!raw || raw.startsWith("c_") || raw.startsWith("hk")) return raw;
      const probe = K.mapImport({ syncDate: "2026-01-01", [raw]: 987654.321 });
      return Object.keys(probe).find(k => probe[k] === 987654.321) || raw;
    };
    const used = new Set();
    const kpis = (Array.isArray(s.kpis) ? s.kpis : []).slice(0, MAX_KPIS).map(k => {
      const label = String(k.label || "").trim().slice(0, 60);
      const exRaw = String(k.existing_key || k.existingKey || "").trim();
      const ex = exRaw && (known.has(exRaw) || k.existing) ? toBoardKey(exRaw) : "";
      if (ex) known.add(ex);
      let key = ex && known.has(ex) ? ex : (k.key && String(k.key).startsWith("c_") ? String(k.key) : `c_${slug(name)}_${slug(label.replace(/%/g, " pct"))}`.slice(0, 80));
      if (!ex && used.has(key)) key = `${key}_${slug(String(k.unit || "").replace(/%/g, "pct")) || used.size}`.slice(0, 80);   // lean mass % vs lbs
      used.add(key);
      return {
        key, label: label || key, unit: String(k.unit || "").slice(0, 16),
        agg: ["sum", "avg", "last"].includes(k.aggregate || k.agg) ? (k.aggregate || k.agg) : "avg",
        direction: ["up", "down", "neutral"].includes(k.direction) ? k.direction : "up",
        existing: key === ex,
        ...(type === "derived" ? { formula: checkFormula(k.formula, label) } : {}),
        // same measure as a standard metric (DEXA body fat ↔ Apple Health body fat) → compared side by side
        sameAs: ex ? "" : K.COMPARABLE.includes(k.sameAs ?? k.same_as) ? (k.sameAs ?? k.same_as) : K.guessSameAs(label, k.unit),
      };
    }).filter((k, i, a) => k.label && a.findIndex(x => x.key === k.key) === i);
    if (!kpis.length) throw new Error("A section needs at least one KPI.");
    const url = (v) => { const t = String(v || "").trim(); return /^https:\/\/[^\s]+$/i.test(t) ? t.slice(0, 500) : ""; };
    const localOk = (v) => { const t = String(v || "").trim(); return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(t) ? t.slice(0, 500) : url(t); };
    const source = {
      type, app: String(src.app || "").slice(0, 60),
      apiUrl: url(src.api_url ?? src.apiUrl), authHeader: String(src.auth_header ?? src.authHeader ?? "").slice(0, 120),
      mcpUrl: url(src.mcp_url ?? src.mcpUrl),
      startUrl: localOk(src.start_url ?? src.startUrl), docsUrl: url(src.docs_url ?? src.docsUrl),
      instructions: String(src.export_instructions ?? src.instructions ?? "").slice(0, 1500),
      // learned on first run; kept across edits
      map: existing?.source?.map || null, csvMaps: existing?.source?.csvMaps || {}, recipe: existing?.source?.recipe || null,
      profile: SP.PROFILES.some(p => p.id === src.profile) ? src.profile : (existing?.source?.profile || ""),   // known export layout (source-profiles.js)
      // set by connectors.js only: which OAuth service fills it, and whether its terms keep it out of Ask AI
      ...(existing?.source?.connector ? { connector: existing.source.connector, noAI: !!existing.source.noAI } : {}),
    };
    if (type === "api" && !source.apiUrl) throw new Error("API sources need an https api_url.");
    if (type === "mcp" && !source.mcpUrl) throw new Error("MCP sources need an https mcp_url.");
    const schedule = type === "derived" ? "daily" : type === "existing" || type === "manual" ? (SCHEDULES.includes(s.schedule) ? s.schedule : "none") : (SCHEDULES.includes(s.schedule) && s.schedule !== "none" ? s.schedule : "daily");
    return {
      id: existing?.id || "s" + crypto.randomBytes(5).toString("hex"),
      name, description: String(s.description || "").slice(0, 300), kpis, source, schedule,
      hour: Math.min(23, Math.max(0, parseInt(s.hour ?? existing?.hour ?? 9) || 0)),
      createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastRun: existing?.lastRun || null, lastStatus: existing?.lastStatus || null, newest: existing?.newest || null,
    };
  }

  async function saveSection(input) {
    const list = await getSections();
    const i = input.id ? list.findIndex(x => x.id === input.id) : -1;
    const sec = await normalise(input, i >= 0 ? list[i] : null);
    if (i >= 0) list[i] = sec; else list.push(sec);
    await putSections(list.slice(0, 50));
    return sec;
  }
  async function patchSection(id, patch) {
    const list = await getSections(); const i = list.findIndex(x => x.id === id); if (i < 0) return null;
    list[i] = { ...list[i], ...patch, source: { ...list[i].source, ...(patch.source || {}) } };
    await putSections(list); return list[i];
  }
  function publicSection(s, secrets) {
    const { map, csvMaps, recipe, ...source } = s.source || {};
    return { ...s, source: { ...source, learned: !!map || Object.keys(csvMaps || {}).length > 0, hasRecipe: !!recipe }, connected: !!secrets[secretKey(s.id)] };
  }

  // ── Store rows → snapshots (one per day, only days newer than what we already have minus 3)
  async function storeRows(sec, rows, { all = false, batch = "" } = {}) {
    const defs = Object.fromEntries(sec.kpis.filter(k => !k.existing).map(k => [k.key, { l: k.label, u: k.unit, lb: k.direction === "down", neu: k.direction === "neutral", s: sec.id }]));
    const keys = new Set(sec.kpis.map(k => k.key));
    const byDay = {};
    for (const r of rows) {
      const date = isoDay(r.date); if (!date) continue;
      const day = byDay[date] || (byDay[date] = {});
      for (const [k, v] of Object.entries(r.values || {})) if (keys.has(k) && typeof v === "number" && isFinite(v)) day[k] = Math.round(v * 1000) / 1000;
    }
    const dates = Object.keys(byDay).filter(dt => Object.keys(byDay[dt]).length).sort();
    const cutoff = !all && sec.newest ? new Date(new Date(sec.newest).getTime() - 3 * 864e5).toISOString().slice(0, 10) : "";
    const fresh = dates.filter(dt => dt >= cutoff);
    const now = new Date().toISOString();
    for (const dt of fresh) await dbInsertSnapshot({ syncDate: dt, source: sec.name, ...byDay[dt], customDefs: defs, _source: "section:" + sec.id, ...(batch ? { _batch: batch } : {}), _receivedAt: now, _id: crypto.randomUUID() });
    invalidate();
    const newest = dates.length ? [dates[dates.length - 1], sec.newest || ""].sort().pop() : sec.newest;
    return { days: dates.length, stored: fresh.length, first: dates[0] || null, newest };
  }

  // ── AI mapping: CSV columns → this section's KPIs (cached per header signature)
  const CsvMap = z.object({
    dateColumn: z.string().describe("Header of the date/timestamp column"),
    fields: z.array(z.object({
      kpiKey: z.string(), header: z.string().describe("CSV header holding this KPI's value; empty if the file doesn't have it"),
      multiply: z.number().describe("Factor converting the raw value to the KPI's unit; 1 if none"),
      aggregate: z.enum(["sum", "avg", "last"]).describe("How to combine several rows on the same day"),
    })),
  });
  const kpiList = (sec) => sec.kpis.map(k => `${k.key}: ${k.label}${k.unit ? ` [${k.unit}]` : ""}`).join("\n");

  async function csvRows(sec, text, filename) {
    // Known export (Hume, Dexcom, LibreView, Strava…): fixed columns and units, no AI
    const prof = SP.PROFILES.find(p => p.id === sec.source.profile) || SP.detect(text, parseCSVText);
    if (prof) {
      const keyOf = Object.fromEntries(sec.kpis.map(k => [k.label.toLowerCase(), k.key]));
      return SP.rows(prof, text, parseCSVText, isoDay).map(r => ({ date: r.date, values: Object.fromEntries(Object.entries(r.values).map(([l, v]) => [keyOf[l.toLowerCase()], v]).filter(([k]) => k)) }));
    }
    const { headers, records } = parseCSVText(text);
    if (!headers.length || !records.length) throw new Error("Couldn't read any rows from that file.");
    const sig = slug(headers.join("|")).slice(0, 120);
    let map = sec.source.csvMaps?.[sig];
    if (!map) {
      const client = await aiClient("csv_map");
      const r = await client.messages.stream({
        model, max_tokens: 8000, output_config: { effort: "low", format: zodOutputFormat(CsvMap) },
        messages: [{ role: "user", content: `Map this export file to the KPIs of the "${sec.name}" section.\nFile: ${filename}\nHeaders: ${JSON.stringify(headers)}\nFirst rows:\n${records.slice(0, 5).map(x => JSON.stringify(x)).join("\n")}\n\nKPIs (key: label [unit]):\n${kpiList(sec)}\n\nReturn one entry per KPI key.` }],
      }).finalMessage();
      if (!r.parsed_output) throw new Error("AI couldn't map this file to the section's KPIs.");
      map = r.parsed_output;
      await patchSection(sec.id, { source: { csvMaps: { ...(sec.source.csvMaps || {}), [sig]: map } } });
    }
    const acc = {};
    for (const rec of records) {
      const date = isoDay(rec[map.dateColumn]); if (!date) continue;
      for (const f of map.fields) {
        if (!f.header) continue;
        const raw = parseFloat(String(rec[f.header] ?? "").replace(/[^0-9.\-]/g, "")); if (!isFinite(raw)) continue;
        const v = raw * (f.multiply || 1), k = date + "|" + f.kpiKey;
        const a = acc[k] || (acc[k] = { sum: 0, n: 0, last: v, agg: f.aggregate }); a.sum += v; a.n++; a.last = v;
      }
    }
    const byDay = {};
    for (const [k, a] of Object.entries(acc)) { const [date, key] = k.split("|"); (byDay[date] ||= { date, values: {} }).values[key] = a.agg === "sum" ? a.sum : a.agg === "last" ? a.last : a.sum / a.n; }
    return Object.values(byDay);
  }

  // ── AI mapping: JSON (API response or uploaded .json) → rows
  const JsonMap = z.object({
    itemsPath: z.string().describe("Dot path to the array of records (e.g. 'data' or 'results.items'); empty if the root is the array, or '.' if the whole response is a single current record"),
    dateField: z.string().describe("Dot path inside each record to its date/timestamp; empty to use today's date"),
    fields: z.array(z.object({ kpiKey: z.string(), path: z.string().describe("Dot path inside each record; empty if not present"), multiply: z.number() })),
  });
  const getPath = (o, p) => !p || p === "." ? o : String(p).split(".").reduce((x, k) => (x == null ? x : x[k]), o);
  async function jsonRows(sec, json) {
    let map = sec.source.map;
    if (!map) {
      const client = await aiClient("json_map");
      const sample = JSON.stringify(json, (k, v) => Array.isArray(v) ? v.slice(0, 3) : v).slice(0, 8000);
      const r = await client.messages.stream({
        model, max_tokens: 8000, output_config: { effort: "low", format: zodOutputFormat(JsonMap) },
        messages: [{ role: "user", content: `Map this JSON from ${sec.source.app || "a health/fitness service"} to the KPIs of the "${sec.name}" section.\nSample (arrays truncated to 3 items):\n${sample}\n\nKPIs (key: label [unit]):\n${kpiList(sec)}\n\nReturn one entry per KPI key; use multiply to convert units.` }],
      }).finalMessage();
      if (!r.parsed_output) throw new Error("AI couldn't map the response to the section's KPIs.");
      map = r.parsed_output;
      await patchSection(sec.id, { source: { map } });
    }
    let items = getPath(json, map.itemsPath);
    if (map.itemsPath === "." || (items && !Array.isArray(items))) items = [items];
    if (!Array.isArray(items)) throw new Error(`Expected a list at "${map.itemsPath}" in the response.`);
    const today = new Date().toISOString().slice(0, 10);
    return items.map(it => ({
      date: map.dateField ? getPath(it, map.dateField) : today,
      values: Object.fromEntries(map.fields.filter(f => f.path).map(f => [f.kpiKey, parseFloat(getPath(it, f.path)) * (f.multiply || 1)])),
    }));
  }

  // ── Pull: API
  function safeUrl(u) {
    const x = new URL(u);
    if (x.protocol !== "https:") throw new Error("Only https APIs are allowed.");
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(x.hostname) || x.hostname.endsWith(".internal") || x.hostname.endsWith(".local")) throw new Error("That host isn't reachable from BodyData.");
    return x.toString();
  }
  async function pullApi(sec, secret) {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - (sec.newest ? 7 : 365) * 864e5).toISOString().slice(0, 10);
    const url = safeUrl(sec.source.apiUrl.replace(/\{\{start\}\}/g, start).replace(/\{\{end\}\}/g, end));
    const headers = { Accept: "application/json" };
    if (sec.source.authHeader && secret) {
      const [h, ...rest] = sec.source.authHeader.split(":");
      headers[h.trim()] = (rest.join(":").trim() || "Bearer {{secret}}").replace(/\{\{secret\}\}/g, secret);
    }
    const r = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${sec.source.app || "API"} answered ${r.status}${r.status === 401 || r.status === 403 ? " (check the token in Automations)" : ""}`);
    return jsonRows(sec, await r.json());
  }

  // ── Pull: MCP (Claude reads the server through the MCP connector, then reports rows)
  const SUBMIT = {
    name: "submit_rows", strict: true,
    description: "Report the daily values you read for the section's KPIs. Call once with every day you found.",
    input_schema: { type: "object", additionalProperties: false, required: ["rows", "note"], properties: {
      note: { type: "string", description: "One line: what you read, or why nothing was found" },
      rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["date", "values"], properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        values: { type: "array", items: { type: "object", additionalProperties: false, required: ["kpi_key", "value"], properties: { kpi_key: { type: "string" }, value: { type: "number" } } } },
      } } },
    } },
  };
  async function pullMcp(sec, secret) {
    const client = await aiClient("mcp_pull");
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - (sec.newest ? 7 : 90) * 864e5).toISOString().slice(0, 10);
    const messages = [{ role: "user", content: `Use the ${sec.source.app || "connected"} MCP server tools to read the user's daily values from ${start} to ${end} for these KPIs (key: label [unit]):\n${kpiList(sec)}\n${sec.source.instructions ? "\nNotes: " + sec.source.instructions + "\n" : ""}\nConvert to the listed units. Only read data; never create, change or delete anything. Then call submit_rows.` }];
    for (let turn = 0; turn < 8; turn++) {
      const msg = await client.beta.messages.create({
        model, max_tokens: 16000, betas: ["mcp-client-2025-11-20"],
        mcp_servers: [{ type: "url", url: safeUrl(sec.source.mcpUrl), name: "source", ...(secret ? { authorization_token: secret } : {}) }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "source" }, SUBMIT],
        messages,
      });
      messages.push({ role: "assistant", content: msg.content });
      const sub = msg.content.find(b => b.type === "tool_use" && b.name === "submit_rows");
      if (sub) return (sub.input.rows || []).map(r => ({ date: r.date, values: Object.fromEntries((r.values || []).map(v => [v.kpi_key, v.value])) }));
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason === "end_turn") { messages.push({ role: "user", content: "Call submit_rows now with what you found (an empty list is fine)." }); continue; }
      throw new Error(`MCP read stopped: ${msg.stop_reason}`);
    }
    throw new Error("MCP read didn't finish.");
  }

  // ── Derived metrics: evaluate each KPI's formula over the user's days and store the results.
  // Fully recomputable, so earlier derived rows are replaced (full: every day; else the last 30).
  async function computeDerived(sec, { full = false, batch = "" } = {}) {
    const days = await loadDays();
    const since = full || !sec.newest ? "" : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const byDay = {};
    for (const k of sec.kpis) for (const r of F.evaluate(k.formula, days)) if (r.date >= since) (byDay[r.date] ||= { date: r.date, values: {} }).values[k.key] = r.value;
    if (d.pool) await d.pool.query(`DELETE FROM snapshots WHERE user_id = $1 AND data->>'_source' = $2 AND ($3 = '' OR sync_date >= $3)`, [currentUser(), "section:" + sec.id, since]);
    return storeRows(sec, Object.values(byDay), { all: true, batch });
  }
  async function runSection(sec, opts = {}) {
    const meta = await dbGetMeta(); const secret = meta[secretKey(sec.id)] || "";
    try {
      if (sec.source.type === "derived") {
        const res = await computeDerived(sec, opts);
        await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Calculated ${res.days} day${res.days === 1 ? "" : "s"}` }, newest: res.newest });
        return res;
      }
      const rows = sec.source.type === "api" ? await pullApi(sec, secret) : sec.source.type === "mcp" ? await pullMcp(sec, secret) : null;
      if (!rows) throw new Error("This section gets data from file uploads or the BodyData Agent.");
      const fresh = await getSections().then(l => l.find(x => x.id === sec.id)) || sec;
      const res = await storeRows(fresh, rows);
      await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `${res.stored} day${res.stored === 1 ? "" : "s"} updated` }, newest: res.newest });
      return res;
    } catch (e) {
      await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: false, text: e.message.slice(0, 300) } });
      throw e;
    }
  }
  const isDue = (s) => s.schedule !== "none" && (!s.lastRun || Date.now() - new Date(s.lastRun).getTime() > DUE_MS[s.schedule]) && new Date().getUTCHours() >= (s.hour ?? 0);

  // ── Documents: PDF reports (DEXA, Function Health, Quest, InBody…) and screenshots.
  // Claude reads the document, returns every numeric result with its date; new results become new KPIs.
  const DOC_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  const DocExtract = z.object({
    sectionName: z.string().describe("Short name for this kind of report, e.g. 'DEXA scan', 'Bloodwork', 'RMR test', 'VO2 max test'. If one of the user's existing sections is the same kind of report, use its exact name"),
    provider: z.string().describe("Lab, clinic or app that produced it, e.g. 'Function Health', 'DexaFit'; empty if unknown"),
    kpis: z.array(z.object({
      label: z.string().describe("Result name as a short, UNIQUE dashboard label, e.g. 'LDL cholesterol', 'Total body fat', 'Visceral fat (VAT) mass'. If the same measure is printed in two units (e.g. lean mass 79% and 137.1 lbs) make two KPIs with different labels: 'Lean mass' (lbs) and 'Lean mass %'"),
      unit: z.string().describe("Unit as printed, e.g. mg/dL, %, lbs, ng/dL; empty if none"),
      direction: z.enum(["up", "down", "neutral"]).describe("Which way is healthier for most adults: down for body fat, VAT, LDL, ApoB, HbA1c, glucose, CRP, triglycerides; up for lean mass, bone density, HDL, vitamin D (when low); neutral when a range is best or unclear"),
      matchKey: z.string().describe("If this result is one of the section's existing KPIs, its key; otherwise empty"),
      sameAs: z.string().describe("If this result measures the same thing as one of the standard metrics listed in the instructions (e.g. DEXA total body fat % = bodyFat, total lean mass in lbs = leanMass, RMR = bmr, VO2 max = vo2max, resting heart rate = restingHR), that key; otherwise empty. Regional values (arms, legs, trunk) and percentiles are never the same measure"),
    })).describe("Every distinct numeric result in the document — as many as it contains (full lab panels often have 100+). Never shorten, sample or pick only the top ones"),
    rows: z.array(z.object({
      date: z.string().describe("YYYY-MM-DD the measurement was taken (collection/scan date, not the print date)"),
      values: z.array(z.object({ label: z.string().describe("Same label as in kpis"), unit: z.string().describe("Same unit as in kpis"), value: z.number() })),
    })).describe("One row per measurement date. Include earlier scans/results if the report shows history tables"),
  });
  function docBlock(file) {
    const ext = String(file.filename || "").split(".").pop().toLowerCase();
    const mediaType = file.mediaType || DOC_TYPES[ext];
    if (file.data) {
      if (mediaType === "application/pdf") return { type: "document", source: { type: "base64", media_type: mediaType, data: file.data } };
      if (/^image\/(png|jpeg|webp|gif)$/.test(mediaType || "")) return { type: "image", source: { type: "base64", media_type: mediaType, data: file.data } };
      throw new Error("Send a PDF, PNG, JPG or WebP (iPhone HEIC photos: take a screenshot instead).");
    }
    return { type: "text", text: `File ${file.filename}:\n` + String(file.text || "").slice(0, 150000) };
  }
  async function extractDoc(sec, file, others = []) {
    const client = await aiClient("doc_extract");
    const r = await client.messages.stream({
      model, max_tokens: 64000, output_config: { effort: "medium", format: zodOutputFormat(DocExtract) },
      messages: [{ role: "user", content: [docBlock(file), { type: "text", text:
        `Extract every numeric health result from this ${file.filename ? `file (${file.filename})` : "document"} for the user's dashboard.\n` +
        (sec ? `It goes into the "${sec.name}" section. Existing KPIs (key: label [unit]) — reuse their keys in matchKey when the result is the same measure:\n${kpiList(sec)}\n` : "") +
        (!sec && others.length ? `The user's existing sections (name: KPI labels). If this report is the same kind as one of them (e.g. another DEXA scan), use that section's exact name and reuse its exact KPI labels for the same measures:\n${others.map(o => `- ${o.name}: ${o.kpis.map(k => k.label).join(", ")}`).join("\n").slice(0, 8000)}\nOne kind of test per section: body scans, metabolic (RMR) tests, VO2 max tests and bloodwork are different kinds.\n` : "") +
        `Standard metrics for sameAs: ${SAME_AS_HINT}\n` +
        `Return EVERY result on every page — there is no maximum; a full blood panel can have 100+ markers and each one becomes its own KPI. Include body composition totals and regional values, bone density, every lab marker, etc. Include the person's own scores (e.g. their percentile vs peers, biological/metabolic age, grades as numbers). Use the most precise printed number when a value appears more than once (137.1 over 137). Skip change/difference-since-last-test values, goal/target values, predicted or population values, reference ranges, population tables and patient details (name, birth date, ID). Convert nothing; keep the printed units.` }] }],
    }).finalMessage();
    const x = r.parsed_output; if (!x) throw new Error("AI couldn't read results from that document.");
    return x;
  }
  // Apply an extraction: add any new KPIs to the section, store every dated row
  async function applyDoc(sec, x, filename) {
    const kpis = [...sec.kpis], byLabel = {};
    const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
    const id = (label, unit) => norm(label) + "|" + norm(unit);
    for (const k of x.kpis) {
      const tagged = (label, unit) => { const t = unit === "%" ? "%" : `(${unit || "value"})`; return String(label).trim().endsWith(t) ? label : `${label} ${t}`; };
      const sameLabel = (q) => [norm(k.label), norm(tagged(k.label, k.unit))].includes(norm(q.label));
      let m = kpis.find(q => q.key === k.matchKey) || kpis.find(q => sameLabel(q) && norm(q.unit) === norm(k.unit));
      // Same label but a different unit (lean mass % vs lbs) → its own KPI, never overwrite. The % one gets the "%" tag.
      if (!m && kpis.length < MAX_KPIS) {
        const clash = kpis.find(q => norm(q.label) === norm(k.label));
        let label = k.label;
        if (clash && clash.unit === "%" && k.unit !== "%") clash.label = tagged(clash.label, "%");
        else if (clash) label = tagged(k.label, k.unit);
        m = { label, unit: k.unit, aggregate: "last", direction: k.direction, existing_key: "", sameAs: k.sameAs || "" }; kpis.push(m);
      }
      if (m && k.sameAs && !m.sameAs) m.sameAs = k.sameAs;
      if (m) { byLabel[id(k.label, k.unit)] = m; if (!byLabel[norm(k.label)]) byLabel[norm(k.label)] = m; }
    }
    const saved = await saveSection({ ...sec, kpis: kpis.map(k => ({ ...k, aggregate: k.aggregate || k.agg, existing_key: k.existing ? k.key : (k.existing_key || "") })), source: { ...sec.source, app: sec.source.app || x.provider } });
    const keyOf = (label, unit) => { const m = byLabel[id(label, unit)] || byLabel[norm(label)]; if (!m) return null; return saved.kpis.find(q => (m.key && q.key === m.key) || (q.label === m.label && norm(q.unit) === norm(m.unit)))?.key; };
    const rows = x.rows.map(r => ({ date: r.date, values: Object.fromEntries(r.values.map(v => [keyOf(v.label, v.unit), v.value]).filter(([k]) => k)) }));
    const res = await storeRows(saved, rows, { all: true });
    await patchSection(saved.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Read ${filename || "document"}: ${res.days} date${res.days === 1 ? "" : "s"}, ${saved.kpis.length} KPIs` }, newest: res.newest });
    return { ...res, section: saved.id, name: saved.name, kpis: saved.kpis.length, added: saved.kpis.length - sec.kpis.length };
  }
  // CSV/TSV with a header and at least two consistent columns
  function looksTabular(t) {
    const { headers, records } = parseCSVText(t);
    return headers.length >= 2 && records.length >= 1 && records.slice(0, 5).every(r => Object.values(r).filter(v => String(v ?? "").trim()).length >= 2);
  }
  const isDoc = (f) => !!f.data || /\.(pdf|png|jpe?g|webp|gif)$/i.test(f.filename || "");

  // ── Routes
  app.get("/sections", auth, async (_req, res) => {
    try { const meta = await dbGetMeta(); res.json({ sections: (await getSections()).map(s => publicSection(s, meta)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/sections", auth, async (req, res) => {
    try { const s = await saveSection(req.body || {}); res.json({ ok: true, section: publicSection(s, await dbGetMeta()) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/sections/:id/delete", auth, async (req, res) => {
    try {
      await putSections((await getSections()).filter(s => s.id !== req.params.id)); await dbSetMeta({ [secretKey(req.params.id)]: "" });
      // purge: also remove every value this section imported
      let removed = 0;
      if (req.body?.purge && d.pool) { const r = await d.pool.query(`DELETE FROM snapshots WHERE data->>'_source' = $1 AND user_id = $2`, ["section:" + req.params.id, currentUser()]); removed = r.rowCount; invalidate(); }
      res.json({ ok: true, removed });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // API token / MCP bearer token — entered in Automations, never in chat; never returned
  app.post("/sections/:id/secret", auth, async (req, res) => {
    try {
      if (!(await getSections()).some(s => s.id === req.params.id)) return res.status(404).json({ error: "No such section" });
      await dbSetMeta({ [secretKey(req.params.id)]: String(req.body?.value || "").trim().slice(0, 4000) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/sections/:id/run", auth, async (req, res) => {
    try { const s = (await getSections()).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "No such section" }); res.json({ ok: true, ...(await runSection(s)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // File upload (manual sections, and the BodyData Agent after it downloads an export)
  async function importInto(sectionId, body) {
    const sec = (await getSections()).find(x => x.id === sectionId); if (!sec) throw Object.assign(new Error("No such section"), { status: 404 });
    const { filename = "upload.csv", text, all } = body || {};
    if (isDoc(body || {})) return { ok: true, ...(await applyDoc(sec, await extractDoc(sec, body), filename)) };
    if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("Empty file"), { status: 400 });
    const t = text.trim();
    if (!/^[\[{]/.test(t) && !looksTabular(t)) return { ok: true, ...(await applyDoc(sec, await extractDoc(sec, { filename, text: t }), filename)) };
    const rows = /^[\[{]/.test(t) ? await jsonRows(sec, JSON.parse(t)) : await csvRows(sec, text, filename);
    const fresh = (await getSections()).find(x => x.id === sec.id) || sec;
    const r = await storeRows(fresh, rows, { all: !!all });
    await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Imported ${filename}: ${r.stored} day${r.stored === 1 ? "" : "s"} updated` }, newest: r.newest });
    return { ok: true, ...r };
  }
  // Documents (AI reading, ~1 min) run as a background job when the client asks ({async: true}) → {job}; poll GET /jobs/:id
  const viaJob = async (res, kind, body, label, fn) => {
    if (body?.async && d.jobs) { const { async: _, ...payload } = body; return res.json({ ok: true, job: await d.jobs().enqueue(kind, payload, label) }); }
    res.json(await fn());
  };
  app.post("/sections/:id/import", auth, async (req, res) => {
    try { await viaJob(res, "section_import", { ...req.body, sectionId: req.params.id }, req.body?.filename, () => importInto(req.params.id, req.body)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // New section straight from a file: AI names it, defines the KPIs and fills them in
  app.post("/sections/from-file", auth, async (req, res) => {
    try {
      const f = req.body || {}; if (!f.data && !String(f.text || "").trim()) return res.status(400).json({ error: "Empty file" });
      await viaJob(res, "from_file", f, f.filename, () => fromFile(f));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  async function fromFile(f) {
    {
      if (!isDoc(f) && d.importKnownCsv) { const r = await d.importKnownCsv(f); if (r) return (r); }   // Fitbod → its own importer
      const prof = !isDoc(f) && SP.detect(String(f.text || ""), parseCSVText);
      if (prof) {   // known export → its standard section (created once, reused for every later export)
        const all = await getSections();
        const sec = all.find(s => s.source?.profile === prof.id) || all.find(s => s.name.toLowerCase() === prof.section.toLowerCase()) || await saveSection(SP.sectionDef(prof));
        // an older same-named section (e.g. the screenshot template) gets the profile's KPIs added
        const fresh = sec.source?.profile === prof.id ? sec : await saveSection({ ...sec, source: { ...sec.source, profile: prof.id, app: prof.app },
          kpis: [...sec.kpis.map(k => ({ ...k, aggregate: k.agg, existing_key: k.existing ? k.key : "" })), ...SP.sectionDef(prof).kpis.filter(n => !sec.kpis.some(k => k.label.toLowerCase() === n.label.toLowerCase()))] });
        const r = await storeRows(fresh, await csvRows(fresh, f.text, f.filename), { all: !fresh.newest || !!f.all });   // re-exports: only the last 3 days + newer
        await patchSection(fresh.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Imported ${f.filename}: ${r.days} days (${prof.app} export)` }, newest: r.newest });
        return ({ ok: true, ...r, section: fresh.id, name: fresh.name, kpis: fresh.kpis.length, existed: fresh.id === sec.id && all.some(s => s.id === sec.id), profile: prof.id });
      }
      if (!isDoc(f)) {   // CSV/JSON: define KPIs from a sample, then map the whole file
        const lines = String(f.text).split(/\r?\n/); const x = await extractDoc(null, { ...f, text: lines.slice(0, 40).join("\n") });
        const sec = await saveSection({ name: f.name || x.sectionName, source: { type: "manual", app: x.provider }, kpis: x.kpis.map(k => ({ label: k.label, unit: k.unit, direction: k.direction, aggregate: "avg", existing_key: "" })) });
        const t = String(f.text).trim();
        const r = await storeRows(sec, /^[\[{]/.test(t) ? await jsonRows(sec, JSON.parse(t)) : await csvRows(sec, f.text, f.filename), { all: true });
        await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Imported ${f.filename}: ${r.days} days` }, newest: r.newest });
        return ({ ok: true, ...r, section: sec.id, name: sec.name, kpis: sec.kpis.length });
      }
      const all = await getSections();
      const x = await extractDoc(null, f, f.name ? [] : all.filter(s => s.source?.type === "manual"));
      // Same kind of report as an existing section (e.g. a second DEXA scan) → add to it
      const same = all.find(s => s.name.toLowerCase() === String(f.name || x.sectionName).toLowerCase());
      if (same) return ({ ok: true, existed: true, ...(await applyDoc(same, x, f.filename)) });
      const sec = await saveSection({ name: f.name || x.sectionName, description: x.provider ? `From ${x.provider} reports` : "", source: { type: "manual", app: x.provider },
        kpis: x.kpis.slice(0, 1).map(k => ({ label: k.label, unit: k.unit, direction: k.direction, aggregate: "last", existing_key: "" })) });   // applyDoc adds the rest
      return ({ ok: true, ...(await applyDoc(sec, x, f.filename)), added: 0 });
    }
  }
  d.jobs?.().handle("from_file", (f) => fromFile(f));
  d.jobs?.().handle("section_import", ({ sectionId, ...body }) => importInto(sectionId, body));

  // ── App templates: one tap creates a working section for services that don't share their data
  const T = (label, unit, aggregate, direction, sameAs = "") => ({ label, unit, aggregate, direction, existing_key: "", sameAs });
  const TEMPLATES = [
    { id: "mfp_diary", app: "MyFitnessPal", name: "MyFitnessPal nutrition", type: "agent", schedule: "daily",
      startUrl: "https://www.myfitnesspal.com/reports/printable_diary",
      instructions: "Open the printable food diary (Reports → Printable Diary), pick the last 7 days and view it. There's no download: capture the page.",
      why: "Calories and macros already reach Apple Health; this adds fiber, sugar, sodium and per-day detail straight from your diary.",
      kpis: [T("Calories", "kcal", "sum", "neutral"), T("Protein", "g", "sum", "up"), T("Carbs", "g", "sum", "neutral"), T("Fat", "g", "sum", "neutral"), T("Fiber", "g", "sum", "up"), T("Sugar", "g", "sum", "down"), T("Sodium", "mg", "sum", "down")] },
    { id: "cronometer", app: "Cronometer", name: "Cronometer micronutrients", type: "agent", schedule: "daily",
      startUrl: "https://cronometer.com/#settings",
      instructions: "Settings → Account → Account Data → Export Data → Daily Nutrition. Choose the last 7 days and download the CSV.",
      why: "Apple Health only gets ~13 nutrients from Cronometer; the export has all of them.",
      kpis: [T("Calories", "kcal", "sum", "neutral"), T("Protein", "g", "sum", "up"), T("Fiber", "g", "sum", "up"), T("Magnesium", "mg", "sum", "up"), T("Potassium", "mg", "sum", "up"), T("Vitamin D", "IU", "sum", "up"), T("Omega-3", "g", "sum", "up")] },
    { id: "peloton", app: "Peloton", name: "Peloton output", type: "agent", schedule: "weekly",
      startUrl: "https://members.onepeloton.com/profile/workouts",
      instructions: "On your workouts page, click Download Workouts to get the CSV of every class.",
      why: "Apple Health gets the workout; output (kJ), class and instructor only come from Peloton's download.",
      kpis: [T("Total output", "kJ", "sum", "up"), T("Workout minutes", "min", "sum", "up"), T("Classes", "", "sum", "up"), T("Average watts", "W", "avg", "up")] },
    { id: "libreview", app: "LibreView", name: "Libre glucose", type: "agent", schedule: "weekly",
      startUrl: "https://www.libreview.com/",
      instructions: "Glucose History → Download glucose data (CSV).",
      why: "FreeStyle Libre doesn't write to Apple Health; LibreView has every reading.",
      kpis: [T("Average glucose", "mg/dL", "avg", "down"), T("Highest glucose", "mg/dL", "last", "down"), T("Lowest glucose", "mg/dL", "last", "neutral")] },
    { id: "fitbod_csv", app: "Fitbod", name: "Fitbod strength", type: "manual", schedule: "none",
      instructions: "Fitbod's export only exists in its iPhone app: Log → ⋯ → Export workout data → Share → BodyData.AI. BodyData reminds you weekly.",
      why: "Workouts arrive via Apple Health; sets, reps and weights need the export.",
      kpis: [T("Working sets", "", "sum", "up"), T("Total reps", "", "sum", "up"), T("Training volume", "lbs", "sum", "up")] },
    { id: "hume_scan", app: "Hume", name: "Hume body scan", type: "manual", schedule: "none", profile: "hume_csv",
      instructions: "In the Hume app, export your data (CSV) and share or upload it here: every weigh-in and all 14 measures come in. A screenshot of one scan also works.",
      why: "Apple Health only gets weight, body fat and BMI from Hume; muscle, visceral fat, body water, BMR and metabolic age need the export." },
    { id: "dexcom", app: "Dexcom", name: "Dexcom glucose", type: "manual", schedule: "none", profile: "dexcom_clarity",
      instructions: "clarity.dexcom.com → any report → Export (CSV), then upload it here. Daily average, time in range, lows, highs and variability are calculated for you.",
      why: "Apple Health gets Dexcom readings 3 hours late and without daily time-in-range or variability." },
    { id: "strava", app: "Strava", name: "Strava training", type: "manual", schedule: "none", profile: "strava_activities",
      instructions: "strava.com → Settings → My Account → Download or Delete Your Account → Request your archive. Upload activities.csv from the emailed ZIP.",
      why: "Apple Health gets the workout; Relative Effort, elevation and per-activity detail come from Strava's export." },
    { id: "dexa", app: "DEXA", name: "DEXA scan", type: "manual", schedule: "none",
      instructions: "Share or upload each DEXA report PDF; every result becomes a KPI and earlier scans in the report are added too.",
      why: "DEXA results never reach Apple Health.",
      kpis: [T("Total body fat", "%", "last", "down", "bodyFat"), T("Total mass", "lbs", "last", "neutral", "weight"), T("Lean mass", "lbs", "last", "up", "leanMass"), T("Fat mass", "lbs", "last", "down", "fatMass"), T("Visceral fat (VAT) mass", "lbs", "last", "down"), T("Bone density (T-score)", "", "last", "up")] },
    { id: "rmr", app: "Metabolic test", name: "RMR test", type: "manual", schedule: "none",
      instructions: "Share or upload each resting metabolic rate (RMR / indirect calorimetry) report PDF, e.g. DexaFit, PNOE, Bodpod clinics.",
      why: "Your measured calorie burn at rest and fuel mix never reach Apple Health, and they set your real calorie targets.",
      kpis: [T("Resting metabolic rate", "kcal/day", "last", "up", "bmr"), T("Respiratory exchange ratio (RER)", "", "last", "neutral"), T("Fat as fuel", "%", "last", "up"), T("Carbs as fuel", "%", "last", "neutral")] },
    { id: "vo2", app: "VO2 max test", name: "VO2 max test", type: "manual", schedule: "none",
      instructions: "Share or upload each lab VO2 max test report PDF (treadmill or bike, e.g. DexaFit, PNOE). Your watch estimate stays in Cardio Fitness.",
      why: "A lab-measured VO2 max is far more accurate than a watch estimate and includes heart-rate zones and thresholds.",
      kpis: [T("VO2 max", "mL/kg/min", "last", "up", "vo2max"), T("VO2 max percentile", "%", "last", "up"), T("Biological age", "yrs", "last", "down"), T("Max heart rate", "bpm", "last", "neutral")] },
    { id: "labs", app: "Labs", name: "Bloodwork", type: "manual", schedule: "none",
      instructions: "Share or upload each lab results PDF (Function Health, Quest, Labcorp, InsideTracker…). Every biomarker becomes a KPI.",
      why: "Lab results never reach Apple Health.",
      kpis: [T("LDL cholesterol", "mg/dL", "last", "down"), T("ApoB", "mg/dL", "last", "down"), T("HbA1c", "%", "last", "down"), T("hs-CRP", "mg/L", "last", "down"), T("Vitamin D", "ng/mL", "last", "up")] },
  ];
  app.get("/sections/templates", auth, (_req, res) => res.json({ templates: TEMPLATES.map(({ kpis, ...t }) => ({ ...t, kpis: (kpis || SP.sectionDef(SP.PROFILES.find(p => p.id === t.profile)).kpis).map(k => k.label) })) }));
  app.post("/sections/from-template", auth, async (req, res) => {
    try {
      const t = TEMPLATES.find(x => x.id === req.body?.id); if (!t) return res.status(404).json({ error: "No such template" });
      const existing = (await getSections()).find(s => s.name.toLowerCase() === t.name.toLowerCase());
      if (existing) return res.json({ ok: true, section: publicSection(existing, await dbGetMeta()), existed: true });
      const P = t.profile && SP.PROFILES.find(p => p.id === t.profile);   // known export layout → same KPIs as an upload would create
      const sec = await saveSection({ name: t.name, description: t.why, schedule: t.schedule, kpis: P ? SP.sectionDef(P).kpis : t.kpis,
        source: { type: t.type, app: t.app, start_url: t.startUrl || "", export_instructions: t.instructions, profile: t.profile || "" } });
      // App-only exports (Fitbod): add the weekly phone reminder that opens the app
      if (t.id === "fitbod_csv") {
        const rem = (await dbGetMeta()).automation_reminders || [];
        if (!rem.some(r => /fitbod/i.test(r.app))) await dbSetMeta({ automation_reminders: [...rem, { id: "r" + Date.now(), app: "Fitbod", title: "", openURL: "fitbod://", frequency: "weekly", weekday: 1, hour: 19, minute: 0, enabled: true }] });
      }
      res.json({ ok: true, section: publicSection(sec, await dbGetMeta()) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── BodyData Agent (runs on the user's computer)
  app.get("/agent/jobs", auth, async (req, res) => {
    try {
      const all = req.query.all === "1";
      const list = (await getSections()).filter(s => s.source.type === "agent" && (all || isDue(s)));
      res.json({ jobs: list.map(s => ({ id: s.id, name: s.name, app: s.source.app, startUrl: s.source.startUrl, instructions: s.source.instructions, recipe: s.source.recipe, kpis: s.kpis.map(k => k.label), schedule: s.schedule })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/agent/report", auth, async (req, res) => {
    try {
      const { id, ok, text, recipe } = req.body || {};
      const patch = { lastRun: new Date().toISOString(), lastStatus: { ok: !!ok, text: String(text || "").slice(0, 300), needsLogin: /sign.?in|log.?in/i.test(String(text || "")) && !ok } };
      if (ok && Array.isArray(recipe)) patch.source = { recipe: recipe.slice(0, 40) };
      res.json({ ok: !!(await patchSection(String(id), patch)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The agent drives its local browser one step at a time; the AI (and the Anthropic key) stay on the server.
  // It only ever sees a list of the page's clickable elements, never cookies or typed secrets.
  const STEP = {
    name: "next_action", strict: true,
    description: "Choose the single next browser action toward downloading the export.",
    input_schema: { type: "object", additionalProperties: false, required: ["action", "ref", "text", "reason"], properties: {
      action: { type: "string", enum: ["click", "goto", "fill", "press_enter", "wait", "capture", "need_login", "done", "give_up"],
        description: "click/fill use ref. goto uses text as a URL. fill types text into a search or date field (never credentials). capture when the current page itself shows the wanted data as a table, list or report (e.g. a printable diary or results page) and no file download exists. need_login when the page asks the user to sign in. done when the download has started. give_up when the data can't be found." },
      ref: { type: "integer", description: "Element number from the list, or -1" },
      text: { type: "string", description: "URL for goto, text for fill, otherwise empty" },
      reason: { type: "string", description: "Short reason, shown in the agent log" },
    } },
  };
  app.post("/agent/step", auth, async (req, res) => {
    try {
      const sec = (await getSections()).find(x => x.id === req.body?.id); if (!sec) return res.status(404).json({ error: "No such section" });
      const { url = "", title = "", elements = [], text = "", history = [] } = req.body || {};
      const client = await aiClient("agent_step");
      const els = (Array.isArray(elements) ? elements : []).slice(0, 250).map(e => `[${e.ref}] ${String(e.tag || "").slice(0, 12)}${e.type ? `(${String(e.type).slice(0, 12)})` : ""} ${String(e.label || "").slice(0, 100)}`).join("\n");
      const msg = await client.messages.create({
        model, max_tokens: 2000, output_config: { effort: "low" }, tools: [STEP],
        system: "You operate a web browser for the BodyData Agent on the user's own computer. Goal: download the user's own data export from the service so it can be imported into their health dashboard. Only navigate and click; never type usernames, passwords, codes or payment details, never change settings, delete anything, buy anything or accept new terms. If a sign-in or verification screen appears, answer need_login. Always answer by calling next_action. Prefer CSV or JSON exports covering all dates. If the service has no download but a page lists the data (a report, printable view or history table), navigate there (choose the widest date range offered) and answer capture.",
        messages: [{ role: "user", content: `Service: ${sec.source.app || sec.name}\nData wanted: ${sec.kpis.map(k => k.label).join(", ")}\nExport steps (may be approximate): ${sec.source.instructions || "unknown"}\n\nSteps so far:\n${(Array.isArray(history) ? history : []).slice(-15).map((h, i) => `${i + 1}. ${String(h).slice(0, 160)}`).join("\n") || "(none)"}\n\nCurrent page: ${String(title).slice(0, 120)} — ${String(url).slice(0, 300)}\nVisible text (start): ${String(text).slice(0, 2500)}\n\nClickable elements:\n${els}` }],
      });
      const b = msg.content.find(x => x.type === "tool_use");
      res.json(b ? b.input : { action: "give_up", ref: -1, text: "", reason: "no decision" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Hourly: pull API/MCP sections that are due
  cron.schedule("7 * * * *", async () => {
    for (const uid of await (d.allUsers ? d.allUsers() : ["owner"]).catch(() => [])) await runAs(uid, async () => {
      for (const s of await getSections().catch(() => [])) {
        if ((s.source.type === "api" || s.source.type === "mcp" || s.source.type === "derived") && isDue(s)) {
          try { const r = await runSection(s); console.log(`[sections] ${uid} · ${s.name}: ${r.stored} days`); }
          catch (e) { console.error(`[sections] ${uid} · ${s.name}: ${e.message}`); }
        }
      }
    });
  }, { timezone: "UTC" });

  // ── Ask AI tools
  const kpiSchema = { type: "object", additionalProperties: false, required: ["label", "unit", "aggregate", "direction", "existing_key"], properties: {
    label: { type: "string" }, unit: { type: "string", description: "e.g. lbs, %, ms, bpm, kcal, g, min, hrs, mg/dL, or empty" },
    aggregate: { type: "string", enum: ["sum", "avg", "last"], description: "sum for totals (steps, minutes), avg for daily averages, last for readings (weight, lab results)" },
    direction: { type: "string", enum: ["up", "down", "neutral"], description: "Which way is better: up, down (e.g. body fat, resting HR, glucose), or neutral" },
    existing_key: { type: "string", description: "A metric key from the catalog when this KPI already exists in BodyData; empty for new data" },
  } };
  const tools = [
    { name: "save_kpi_section", strict: true,
      description: "Create a custom KPI section on the user's dashboard, or update one (pass its id). Use when the user asks to track, group or add KPIs. Each KPI is either an existing metric (existing_key from the catalog) or new data from the section's source.",
      input_schema: { type: "object", additionalProperties: false, required: ["id", "name", "description", "kpis", "source", "schedule"], properties: {
        id: { type: "string", description: "Existing section id to update, or empty to create" },
        name: { type: "string", description: "Short section title, e.g. 'Bloodwork' or 'Strength'" },
        description: { type: "string" },
        kpis: { type: "array", items: kpiSchema },
        schedule: { type: "string", enum: SCHEDULES, description: "How often new data is pulled (api, mcp, agent). none for existing/manual" },
        source: { type: "object", additionalProperties: false, required: ["type", "app", "api_url", "auth_header", "mcp_url", "start_url", "docs_url", "export_instructions"], properties: {
          type: { type: "string", enum: TOOL_TYPES, description: "existing: all KPIs already in BodyData. api: the service has a JSON REST API the user can get a personal token for. mcp: the service has a remote MCP server. agent: no API, data comes from a web export the BodyData Agent downloads on the user's computer. manual: the user uploads files." },
          app: { type: "string", description: "Service name, e.g. Whoop, Levels, Function Health" },
          api_url: { type: "string", description: "api only: https GET endpoint returning JSON. May contain {{start}} and {{end}} (YYYY-MM-DD)" },
          auth_header: { type: "string", description: "api only: header template, e.g. 'Authorization: Bearer {{secret}}'. The user pastes the token in Automations, never in chat" },
          mcp_url: { type: "string", description: "mcp only: https URL of the remote MCP server" },
          start_url: { type: "string", description: "agent only: https page where the export lives" },
          docs_url: { type: "string" },
          export_instructions: { type: "string", description: "agent/manual: the clicks to export the data, e.g. 'Settings → Data → Export CSV'" },
        } },
      } } },
    { name: "record_values", strict: true,
      description: "Store values you read from a document or screenshot the user attached (or numbers they typed) into a section's KPIs. Create or update the section first with save_kpi_section so every KPI exists, then call this with the KPI keys it returned.",
      input_schema: { type: "object", additionalProperties: false, required: ["section_id", "rows"], properties: {
        section_id: { type: "string" },
        rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["date", "values"], properties: {
          date: { type: "string", description: "YYYY-MM-DD the measurement was taken" },
          values: { type: "array", items: { type: "object", additionalProperties: false, required: ["kpi_key", "value"], properties: { kpi_key: { type: "string" }, value: { type: "number" } } } },
        } } },
      } } },
    { name: "delete_kpi_section", strict: true, description: "Delete a custom KPI section (data already imported stays).",
      input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } },
  ];
  async function runTool(name, input, batch = "") {   // batch: the builder's change id (Undo removes these values)
    if (name === "save_kpi_section") {
      const s = await saveSection(input);
      return { ok: true, id: s.id, name: s.name, kpis: s.kpis.map(k => ({ key: k.key, label: k.label, existing: k.existing })), source: s.source.type, schedule: s.schedule,
        next_step: { existing: "Done: the section shows on the dashboard now.", manual: "Tell the user to upload an export in Automations → Custom sections.", api: "Tell the user to open Automations → Custom sections → Connect and paste their API token there (never in chat), then Run now.", mcp: "Tell the user to open Automations → Custom sections → Connect if the server needs a token, then Run now.", agent: "Tell the user to set up the BodyData Agent on their computer (Automations → Custom sections → Agent setup) and sign in to the app once in the agent's browser window." }[s.source.type] };
    }
    if (name === "record_values") {
      const sec = (await getSections()).find(s => s.id === input.section_id); if (!sec) throw new Error("No section " + input.section_id);
      const r = await storeRows(sec, (input.rows || []).map(x => ({ date: x.date, values: Object.fromEntries((x.values || []).map(v => [v.kpi_key, v.value])) })), { all: true, batch });
      await patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Added from chat: ${r.stored} date${r.stored === 1 ? "" : "s"}` }, newest: r.newest });
      return { ok: true, ...r, unknown_keys: [...new Set((input.rows || []).flatMap(x => x.values.map(v => v.kpi_key)).filter(k => !sec.kpis.some(q => q.key === k)))] };
    }
    if (name === "delete_kpi_section") { await putSections((await getSections()).filter(s => s.id !== input.id)); return { ok: true }; }
    return null;
  }
  async function promptBlock() {
    const list = await getSections();
    return `\n\nCustom KPI sections: the user can ask you to create dashboard sections with their own KPIs and data source (save_kpi_section). Pick the source honestly: existing when every KPI is already in the catalog; api only when the service really offers a personal JSON API (web_search to confirm the endpoint and auth); mcp only for a real remote MCP server; agent for services with a web export but no API; manual otherwise. Set direction carefully (lower is better for body fat, resting HR, glucose, LDL, blood pressure…). Never ask for passwords or API tokens in chat: tokens go in Automations → Custom sections → Connect, and for agent sources the user signs in themselves in the agent's browser. When the user attaches a report (DEXA, bloodwork such as Function Health or Quest, InBody, a screenshot), read every numeric result and its measurement date, save_kpi_section (reuse a matching section, e.g. add to "DEXA scan" rather than making a second one; include every result as a KPI, aggregate last, correct direction), then record_values, then summarise the key results and changes versus earlier entries. After saving, tell the user the one next step.\nExisting sections:\n${list.length ? list.map(s => `- ${s.id} "${s.name}" (${s.source.type}${s.source.app ? ", " + s.source.app : ""}): ${s.kpis.map(k => k.label).join(", ")}`).join("\n") : "(none)"}`;
  }

  // KPI keys Ask AI must not read (services whose terms limit AI use, unless the user allowed it)
  async function noAiKeys() { return new Set((await getSections()).filter(s => s.source?.noAI).flatMap(s => s.kpis.filter(k => !k.existing).map(k => k.key))); }
  return { tools, runTool, promptBlock, noAiKeys, getSections, saveSection, putSections, patchSection, storeRows, runSection, computeDerived, publicSection, secretKey };
};
