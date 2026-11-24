const F = require("./formula");
const days = [
  { _dateKey: "2026-11-01", weight: 180, bodyFat: 20, hrv: 40, steps: 8000 },
  { _dateKey: "2026-11-02", weight: 179, bodyFat: 19.5, hrv: 50, steps: 12000 },
  { _dateKey: "2026-11-03", weight: 178, hrv: 60 },
  { _dateKey: "2026-11-04", weight: 177, bodyFat: 19, hrv: 30, steps: 10000 },
];

test("arithmetic and precedence", () => {
  expect(F.evaluate("1 + 2 * 3 ^ 2", days.slice(0, 1))[0].value).toBe(19);
  expect(F.evaluate("-(2 - 5)", days.slice(0, 1))[0].value).toBe(3);
});
test("lean mass from weight and body fat; skips days missing an input", () => {
  const r = F.evaluate("weight * (1 - bodyFat / 100)", days);
  expect(r.map(x => x.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-04"]);
  expect(r[0].value).toBe(144);
});
test("rolling functions", () => {
  expect(F.evaluate("avg(hrv, 2)", days).map(x => x.value)).toEqual([40, 45, 55, 45]);
  expect(F.evaluate("sum(steps, 7)", days).slice(-1)[0].value).toBe(30000);
  expect(F.evaluate("count(bodyFat, 7)", days).slice(-1)[0].value).toBe(3);
  expect(F.evaluate("delta(weight, 3)", days).slice(-1)[0].value).toBe(-3);
  expect(F.evaluate("pct_change(weight, 3)", days).slice(-1)[0].value).toBeCloseTo(-1.667, 2);
  expect(F.evaluate("prev(bodyFat)", days).map(x => x.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
});
test("functions and if", () => {
  expect(F.evaluate("max(hrv, 45)", days).map(x => x.value)).toEqual([45, 50, 60, 45]);
  expect(F.evaluate("if(steps - 9000, 1, 0)", days).map(x => x.value)).toEqual([0, 1, 1]);
});
test("division by zero is skipped, not Infinity", () => {
  expect(F.evaluate("weight / (hrv - hrv)", days)).toEqual([]);
});
test("variables lists every input", () => {
  expect([...F.variables(F.parse("avg(hrv, 7) / weight + bodyFat"))].sort()).toEqual(["bodyFat", "hrv", "weight"]);
});
test("rejects unsafe or invalid input", () => {
  for (const bad of ["process.exit()", "weight;", "constructor('x')", "avg(7, hrv)", "foo(1)", "1 +", "avg(hrv, 9999)", "`x`"]) expect(() => F.parse(bad)).toThrow();
});
