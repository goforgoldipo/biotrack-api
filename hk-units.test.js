// Apple Health "%" values arrive from the iPhone app already as percents (0.18 → 18).
// mapImport must not rescale small real values (walking asymmetry is often < 1.5 %).
// shared/kpi.mjs is ESM, so evaluate it in a child node process rather than via jest's CJS loader.
const { execFileSync } = require("child_process");
const path = require("path");

function mapImport(payload) {
  const url = "file://" + path.join(__dirname, "shared", "kpi.mjs");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { mapImport } = await import(${JSON.stringify(url)});
     process.stdout.write(JSON.stringify(mapImport(JSON.parse(process.argv[1]))));`,
    JSON.stringify(payload)], { encoding: "utf8" });
  return JSON.parse(out);
}

describe("Apple Health percent units", () => {
  const meta = { hk_walkingAsymmetryPercentage: ["%", "avg"], hk_oxygenSaturation: ["%", "avg"] };

  test("small walking asymmetry stays as sent (0.714 % is not 71.4 %)", () => {
    const m = mapImport({ hk_walkingAsymmetryPercentage: 0.714, hkMeta: meta });
    expect(m.hk_walkingAsymmetryPercentage).toBe(0.714);
  });

  test("normal percent values pass through unchanged", () => {
    const m = mapImport({ hk_walkingAsymmetryPercentage: 4.286, hk_oxygenSaturation: 97, hkMeta: meta });
    expect(m.hk_walkingAsymmetryPercentage).toBe(4.286);
    expect(m.hk_oxygenSaturation).toBe(97);
  });

  test("sleepDuration maps to sleepDur", () => {
    expect(mapImport({ sleepDuration: 7.5 }).sleepDur).toBe(7.5);
  });
});
