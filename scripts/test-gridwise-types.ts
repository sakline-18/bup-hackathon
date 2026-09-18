import {
  BatteryInputSchema,
  DirectiveInterpretationSchema,
  HourInputSchema,
  HourlyPlanEntrySchema,
  OptimizeEnergyRequestSchema,
  OptimizeEnergyResponseSchema,
} from "../types/gridwise.ts";

let failures = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures++;
  }
}

function makeHour(hour: number) {
  return { hour, demand_kwh: 10, solar_kwh: 2, tariff_bdt_per_kwh: 8.5 };
}

const battery = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 20,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

const hours24 = Array.from({ length: 24 }, (_, h) => makeHour(h));

console.log("HourInputSchema");
check("accepts a valid hour", HourInputSchema.safeParse(makeHour(5)).success);
check("rejects hour 24 (out of 0-23 range)", !HourInputSchema.safeParse(makeHour(24)).success);
check("rejects hour -1", !HourInputSchema.safeParse(makeHour(-1)).success);
check("rejects non-integer hour", !HourInputSchema.safeParse(makeHour(5.5)).success);

console.log("BatteryInputSchema");
check("accepts a valid battery spec", BatteryInputSchema.safeParse(battery).success);
check("rejects a battery spec missing a field", !BatteryInputSchema.safeParse({ ...battery, capacity_kwh: undefined }).success);

console.log("OptimizeEnergyRequestSchema");
const validRequest = {
  scenario_id: "scenario-1",
  operator_notes: ["Reduce solar output by 80% between 1 PM and 3 PM."],
  hours: hours24,
  battery,
};
check("accepts a valid request", OptimizeEnergyRequestSchema.safeParse(validRequest).success);
check("rejects fewer than 24 hours", !OptimizeEnergyRequestSchema.safeParse({ ...validRequest, hours: hours24.slice(0, 23) }).success);
check("rejects zero operator notes", !OptimizeEnergyRequestSchema.safeParse({ ...validRequest, operator_notes: [] }).success);
check("rejects more than 3 operator notes", !OptimizeEnergyRequestSchema.safeParse({ ...validRequest, operator_notes: ["a", "b", "c", "d"] }).success);

console.log("DirectiveInterpretationSchema");
check(
  "accepts a no_op directive with null adjustment",
  DirectiveInterpretationSchema.safeParse({
    note_index: 0,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: "Irrelevant note.",
  }).success,
);
check(
  "accepts a solar_reduction directive with an adjustment object",
  DirectiveInterpretationSchema.safeParse({
    note_index: 0,
    applies: true,
    directive_type: "solar_reduction",
    structured_adjustment: { hours: [13, 14], factor: 0.2 },
    explanation: "80% reduction from 1 PM to 3 PM.",
  }).success,
);
check(
  "rejects an unknown directive_type",
  !DirectiveInterpretationSchema.safeParse({
    note_index: 0,
    applies: true,
    directive_type: "not_a_real_directive",
    structured_adjustment: null,
    explanation: "x",
  }).success,
);

console.log("HourlyPlanEntrySchema");
check(
  "accepts a valid plan entry",
  HourlyPlanEntrySchema.safeParse({
    hour: 0,
    grid_kwh: 5,
    solar_used_kwh: 0,
    battery_action: "idle",
    battery_kwh: 0,
    battery_energy_after_kwh: 100,
  }).success,
);
check(
  "rejects an invalid battery_action",
  !HourlyPlanEntrySchema.safeParse({
    hour: 0,
    grid_kwh: 5,
    solar_used_kwh: 0,
    battery_action: "sleeping",
    battery_kwh: 0,
    battery_energy_after_kwh: 100,
  }).success,
);

console.log("OptimizeEnergyResponseSchema");
const validResponse = {
  scenario_id: "scenario-1",
  directive_interpretation: [
    {
      note_index: 0,
      applies: true,
      directive_type: "solar_reduction",
      structured_adjustment: { hours: [13, 14], factor: 0.2 },
      explanation: "80% reduction from 1 PM to 3 PM.",
    },
  ],
  hourly_plan: hours24.map((h) => ({
    hour: h.hour,
    grid_kwh: 5,
    solar_used_kwh: 0,
    battery_action: "idle" as const,
    battery_kwh: 0,
    battery_energy_after_kwh: 100,
  })),
  total_grid_kwh: 120,
  total_cost_bdt: 1020,
  peak_grid_kwh: 8,
  plan_summary: "Battery held steady overnight; grid covered baseline demand.",
};
check("accepts a valid response", OptimizeEnergyResponseSchema.safeParse(validResponse).success);
check("rejects a response with fewer than 24 hourly_plan entries", !OptimizeEnergyResponseSchema.safeParse({ ...validResponse, hourly_plan: validResponse.hourly_plan.slice(0, 10) }).success);

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("All gridwise type-contract checks passed.");
}
