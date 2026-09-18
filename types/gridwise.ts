import { z } from "zod";

export const DirectiveTypeSchema = z.enum([
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
]);
export type DirectiveType = z.infer<typeof DirectiveTypeSchema>;

export const BatteryActionSchema = z.enum(["charge", "discharge", "idle"]);
export type BatteryAction = z.infer<typeof BatteryActionSchema>;

export const HourInputSchema = z.object({
  hour: z.number().int().min(0).max(23),
  demand_kwh: z.number().nonnegative(),
  solar_kwh: z.number().nonnegative(),
  tariff_bdt_per_kwh: z.number().nonnegative(),
});
export type HourInput = z.infer<typeof HourInputSchema>;

export const BatteryInputSchema = z
  .object({
    capacity_kwh: z.number().nonnegative(),
    initial_energy_kwh: z.number().nonnegative(),
    minimum_energy_kwh: z.number().nonnegative(),
    max_charge_kwh_per_hour: z.number().nonnegative(),
    max_discharge_kwh_per_hour: z.number().nonnegative(),
  })
  // 0 <= minimum <= initial <= capacity, or the LP is infeasible before any directive.
  .refine(
    (b) =>
      b.minimum_energy_kwh <= b.initial_energy_kwh &&
      b.initial_energy_kwh <= b.capacity_kwh,
    { message: "require minimum_energy_kwh <= initial_energy_kwh <= capacity_kwh" },
  );
export type BatteryInput = z.infer<typeof BatteryInputSchema>;

export const OptimizeEnergyRequestSchema = z.object({
  scenario_id: z.string(),
  operator_notes: z.array(z.string().trim().min(1)).min(1).max(3),
  hours: z
    .array(HourInputSchema)
    .length(24)
    .refine((hs) => new Set(hs.map((h) => h.hour)).size === 24, {
      message: "hours must cover 0-23 exactly once each",
    }),
  battery: BatteryInputSchema,
});
export type OptimizeEnergyRequest = z.infer<typeof OptimizeEnergyRequestSchema>;

export const DirectiveInterpretationSchema = z.object({
  note_index: z.number().int().min(0),
  applies: z.boolean(),
  directive_type: DirectiveTypeSchema,
  structured_adjustment: z.record(z.string(), z.unknown()).nullable(),
  explanation: z.string(),
});
export type DirectiveInterpretation = z.infer<typeof DirectiveInterpretationSchema>;

export const HourlyPlanEntrySchema = z.object({
  hour: z.number().int().min(0).max(23),
  grid_kwh: z.number(),
  solar_used_kwh: z.number(),
  battery_action: BatteryActionSchema,
  battery_kwh: z.number(),
  battery_energy_after_kwh: z.number(),
});
export type HourlyPlanEntry = z.infer<typeof HourlyPlanEntrySchema>;

export const OptimizeEnergyResponseSchema = z.object({
  scenario_id: z.string(),
  directive_interpretation: z.array(DirectiveInterpretationSchema),
  hourly_plan: z.array(HourlyPlanEntrySchema).length(24),
  total_grid_kwh: z.number(),
  total_cost_bdt: z.number(),
  peak_grid_kwh: z.number(),
  plan_summary: z.string(),
});
export type OptimizeEnergyResponse = z.infer<typeof OptimizeEnergyResponseSchema>;
