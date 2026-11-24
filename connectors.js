// ─────────────────────────────────────────────────────────────────
//  One-tap connections (OAuth) to services with real APIs: Withings, WHOOP.
//    GET  /connect                    providers: configured? connected? last sync
//    POST /connect/:p/start           → { url } (open it; the user signs in at the provider)
//    GET  /connect/:p/callback        provider redirects here; tokens stored server-side only
//    POST /connect/:p/sync            pull now   ·   POST /connect/:p/disconnect
//  Each provider fills its own standard section (so charts, By source, Ask AI just work)
//  and is pulled hourly. Tokens live in meta "connector_secret_<p>" (never sent to clients
//  or exported). Providers whose terms limit AI use are kept out of Ask AI unless allowed.
//  Env per provider: <P>_CLIENT_ID, <P>_CLIENT_SECRET (developer apps the owner registers).
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const cron = require("node-cron");
const { currentUser, runAs } = require("./tenancy");

const KG = 2.20462;
const T = (label, unit, aggregate, direction, sameAs = "") => ({ label, unit, aggregate, direction, existing_key: "", sameAs });
const day = (t, tz) => { const d = new Date(t); if (isNaN(d)) return null;
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || process.env.USER_TZ || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return d.toISOString().slice(0, 10); } };
// WHOOP gives offsets like "-05:00": the local day is the UTC time shifted by it
const dayOffset = (iso, off) => { const m = String(off || "").match(/^([+-])(\d{2}):?(\d{2})$/); const t = new Date(iso).getTime(); if (!m || isNaN(t)) return day(iso);
  return new Date(t + (m[1] === "-" ? -1 : 1) * (parseInt(m[2]) * 60 + parseInt(m[3])) * 60e3).toISOString().slice(0, 10); };

const PROVIDERS = {
  withings: {
    name: "Withings", section: "Withings", ai: "yes",
    authUrl: "https://account.withings.com/oauth2_user/authorize2", scope: "user.info,user.metrics,user.activity",
    about: "Scales, blood pressure monitors and watches: weight, body composition, blood pressure, heart rate, SpO2, pulse wave velocity.",
    kpis: [T("Weight", "lbs", "last", "neutral", "weight"), T("Body fat", "%", "last", "down", "bodyFat"), T("Fat mass", "lbs", "last", "down", "fatMass"),
      T("Lean mass", "lbs", "last", "up", "leanMass"), T("Muscle mass", "lbs", "last", "up", "muscleMass"), T("Bone mass", "lbs", "last", "neutral", "boneMass"),
      T("Body water", "lbs", "last", "neutral"), T("Systolic blood pressure", "mmHg", "avg", "down", "bloodPressureSystolic"), T("Diastolic blood pressure", "mmHg", "avg", "down", "bloodPressureDiastolic"),
      T("Heart rate", "bpm", "avg", "down"), T("SpO2", "%", "avg", "up", "spo2"), T("Pulse wave velocity", "m/s", "last", "down"), T("VO2 max", "mL/kg/min", "last", "up", "vo2max"),
      T("Vascular age", "yrs", "last", "down"), T("Steps", "", "sum", "up"), T("Active calories", "kcal", "sum", "up")],
    async token(params) {
      const r = await fetch("https://wbsapi.withings.net/v2/oauth2", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "requesttoken", client_id: env("withings", "ID"), client_secret: env("withings", "SECRET"), ...params }) });
      const j = await r.json(); if (j.status !== 0) throw new Error(`Withings sign-in failed (status ${j.status})`);
      return { access: j.body.access_token, refresh: j.body.refresh_token, expires: Date.now() + (j.body.expires_in || 10800) * 1000, account: String(j.body.userid || "") };
    },
    exchange(code, redirect) { return this.token({ grant_type: "authorization_code", code, redirect_uri: redirect }); },
    refresh(t) { return this.token({ grant_type: "refresh_token", refresh_token: t.refresh }); },
    async pull(t, since) {
      const call = async (path, params) => {
        const r = await fetch("https://wbsapi.withings.net" + path, { method: "POST", headers: { Authorization: "Bearer " + t.access, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) });
        const j = await r.json(); if (j.status !== 0 && j.status !== 100) throw Object.assign(new Error(`Withings answered status ${j.status}`), { auth: j.status === 401 || j.status === 343 }); return j.body || {};
      };
      const rows = {}, put = (d, l, v) => { if (d && isFinite(v)) (rows[d] ||= {})[l] = v; };
      // measures: type → [label, convert]. Several weigh-ins a day: the last wins (blood pressure/heart rate: averaged)
      const M = { 1: ["Weight", KG], 6: ["Body fat", 1], 8: ["Fat mass", KG], 5: ["Lean mass", KG], 76: ["Muscle mass", KG], 88: ["Bone mass", KG], 77: ["Body water", KG],
        10: ["Systolic blood pressure", 1], 9: ["Diastolic blood pressure", 1], 11: ["Heart rate", 1], 54: ["SpO2", 1], 91: ["Pulse wave velocity", 1], 123: ["VO2 max", 1], 140: ["Vascular age", 1] };
      const AVG = new Set(["Systolic blood pressure", "Diastolic blood pressure", "Heart rate", "SpO2"]);
      const acc = {};
      let offset = 0;
      for (let page = 0; page < 50; page++) {
        const b = await call("/measure", { action: "getmeas", category: "1", meastypes: Object.keys(M).join(","), startdate: String(Math.floor(since / 1000)), enddate: String(Math.floor(Date.now() / 1000)), ...(offset ? { offset: String(offset) } : {}) });
        for (const g of (b.measuregrps || []).sort((a, z) => a.date - z.date)) {
          const d = day(g.date * 1000, b.timezone);
          for (const m of g.measures || []) { const def = M[m.type]; if (!def) continue; const v = m.value * Math.pow(10, m.unit) * def[1];
            const k = d + "|" + def[0], a = acc[k] ||= { s: 0, n: 0, last: v }; a.s += v; a.n++; a.last = v; }
        }
        if (!b.more) break; offset = b.offset;
      }
      for (const [k, a] of Object.entries(acc)) { const [d, l] = k.split("|"); put(d, l, Math.round((AVG.has(l) ? a.s / a.n : a.last) * 100) / 100); }
      // daily activity (watches; scales without a watch just return nothing)
      const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
      let off2 = 0;
      for (let page = 0; page < 20; page++) {
        const b = await call("/v2/measure", { action: "getactivity", startdateymd: ymd(since), enddateymd: ymd(Date.now()), data_fields: "steps,calories", ...(off2 ? { offset: String(off2) } : {}) });
        for (const a of b.activities || []) { put(a.date, "Steps", a.steps); put(a.date, "Active calories", a.calories); }
        if (!b.more) break; off2 = b.offset;
      }
      return Object.entries(rows).map(([date, values]) => ({ date, values }));
    },
  },

  whoop: {
    name: "WHOOP", section: "WHOOP", ai: "optin",   // WHOOP's terms: the member must allow AI use; never used for training
    authUrl: "https://api.prod.whoop.com/oauth/oauth2/auth", scope: "read:recovery read:cycles read:sleep read:workout read:body_measurement offline",
    about: "Recovery, strain, sleep stages, HRV, resting heart rate, respiratory rate and skin temperature.",
    kpis: [T("Recovery", "%", "last", "up"), T("HRV", "ms", "last", "up", "hrv"), T("Resting heart rate", "bpm", "last", "down", "restingHR"), T("SpO2", "%", "last", "up", "spo2"),
      T("Skin temperature", "°C", "last", "neutral"), T("Day strain", "", "last", "neutral"), T("Energy burned", "kcal", "last", "neutral"), T("Average heart rate", "bpm", "last", "neutral"),
      T("Sleep performance", "%", "last", "up"), T("Sleep efficiency", "%", "last", "up"), T("Sleep consistency", "%", "last", "up"), T("Time asleep", "hrs", "sum", "up"),
      T("Deep sleep", "hrs", "sum", "up"), T("REM sleep", "hrs", "sum", "up"), T("Light sleep", "hrs", "sum", "neutral"), T("Respiratory rate", "brpm", "last", "neutral", "respiratoryRate"),
      T("Sleep disturbances", "", "sum", "down")],
    async token(params) {
      const r = await fetch("https://api.prod.whoop.com/oauth/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env("whoop", "ID"), client_secret: env("whoop", "SECRET"), ...params }) });
      const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error(`WHOOP sign-in failed (${r.status}${j.error ? " " + j.error : ""})`);
      return { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
    },
    exchange(code, redirect) { return this.token({ grant_type: "authorization_code", code, redirect_uri: redirect }); },
    refresh(t) { return this.token({ grant_type: "refresh_token", refresh_token: t.refresh, scope: "offline" }); },
    async pull(t, since) {
      const list = async (path) => {
        const out = []; let next = "";
        for (let page = 0; page < 60; page++) {
          const u = new URL("https://api.prod.whoop.com/developer" + path); u.searchParams.set("limit", "25"); u.searchParams.set("start", new Date(since).toISOString()); if (next) u.searchParams.set("nextToken", next);
          const r = await fetch(u, { headers: { Authorization: "Bearer " + t.access }, signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw Object.assign(new Error(`WHOOP answered ${r.status}`), { auth: r.status === 401 });
          const j = await r.json(); out.push(...(j.records || [])); next = j.next_token; if (!next) break;
        }
        return out;
      };
      const rows = {}, put = (d, l, v, add) => { if (d && typeof v === "number" && isFinite(v)) { const o = rows[d] ||= {}; o[l] = Math.round(((add ? o[l] || 0 : 0) + v) * 100) / 100; } };
      const cycles = await list("/v2/cycle"), cycleDay = {};
      for (const c of cycles) {   // a cycle runs bedtime → next bedtime; it belongs to the day you wake up in it (start + 12 h)
        const d = dayOffset(new Date(new Date(c.start).getTime() + 12 * 3600e3).toISOString(), c.timezone_offset); cycleDay[c.id] = d;
        if (c.score_state !== "SCORED" || !c.score) continue;
        put(d, "Day strain", c.score.strain); put(d, "Energy burned", c.score.kilojoule / 4.184); put(d, "Average heart rate", c.score.average_heart_rate);
      }
      for (const r of await list("/v2/recovery")) {
        if (r.score_state !== "SCORED" || !r.score) continue; const d = cycleDay[r.cycle_id] || dayOffset(r.created_at);
        put(d, "Recovery", r.score.recovery_score); put(d, "HRV", r.score.hrv_rmssd_milli); put(d, "Resting heart rate", r.score.resting_heart_rate);
        put(d, "SpO2", r.score.spo2_percentage); put(d, "Skin temperature", r.score.skin_temp_celsius);
      }
      const H = (ms) => (ms || 0) / 3600e3;
      for (const s of await list("/v2/activity/sleep")) {
        if (s.score_state !== "SCORED" || !s.score) continue; const d = dayOffset(s.end, s.timezone_offset), st = s.score.stage_summary || {};
        const asleep = H(st.total_light_sleep_time_milli) + H(st.total_slow_wave_sleep_time_milli) + H(st.total_rem_sleep_time_milli);
        put(d, "Time asleep", asleep, true); put(d, "Deep sleep", H(st.total_slow_wave_sleep_time_milli), true); put(d, "REM sleep", H(st.total_rem_sleep_time_milli), true);
        put(d, "Light sleep", H(st.total_light_sleep_time_milli), true); put(d, "Sleep disturbances", st.disturbance_count, true);
        if (!s.nap) { put(d, "Sleep performance", s.score.sleep_performance_percentage); put(d, "Sleep efficiency", s.score.sleep_efficiency_percentage);
          put(d, "Sleep consistency", s.score.sleep_consistency_percentage); put(d, "Respiratory rate", s.score.respiratory_rate); }
      }
      return Object.entries(rows).map(([date, values]) => ({ date, values }));
    },
  },
};
function env(p, which) { return process.env[`${p.toUpperCase()}_CLIENT_${which}`] || ""; }
const configured = (p) => !!(env(p, "ID") && env(p, "SECRET"));

module.exports = function connectors(app, d) {
  const { auth, dbGetMeta, dbSetMeta, S, pool, SECRET } = d;
  const API = (process.env.PUBLIC_API_URL || "https://biotrack-api-production.up.railway.app").replace(/\/$/, "");
  const WEB = (process.env.PUBLIC_WEB_URL || "https://bodydata.ai").replace(/\/$/, "");
  const redirectFor = (p) => `${API}/connect/${p}/callback`;
  const tokKey = (p) => "connector_secret_" + p, stKey = (p) => "connector_" + p;   // tokens vs public status

  // state = signed {user, provider, time, return}: the callback has no session, so this says who it's for
  const sign = (o) => { const b = Buffer.from(JSON.stringify(o)).toString("base64url"); return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
  const unsign = (s) => { const [b, sig] = String(s || "").split("."); if (!b || !sig) return null;
    const good = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const o = JSON.parse(Buffer.from(b, "base64url").toString()); return Date.now() - o.t < 15 * 60e3 ? o : null; };

  async function sectionFor(p) {
    const P = PROVIDERS[p], all = await S.getSections();
    const ex = all.find(s => s.source?.connector === p);
    if (ex) return ex;
    const sec = await S.saveSection({ name: P.section, description: P.about, schedule: "none", source: { type: "manual", app: P.name }, kpis: P.kpis });
    return await S.patchSection(sec.id, { source: { connector: p, noAI: P.ai !== "yes" } });
  }
  async function tokens(p) {
    const m = await dbGetMeta(); let t = m[tokKey(p)]; if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = null; } }
    if (!t?.access) return null;
    if (t.expires - Date.now() < 5 * 60e3) {   // refresh early; providers rotate the refresh token
      t = { ...t, ...(await PROVIDERS[p].refresh(t)) }; await dbSetMeta({ [tokKey(p)]: t });
    }
    return t;
  }
  async function sync(p, { full = false } = {}) {
    const P = PROVIDERS[p], m = await dbGetMeta(), st = m[stKey(p)] || {};
    try {
      const t = await tokens(p); if (!t) throw new Error("Not connected");
      const since = full || !st.newest ? Date.now() - 3 * 365 * 864e5 : new Date(st.newest).getTime() - 3 * 864e5;
      const rows = await P.pull(t, since);
      const sec = await sectionFor(p), byLabel = Object.fromEntries(sec.kpis.map(k => [k.label.toLowerCase(), k.key]));
      const r = await S.storeRows(sec, rows.map(x => ({ date: x.date, values: Object.fromEntries(Object.entries(x.values).map(([l, v]) => [byLabel[l.toLowerCase()], v]).filter(([k]) => k)) })), { all: true });
      await S.patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `${P.name}: ${r.days} day${r.days === 1 ? "" : "s"} synced` }, newest: r.newest });
      await dbSetMeta({ [stKey(p)]: { ...st, connected: true, lastSync: new Date().toISOString(), newest: r.newest || st.newest, error: null, section: sec.id } });
      return { ok: true, ...r, section: sec.id };
    } catch (e) {
      const needsLogin = !!e.auth || /refresh|invalid_grant|sign-in failed/i.test(e.message);
      await dbSetMeta({ [stKey(p)]: { ...st, lastSync: new Date().toISOString(), error: needsLogin ? `Reconnect ${P.name}: its sign-in expired.` : e.message.slice(0, 200), needsLogin } });
      throw e;
    }
  }

  app.get("/connect", auth, async (req, res) => {
    const m = await dbGetMeta();
    res.json({ providers: Object.entries(PROVIDERS).map(([id, P]) => { const st = m[stKey(id)] || {};
      return { id, name: P.name, about: P.about, available: configured(id), connected: !!m[tokKey(id)], lastSync: st.lastSync || null, newest: st.newest || null,
        error: st.error || null, ai: P.ai, aiAllowed: P.ai === "yes" || !!st.aiOptIn, section: st.section || null }; }) });
  });
  app.post("/connect/:p/start", auth, (req, res) => {
    const p = req.params.p, P = PROVIDERS[p]; if (!P) return res.status(404).json({ error: "Unknown service" });
    if (!configured(p)) return res.status(503).json({ error: `${P.name} isn't switched on yet.` });
    const state = sign({ u: req.userId, p, t: Date.now(), app: req.body?.app ? 1 : 0, n: crypto.randomBytes(6).toString("hex") });
    const u = new URL(P.authUrl);
    Object.entries({ response_type: "code", client_id: env(p, "ID"), scope: P.scope, redirect_uri: redirectFor(p), state, ...(req.body?.demo && p === "withings" ? { mode: "demo" } : {}) }).forEach(([k, v]) => u.searchParams.set(k, v));
    res.json({ url: u.toString() });
  });
  // The provider sends the browser back here (no BodyData session: the signed state says whose account)
  app.get("/connect/:p/callback", async (req, res) => {
    const p = req.params.p, P = PROVIDERS[p], st = unsign(req.query.state);
    const back = (ok, msg) => res.redirect(st?.app ? `bodydata://connected?service=${p}&ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}` : `${WEB}/dashboard?tab=automations&connected=${p}&ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`);
    if (!P || !st || st.p !== p) return res.status(400).send("This sign-in link expired. Go back to BodyData and tap Connect again.");
    if (req.query.error || !req.query.code) return back(false, `${P.name} access wasn't granted.`);
    await runAs(st.u, async () => {
      try {
        const t = await P.exchange(String(req.query.code), redirectFor(p));
        const m = await dbGetMeta();
        await dbSetMeta({ [tokKey(p)]: t, [stKey(p)]: { ...(m[stKey(p)] || {}), connected: true, connectedAt: new Date().toISOString(), error: null } });
        const r = await sync(p, { full: true }).catch(e => ({ error: e.message }));
        back(!r.error, r.error ? `Connected. First sync failed: ${r.error}` : `${P.name} connected: ${r.days} days imported.`);
      } catch (e) { back(false, e.message); }
    });
  });
  app.post("/connect/:p/sync", auth, async (req, res) => {
    if (!PROVIDERS[req.params.p]) return res.status(404).json({ error: "Unknown service" });
    try { res.json(await sync(req.params.p, { full: !!req.body?.full })); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // WHOOP-style terms: the member decides whether Ask AI may read this data
  app.post("/connect/:p/ai", auth, async (req, res) => {
    const p = req.params.p, P = PROVIDERS[p]; if (!P) return res.status(404).json({ error: "Unknown service" });
    if (P.ai === "no") return res.status(400).json({ error: `${P.name}'s terms don't allow AI use of its data.` });
    const m = await dbGetMeta(), allow = !!req.body?.allow;
    await dbSetMeta({ [stKey(p)]: { ...(m[stKey(p)] || {}), aiOptIn: allow } });
    const sec = (await S.getSections()).find(s => s.source?.connector === p); if (sec) await S.patchSection(sec.id, { source: { noAI: P.ai !== "yes" && !allow } });
    res.json({ ok: true, aiAllowed: P.ai === "yes" || allow });
  });
  app.post("/connect/:p/disconnect", auth, async (req, res) => {
    const p = req.params.p, P = PROVIDERS[p]; if (!P) return res.status(404).json({ error: "Unknown service" });
    const m = await dbGetMeta(), t = m[tokKey(p)];
    if (p === "whoop" && t?.access) await fetch("https://api.prod.whoop.com/developer/v2/user/access", { method: "DELETE", headers: { Authorization: "Bearer " + t.access } }).catch(() => {});
    await dbSetMeta({ [tokKey(p)]: "", [stKey(p)]: { ...(m[stKey(p)] || {}), connected: false } });
    let removed = 0;
    if (req.body?.purge) { const sec = (await S.getSections()).find(s => s.source?.connector === p);
      if (sec) { removed = (await pool.query(`DELETE FROM snapshots WHERE user_id = $1 AND data->>'_source' = $2`, [currentUser(), "section:" + sec.id])).rowCount; await S.putSections((await S.getSections()).filter(s => s.id !== sec.id)); d.invalidate(); } }
    res.json({ ok: true, removed });
  });

  // Hourly: pull every connected service (sync() refreshes tokens as needed)
  cron.schedule("23 * * * *", async () => {
    for (const uid of await d.allUsers().catch(() => [])) await runAs(uid, async () => {
      const m = await dbGetMeta();
      for (const p of Object.keys(PROVIDERS)) if (m[tokKey(p)] && configured(p)) {
        try { const r = await sync(p); if (r.stored) console.log(`[connect] ${uid} · ${p}: ${r.stored} days`); } catch (e) { console.error(`[connect] ${uid} · ${p}: ${e.message}`); d.onSyncError?.(uid, p, e.message); }
      }
    });
  }, { timezone: "UTC" });

  return { PROVIDERS, sync, sign, unsign };
};
Object.assign(module.exports, { PROVIDERS, dayOffset });
