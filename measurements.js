// ─────────────────────────────────────────────────────────────────
//  Body measurements (tape measure, body-scan reports, coach emails).
//  Values are stored in inches on a snapshot { syncDate, _source: "measurements" }, so they
//  merge into that day and show on the dashboard's BODY MEASUREMENTS group like any metric.
//    POST /measurements/extract  { text?, attachment?: { data(base64), mediaType, filename } }
//                                → { draft: { date, values(in), original, unit, notes, source } }  (AI reads it; nothing saved)
//    POST /measurements          { date, values (inches), source?, note? }   → saves one entry
//    GET  /measurements          → { sites, entries: [{ id, date, loggedAt, source, values, note }] } newest first
//    POST /measurements/:id/delete
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const { currentUser } = require("./tenancy");

const SITES = [
  ["neckIn", "Neck"], ["shouldersIn", "Shoulders"], ["chestIn", "Chest"], ["waistIn", "Waist"], ["hipsIn", "Hips"],
  ["leftBicepIn", "Left Bicep"], ["rightBicepIn", "Right Bicep"], ["leftForearmIn", "Left Forearm"], ["rightForearmIn", "Right Forearm"],
  ["leftThighIn", "Left Thigh"], ["rightThighIn", "Right Thigh"], ["leftCalfIn", "Left Calf"], ["rightCalfIn", "Right Calf"],
];
const KEYS = new Set(SITES.map(s => s[0]));
// Plausible adult range in inches per site (catches cm typed into an inches box)
const RANGE = (k) => /neck/i.test(k) ? [8, 30] : /Bicep|Forearm|Calf/.test(k) ? [4, 30] : /Thigh/.test(k) ? [10, 45] : [15, 75];
const r2 = (x) => Math.round(x * 100) / 100;

const TOOL = {
  name: "record_measurements",
  description: "Record the body circumference measurements found in the user's text, photo or document.",
  input_schema: {
    type: "object",
    properties: {
      date: { type: ["string", "null"], description: "Date the measurements were TAKEN, YYYY-MM-DD, if stated or clearly implied (e.g. the email date the report was sent). null if unknown." },
      unit: { type: "string", enum: ["cm", "in"], description: "Unit the numbers are written in." },
      source: { type: ["string", "null"], description: "Who/what took them, e.g. 'DexaFit', 'Tape measure', 'Coach'. null if unknown." },
      values: {
        type: "object", additionalProperties: false,
        description: "Circumference per site in `unit`. Use left/right keys when sides are given; if only one value is given for a paired site, put it in BOTH sides only when the text says it applies to both, otherwise in the right side. Omit sites that aren't measured.",
        properties: Object.fromEntries(SITES.map(([k, l]) => [k, { type: "number", description: l }])),
      },
      notes: { type: "object", additionalProperties: { type: "string" }, description: "Landmark notes per key, e.g. { neckIn: 'Above Adam's apple' }." },
      unrecognized: { type: "array", items: { type: "string" }, description: "Measurements present that don't fit any key (e.g. 'Wrist 17 cm')." },
    },
    required: ["unit", "values"],
  },
};

module.exports = function measurements(app, { auth, pool, Usage, getKey, invalidate, model }) {
  // ── AI read → draft (nothing stored) ──
  app.post("/measurements/extract", auth, async (req, res) => {
    try {
      const { text, attachment: att } = req.body || {};
      const content = [];
      if (att?.data) {
        const mt = att.mediaType || "";
        if (mt === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: mt, data: att.data } });
        else if (/^image\/(png|jpeg|webp|gif)$/.test(mt)) content.push({ type: "image", source: { type: "base64", media_type: mt, data: att.data } });
        else return res.status(400).json({ error: "Attach a photo (JPG, PNG, WebP) or a PDF." });
      }
      if (typeof text === "string" && text.trim()) content.push({ type: "text", text: text.slice(0, 20000) });
      if (!content.length) return res.status(400).json({ error: "Paste your measurements or attach a photo or PDF." });
      const key = await getKey();
      if (!key) return res.status(503).json({ error: "AI is temporarily unavailable. Please try again later." });
      await Usage.checkBudget();
      const today = new Date().toISOString().slice(0, 10);
      content.push({ type: "text", text: `Today is ${today}. Read the body measurements above and call record_measurements. Copy numbers exactly; don't convert units.` });
      const msg = await Usage.client(key, "measurements").messages.create({
        model, max_tokens: 2000, tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content }],
      });
      const out = msg.content.find(b => b.type === "tool_use")?.input;
      if (!out) return res.status(422).json({ error: "Couldn't find measurements in that. Try typing them in." });
      const f = out.unit === "cm" ? 1 / 2.54 : 1;
      const values = {}, original = {};
      for (const [k, v] of Object.entries(out.values || {})) if (KEYS.has(k) && typeof v === "number" && v > 0) { values[k] = r2(v * f); original[k] = v; }
      if (!Object.keys(values).length) return res.status(422).json({ error: "Couldn't find any measurements in that. Try typing them in." });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") && out.date <= today ? out.date : null;
      res.json({ draft: { date, unit: out.unit, values, original, source: out.source || null, notes: out.notes || {}, unrecognized: out.unrecognized || [] } });
    } catch (e) { res.status(e.status === 429 ? 429 : 500).json({ error: e.message, code: e.code }); }
  });

  // ── Save one entry ──
  app.post("/measurements", auth, async (req, res) => {
    try {
      const b = req.body || {};
      const date = String(b.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return res.status(400).json({ error: "Pick the date the measurements were taken." });
      const vals = {};
      for (const [k, v] of Object.entries(b.values || {})) {
        const n = Number(v);
        if (!KEYS.has(k) || v === "" || v == null) continue;
        const [lo, hi] = RANGE(k);
        if (!isFinite(n) || n < lo || n > hi) return res.status(400).json({ error: `${SITES.find(s => s[0] === k)[1]} looks off (${v} in).` + (isFinite(n) && n / 2.54 >= lo && n / 2.54 <= hi ? ` If that's cm, it's ${r2(n / 2.54)} in.` : " Check the unit.") });
        vals[k] = r2(n);
      }
      if (!Object.keys(vals).length) return res.status(400).json({ error: "Enter at least one measurement." });
      const now = new Date().toISOString();
      const snap = { syncDate: date, _source: "measurements", _receivedAt: now, _id: crypto.randomUUID(), ...vals,
        _measureSource: String(b.source || "").slice(0, 60) || null, _measureNote: String(b.note || "").slice(0, 500) || null };
      const { rows } = await pool.query(`INSERT INTO snapshots (received_at, sync_date, data, user_id) VALUES ($1, $2, $3, $4) RETURNING id`, [now, date, JSON.stringify(snap), currentUser()]);
      invalidate();
      res.json({ ok: true, id: String(rows[0].id), date, loggedAt: now, values: vals });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── History (dedicated entries + older manual uploads that included measurements) ──
  app.get("/measurements", auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, received_at, sync_date, data FROM snapshots WHERE user_id = $1 AND (data->>'_source' = 'measurements' OR (${[...KEYS].map(k => `data ? '${k}'`).join(" OR ")})) ORDER BY received_at DESC LIMIT 1000`,
        [currentUser()]);
      const entries = rows.map(r => {
        const d = r.data, values = {};
        for (const k of KEYS) if (typeof d[k] === "number") values[k] = d[k];
        return { id: String(r.id), date: (r.sync_date || d.syncDate || "").slice(0, 10) || null, loggedAt: r.received_at, source: d._measureSource || (d._source === "measurements" ? null : (d._source || "Upload")), note: d._measureNote || null, values, deletable: d._source === "measurements" };
      }).filter(e => Object.keys(e.values).length)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || new Date(b.loggedAt) - new Date(a.loggedAt));
      res.json({ sites: SITES.map(([key, label]) => ({ key, label })), entries });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/measurements/:id/delete", auth, async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "No such entry" });
      const r = await pool.query(`DELETE FROM snapshots WHERE id = $1 AND user_id = $2 AND data->>'_source' = 'measurements'`, [req.params.id, currentUser()]);
      invalidate();
      res.json({ ok: true, removed: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { SITES };
};
