// Connector parsing against the documented response shapes (fetch mocked)
process.env.USER_TZ = "America/New_York";
process.env.WITHINGS_CLIENT_ID = "id"; process.env.WITHINGS_CLIENT_SECRET = "sec";
process.env.WHOOP_CLIENT_ID = "id"; process.env.WHOOP_CLIENT_SECRET = "sec";
const C = require("./connectors");
const { PROVIDERS, dayOffset } = C;
const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
afterEach(() => { delete global.fetch; });

test("Withings measures: units decoded, kg → lb, local day, last weigh-in wins, BP averaged", async () => {
  const calls = [];
  global.fetch = async (url, opt) => {
    const p = Object.fromEntries(new URLSearchParams(opt.body)); calls.push([String(url), p]);
    if (p.action === "getmeas") return json({ status: 0, body: { timezone: "America/New_York", more: 0, measuregrps: [
      { date: Date.UTC(2026, 10, 20, 12) / 1000, measures: [{ value: 8000, type: 1, unit: -2 }, { value: 185, type: 6, unit: -1 }] },
      { date: Date.UTC(2026, 10, 20, 23) / 1000, measures: [{ value: 8100, type: 1, unit: -2 }, { value: 120, type: 10, unit: 0 }] },
      { date: Date.UTC(2026, 10, 21, 2) / 1000, measures: [{ value: 130, type: 10, unit: 0 }] },   // 9pm Nov 20 in New York
    ] } });
    if (p.action === "getactivity") return json({ status: 0, body: { more: false, activities: [{ date: "2026-11-20", steps: 9000, calories: 400 }] } });
  };
  const rows = await PROVIDERS.withings.pull({ access: "x" }, Date.UTC(2026, 10, 1));
  const d = rows.find(r => r.date === "2026-11-20").values;
  expect(d.Weight).toBeCloseTo(81 * 2.20462, 1);
  expect(d["Body fat"]).toBe(18.5);
  expect(d["Systolic blood pressure"]).toBe(125);
  expect(d.Steps).toBe(9000);
  expect(rows.some(r => r.date === "2026-11-21")).toBe(false);
  expect(calls[0][0]).toBe("https://wbsapi.withings.net/measure");
});

test("Withings error status raises, 401-type marks reconnect", async () => {
  global.fetch = async () => json({ status: 401 });
  await expect(PROVIDERS.withings.pull({ access: "x" }, 0)).rejects.toMatchObject({ auth: true });
});

test("Withings token exchange", async () => {
  global.fetch = async (url, opt) => { const p = Object.fromEntries(new URLSearchParams(opt.body));
    expect(p).toMatchObject({ action: "requesttoken", grant_type: "authorization_code", code: "abc", client_id: "id" });
    return json({ status: 0, body: { access_token: "A", refresh_token: "R", expires_in: 10800, userid: 5 } }); };
  const t = await PROVIDERS.withings.exchange("abc", "https://x/cb");
  expect(t).toMatchObject({ access: "A", refresh: "R", account: "5" });
});

test("WHOOP: recovery on the wake-up day, sleep stages summed incl. naps, pagination followed", async () => {
  let pages = 0;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/v2/cycle")) return json({ records: [{ id: 1, start: "2026-11-20T04:30:00.000Z", end: "2026-11-21T05:15:00.000Z", timezone_offset: "-05:00", score_state: "SCORED", score: { strain: 12.3, kilojoule: 8368, average_heart_rate: 70 } }] });
    if (u.pathname.endsWith("/v2/recovery")) { pages++;
      if (!u.searchParams.get("nextToken")) return json({ records: [], next_token: "p2" });
      return json({ records: [{ cycle_id: 1, created_at: "2026-11-20T12:00:00Z", score_state: "SCORED", score: { recovery_score: 66, hrv_rmssd_milli: 55.5, resting_heart_rate: 50, spo2_percentage: 96, skin_temp_celsius: 33.4 } }] }); }
    if (u.pathname.endsWith("/v2/activity/sleep")) return json({ records: [
      { end: "2026-11-21T11:00:00Z", timezone_offset: "-05:00", nap: false, score_state: "SCORED", score: { respiratory_rate: 15, sleep_performance_percentage: 90, sleep_efficiency_percentage: 92, sleep_consistency_percentage: 80, stage_summary: { total_light_sleep_time_milli: 3 * 3600e3, total_slow_wave_sleep_time_milli: 1.5 * 3600e3, total_rem_sleep_time_milli: 2 * 3600e3, disturbance_count: 4 } } },
      { end: "2026-11-21T19:00:00Z", timezone_offset: "-05:00", nap: true, score_state: "SCORED", score: { sleep_performance_percentage: 10, stage_summary: { total_light_sleep_time_milli: 0.5 * 3600e3, disturbance_count: 1 } } },
      { end: "2026-11-22T11:00:00Z", timezone_offset: "-05:00", score_state: "PENDING_SCORE" },
    ] });
  };
  const rows = await PROVIDERS.whoop.pull({ access: "x" }, Date.UTC(2026, 10, 1));
  const d = rows.find(r => r.date === "2026-11-20").values, s = rows.find(r => r.date === "2026-11-21").values;
  expect(pages).toBe(2);
  expect(d).toMatchObject({ Recovery: 66, HRV: 55.5, "Resting heart rate": 50, "Day strain": 12.3, "Energy burned": 2000 });
  expect(s["Time asleep"]).toBe(7);          // 6.5 h night + 0.5 h nap
  expect(s["Sleep performance"]).toBe(90);   // the nap doesn't overwrite night scores
  expect(s["Sleep disturbances"]).toBe(5);
  expect(rows.some(r => r.date === "2026-11-22")).toBe(false);   // unscored sleep skipped
});

test("dayOffset shifts by the provider's UTC offset", () => {
  expect(dayOffset("2026-11-21T03:30:00Z", "-05:00")).toBe("2026-11-20");
  expect(dayOffset("2026-11-21T22:30:00Z", "+02:00")).toBe("2026-11-22");
});

test("OAuth state is signed, tamper-proof and expires", () => {
  const app = { get() {}, post() {} };
  const c = C(app, { auth: () => {}, SECRET: "s3cret", S: {}, dbGetMeta: async () => ({}), dbSetMeta: async () => {}, allUsers: async () => [] });
  const st = c.sign({ u: "owner", p: "withings", t: Date.now() });
  expect(c.unsign(st)).toMatchObject({ u: "owner" });
  const [b, sig] = st.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "someone_else", p: "withings", t: Date.now() })).toString("base64url") + "." + sig;
  expect(c.unsign(forged)).toBeNull();
  expect(c.unsign(c.sign({ u: "owner", t: Date.now() - 20 * 60e3 }))).toBeNull();
});
