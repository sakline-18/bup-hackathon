// Runs every case in tests.json against a running GridWise server and checks
// the directive interpretation, total cost (±0.01 BDT) and end-of-day battery.
//   npm run test:samples                      -> http://localhost:3000
//   BASE_URL=https://your-app.vercel.app npm run test:samples
import fs from "node:fs";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const { cases } = JSON.parse(fs.readFileSync(new URL("../tests.json", import.meta.url), "utf8"));

// Compare adjustments ignoring key order and hour order.
const norm = (a) =>
  a &&
  Object.fromEntries(
    Object.keys(a)
      .sort()
      .map((k) => [k, k === "hours" ? [...a[k]].sort((x, y) => x - y) : a[k]]),
  );

let passed = 0;
for (const c of cases) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/optimize-energy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c.input),
  });
  const ms = Date.now() - started;
  const problems = [];

  if (res.status !== 200) {
    problems.push(`HTTP ${res.status}`);
  } else {
    const got = await res.json();
    const exp = c.expected_output;

    exp.directive_interpretation.forEach((e, i) => {
      const d = got.directive_interpretation[i];
      const same =
        d &&
        d.applies === e.applies &&
        d.directive_type === e.directive_type &&
        JSON.stringify(norm(d.structured_adjustment)) === JSON.stringify(norm(e.structured_adjustment));
      if (!same) {
        problems.push(
          `note ${i}: got ${d?.directive_type} ${JSON.stringify(d?.structured_adjustment)}, ` +
            `expected ${e.directive_type} ${JSON.stringify(e.structured_adjustment)}`,
        );
      }
    });

    if (Math.abs(got.total_cost_bdt - exp.total_cost_bdt) > 0.01) {
      problems.push(`cost ${got.total_cost_bdt}, expected ${exp.total_cost_bdt}`);
    }
    if (got.hourly_plan.at(-1).battery_energy_after_kwh !== c.input.battery.initial_energy_kwh) {
      problems.push("battery does not return to its initial energy");
    }
  }

  console.log(`${problems.length ? "FAIL" : "PASS"}  ${c.id}  ${c.label}  (${ms} ms)`);
  problems.forEach((p) => console.log(`      ${p}`));
  if (!problems.length) passed++;
}

console.log(`\n${passed}/${cases.length} passed against ${BASE_URL}`);
process.exit(passed === cases.length ? 0 : 1);
