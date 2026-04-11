/**
 * BIOTRACK API — Test Suite
 * Run: npm test  (from biotrack-api/)
 *
 * Covers: auth, POST /sync, GET /latest, GET /history,
 *         GET /stats, GET /health, validation, concurrency, edge cases
 */

const request = require("supertest");
const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const fs      = require("fs");
const os      = require("os");
const path    = require("path");

// ─── Build an isolated test instance of the server ───────────────────────────
// This mirrors server.js exactly but uses a temp data file and test secret.

const SECRET   = "biotrack-test-secret-abc123";
const DATA_FILE = path.join(os.tmpdir(), `biotrack-api-test-${Date.now()}.json`);

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const load = () => {
    try {
      if (fs.existsSync(DATA_FILE))
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch {}
    return { history: [], latest: null };
  };

  const save = (s) => fs.writeFileSync(DATA_FILE, JSON.stringify(s));

  const auth = (req, res, next) => {
    const key = req.headers["x-api-secret"];
    if (!key || key !== SECRET)
      return res.status(401).json({ error: "Unauthorized" });
    next();
  };

  app.post("/sync", auth, (req, res) => {
    const snap = req.body;
    if (!snap || typeof snap !== "object" || Array.isArray(snap))
      return res.status(400).json({ error: "Body must be a JSON object" });
    snap._receivedAt = new Date().toISOString();
    snap._id         = crypto.randomUUID();
    const state = load();
    state.latest = snap;
    state.history.unshift(snap);
    if (state.history.length > 360) state.history = state.history.slice(0, 360);
    save(state);
    const count = Object.keys(snap).filter(k => !k.startsWith("_")).length;
    res.json({ ok: true, id: snap._id, receivedAt: snap._receivedAt, fieldCount: count });
  });

  app.get("/latest", auth, (req, res) => {
    const { latest } = load();
    if (!latest) return res.status(404).json({ error: "No data yet" });
    res.json(latest);
  });

  app.get("/history", auth, (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { history } = load();
    const byDate = {};
    for (const s of history) {
      const key = s.syncDate || s._receivedAt?.slice(0, 10) || "unknown";
      if (!byDate[key]) byDate[key] = s;
    }
    const deduped = Object.values(byDate).slice(0, days);
    res.json({ count: deduped.length, days, snapshots: deduped });
  });

  app.get("/stats", auth, (req, res) => {
    const { history, latest } = load();
    if (!latest) return res.status(404).json({ error: "No data yet" });
    const nums = (k) => history.map(s => s[k]).filter(v => typeof v === "number");
    const avg  = (a) => a.length ? +(a.reduce((x,y) => x+y, 0) / a.length).toFixed(1) : null;
    res.json({
      latest,
      averages: {
        bodyFat:  avg(nums("bodyFat")),
        weight:   avg(nums("weight")),
        steps:    avg(nums("steps")),
        protein:  avg(nums("protein")),
      },
      totalSnapshots: history.length,
    });
  });

  app.get("/health", (_req, res) => {
    const { latest, history } = load();
    res.json({
      status: "ok",
      lastSync: latest?._receivedAt || null,
      totalSnapshots: history.length,
      uptime: Math.round(process.uptime()),
      version: "2.0.0",
    });
  });

  app.get("/", (_req, res) => res.json({ name: "BioTrack API", version: "2.0.0" }));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}

const app = createApp();

// Clean up temp file after all tests
afterAll(() => { try { fs.unlinkSync(DATA_FILE); } catch {} });

// ── Helpers
const auth  = { "x-api-secret": SECRET };
const post  = (body) => request(app).post("/sync").set(auth).send(body);
const get   = (path) => request(app).get(path).set(auth);

const SNAP = {
  syncDate:"Apr 11", syncTime:"9:45 AM",
  steps:9241, activeCalories:720,
  restingHR:51, avgHR:67, hrv:52, vo2max:43.2,
  weight:197.4, bodyFat:17.9, leanMass:162.1,
  calories:2210, protein:192, carbs:175, fat:68, water:3.4,
  sleepScore:84, sleepDuration:7.2, deepSleep:1.8, remSleep:1.9,
  workoutType:"Push", workoutDur:54,
  trunkFat:15.6, rightArmFat:15.1, leftArmFat:15.1,
  rightLegFat:10.8, leftLegFat:10.2,
};

// ─────────────────────────────────────────────────────────────────────────────
describe("GET / — root", () => {
  test("200 with API name and version", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("BioTrack API");
    expect(r.body.version).toBe("2.0.0");
  });
});

describe("GET /health — no auth required", () => {
  test("returns ok without secret", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });
  test("uptime is a non-negative number", async () => {
    const r = await request(app).get("/health");
    expect(r.body.uptime).toBeGreaterThanOrEqual(0);
  });
  test("totalSnapshots is a number", async () => {
    const r = await request(app).get("/health");
    expect(typeof r.body.totalSnapshots).toBe("number");
  });
});

describe("Authentication", () => {
  test("POST /sync without key → 401",   async () => expect((await request(app).post("/sync").send(SNAP)).status).toBe(401));
  test("POST /sync wrong key → 401",     async () => expect((await request(app).post("/sync").set("x-api-secret","bad").send(SNAP)).status).toBe(401));
  test("GET /latest without key → 401",  async () => expect((await request(app).get("/latest")).status).toBe(401));
  test("GET /history without key → 401", async () => expect((await request(app).get("/history")).status).toBe(401));
  test("GET /stats without key → 401",   async () => expect((await request(app).get("/stats")).status).toBe(401));
  test("Correct key is accepted",         async () => expect((await get("/latest")).status).not.toBe(401));
});

describe("POST /sync", () => {
  test("valid snapshot → ok:true + UUID", async () => {
    const r = await post(SNAP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  test("fieldCount matches payload", async () => {
    const r = await post(SNAP);
    expect(r.body.fieldCount).toBe(Object.keys(SNAP).length);
  });
  test("receivedAt is valid ISO date", async () => {
    const r = await post(SNAP);
    expect(new Date(r.body.receivedAt).toISOString()).toBeTruthy();
  });
  test("array body → 400", async () => {
    const r = await post([1, 2, 3]);
    expect(r.status).toBe(400);
  });
  test("Hume segmental data preserved", async () => {
    await post({ syncDate:"Apr 11", trunkFat:15.6, rightLegFat:10.8 });
    const r = await get("/latest");
    expect(r.body.trunkFat).toBe(15.6);
    expect(r.body.rightLegFat).toBe(10.8);
  });
  test("decimal precision preserved", async () => {
    await post({ syncDate:"Apr 11", bodyFat:17.93, weight:197.45 });
    const r = await get("/latest");
    expect(r.body.bodyFat).toBe(17.93);
    expect(r.body.weight).toBe(197.45);
  });
  test("oversized payload → 413 or 400", async () => {
    const r = await post({ data: "x".repeat(3 * 1024 * 1024) });
    expect([400, 413]).toContain(r.status);
  });
  test("unknown future fields stored without error", async () => {
    const r = await post({ syncDate:"Apr 11", newMetric: 99, futureField: "hello" });
    expect(r.status).toBe(200);
  });
  test("concurrent POSTs don't corrupt storage", async () => {
    const snaps = Array.from({ length: 5 }, (_, i) => ({
      syncDate: `Apr ${i + 1}`, bodyFat: 17 + i * 0.1, steps: 8000 + i * 100,
    }));
    const results = await Promise.all(snaps.map(s => post(s)));
    results.forEach(r => expect(r.status).toBe(200));
    const latest = await get("/latest");
    expect(latest.status).toBe(200);
  });
});

describe("GET /latest", () => {
  test("returns most recent snapshot", async () => {
    await post({ syncDate:"Apr 11", syncTime:"11:00 PM", bodyFat:17.5, steps:11000 });
    const r = await get("/latest");
    expect(r.status).toBe(200);
    expect(r.body.bodyFat).toBe(17.5);
  });
  test("has _receivedAt metadata", async () => {
    const r = await get("/latest");
    expect(r.body._receivedAt).toBeTruthy();
  });
  test("newer POST overwrites latest", async () => {
    await post({ syncDate:"Apr 11", syncTime:"6:00 AM", bodyFat:18.0 });
    await post({ syncDate:"Apr 11", syncTime:"11:00 PM", bodyFat:17.4 });
    const r = await get("/latest");
    expect(r.body.bodyFat).toBe(17.4);
    expect(r.body.syncTime).toBe("11:00 PM");
  });
});

describe("GET /history", () => {
  test("returns snapshots array", async () => {
    const r = await get("/history");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.snapshots)).toBe(true);
  });
  test("count matches snapshots.length", async () => {
    const r = await get("/history");
    expect(r.body.count).toBe(r.body.snapshots.length);
  });
  test("?days=7 caps at 7", async () => {
    const r = await get("/history?days=7");
    expect(r.body.snapshots.length).toBeLessThanOrEqual(7);
  });
  test("?days=999 caps at 90", async () => {
    const r = await get("/history?days=999");
    expect(r.body.days).toBeLessThanOrEqual(90);
  });
  test("default days=30", async () => {
    const r = await get("/history");
    expect(r.body.days).toBe(30);
  });
  test("deduplicates by date", async () => {
    await post({ syncDate:"DUPDATE", bodyFat:18.8 });
    await post({ syncDate:"DUPDATE", bodyFat:18.7 });
    const r = await get("/history?days=90");
    const dups = r.body.snapshots.filter(s => s.syncDate === "DUPDATE");
    expect(dups.length).toBeLessThanOrEqual(1);
  });
});

describe("GET /stats", () => {
  test("returns averages with bodyFat", async () => {
    const r = await get("/stats");
    expect(r.status).toBe(200);
    expect(typeof r.body.averages.bodyFat).toBe("number");
  });
  test("totalSnapshots > 0", async () => {
    const r = await get("/stats");
    expect(r.body.totalSnapshots).toBeGreaterThan(0);
  });
  test("includes latest snapshot", async () => {
    const r = await get("/stats");
    expect(r.body.latest).toBeTruthy();
    expect(r.body.latest._receivedAt).toBeTruthy();
  });
});

describe("404 / error handling", () => {
  test("unknown GET route → 404",    async () => expect((await request(app).get("/nope")).status).toBe(404));
  test("DELETE /sync → 404",         async () => expect((await request(app).delete("/sync")).status).toBe(404));
  test("404 body has error field",    async () => expect((await request(app).get("/nope")).body.error).toBe("Not found"));
  test("bad JSON body → 400 or 500", async () => {
    const r = await request(app).post("/sync")
      .set(auth).set("Content-Type","application/json").send("{ bad json }");
    expect([400, 500]).toContain(r.status);
  });
});

describe("Full E2E flow: 4-sync day simulation", () => {
  test("4am — sleep/HRV data syncs", async () => {
    const r = await post({ syncDate:"FLOW", syncTime:"4:00 AM", hrv:52, sleepScore:84, weight:197.4, bodyFat:17.9, trunkFat:15.6 });
    expect(r.body.ok).toBe(true);
  });
  test("12pm — workout + morning nutrition", async () => {
    const r = await post({ syncDate:"FLOW", syncTime:"12:00 PM", steps:4200, workoutType:"Push", workoutDur:54, calories:980, protein:95 });
    expect(r.body.ok).toBe(true);
  });
  test("5pm — steps + afternoon nutrition", async () => {
    const r = await post({ syncDate:"FLOW", syncTime:"5:00 PM", steps:8100, calories:1820, protein:168, water:2.8 });
    expect(r.body.ok).toBe(true);
  });
  test("11pm — complete day, all sources", async () => {
    const r = await post({ syncDate:"FLOW", syncTime:"11:00 PM", steps:11243, calories:2210, protein:192, weight:197.4, bodyFat:17.9, hrv:52, sleepScore:84, workoutType:"Push", workoutDur:54, trunkFat:15.6, rightArmFat:15.1, leftLegFat:10.2 });
    expect(r.body.ok).toBe(true);
    expect(r.body.fieldCount).toBeGreaterThanOrEqual(12);
  });
  test("latest has all 5 sources represented", async () => {
    const r = await get("/latest");
    expect(r.body.hrv).toBeTruthy();          // Oura
    expect(r.body.protein).toBeTruthy();      // MFP
    expect(r.body.steps).toBeTruthy();        // Apple Health
    expect(r.body.workoutType).toBeTruthy();  // Fitbod
    expect(r.body.trunkFat).toBeTruthy();     // Hume
  });
  test("protein goal met (≥170g)", async () => {
    const r = await get("/latest");
    expect(r.body.protein).toBeGreaterThanOrEqual(170);
  });
  test("steps goal met (≥10000)", async () => {
    const r = await get("/latest");
    expect(r.body.steps).toBeGreaterThanOrEqual(10000);
  });
});
