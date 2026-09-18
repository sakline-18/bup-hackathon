import solver from "javascript-lp-solver";
import type {
  BatteryInput,
  DirectiveInterpretation,
  HourInput,
  HourlyPlanEntry,
} from "../../types/gridwise";

const HOURS = 24;
const EPS = 1e-4;
const BATTERY_ACTION_PENALTY = 0.0001;

type LpConstraintBound = { min?: number; max?: number; equal?: number };
type LpModel = {
  optimize: string;
  opType: "min" | "max";
  constraints: Record<string, LpConstraintBound>;
  variables: Record<string, Record<string, number>>;
};
type LpResult = { feasible?: boolean; result?: number } & Record<
  string,
  number | boolean | undefined
>;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// Directive adjustments were already shape-checked by the guardrail layer
// (src/services/guardrail.ts); this only extracts the numbers/windows the
// solver needs and never throws on a malformed one.
function collectHourSet(hours: unknown): number[] {
  if (!Array.isArray(hours)) return [];
  return hours.filter(
    (h): h is number => Number.isInteger(h) && h >= 0 && h < HOURS,
  );
}

interface DirectiveState {
  solarFactor: number[];
  minReserve: number[];
  noCharge: boolean[];
  noDischarge: boolean[];
  maxGrid: number[];
}

function buildDirectiveState(
  directives: DirectiveInterpretation[],
): DirectiveState {
  const solarFactor = Array<number>(HOURS).fill(1);
  const minReserve = Array<number>(HOURS).fill(0);
  const noCharge = Array<boolean>(HOURS).fill(false);
  const noDischarge = Array<boolean>(HOURS).fill(false);
  const maxGrid = Array<number>(HOURS).fill(Infinity);

  for (const directive of directives ?? []) {
    if (!directive || !directive.applies || directive.directive_type === "no_op") {
      continue;
    }
    const adj = directive.structured_adjustment;
    if (!adj || typeof adj !== "object") continue;

    switch (directive.directive_type) {
      case "solar_reduction": {
        const factor = adj.factor;
        if (typeof factor !== "number" || !Number.isFinite(factor)) break;
        // Guardrail guarantees `hours`; only those hours are affected.
        for (const h of collectHourSet(adj.hours)) solarFactor[h] *= factor;
        break;
      }
      case "minimum_battery_reserve": {
        const reserve = adj.minimum_energy_kwh;
        if (typeof reserve !== "number" || !Number.isFinite(reserve)) break;
        for (const h of collectHourSet(adj.hours)) {
          minReserve[h] = Math.max(minReserve[h], reserve);
        }
        break;
      }
      case "no_charge_window": {
        for (const h of collectHourSet(adj.hours)) noCharge[h] = true;
        break;
      }
      case "no_discharge_window": {
        for (const h of collectHourSet(adj.hours)) noDischarge[h] = true;
        break;
      }
      case "max_grid_window": {
        const cap = adj.max_grid_kwh;
        if (typeof cap !== "number" || !Number.isFinite(cap)) break;
        for (const h of collectHourSet(adj.hours)) {
          maxGrid[h] = Math.min(maxGrid[h], cap);
        }
        break;
      }
    }
  }

  return { solarFactor, minReserve, noCharge, noDischarge, maxGrid };
}

export function optimizeSchedule(
  hours: HourInput[],
  battery: BatteryInput,
  directives: DirectiveInterpretation[],
): HourlyPlanEntry[] {
  if (!Array.isArray(hours) || hours.length !== HOURS) {
    throw new Error(
      `optimizeSchedule: expected exactly ${HOURS} hourly inputs, got ${hours?.length ?? 0}`,
    );
  }

  const sortedHours = [...hours].sort((a, b) => a.hour - b.hour);
  for (let h = 0; h < HOURS; h++) {
    if (sortedHours[h].hour !== h) {
      throw new Error(
        `optimizeSchedule: hours input must cover exactly 0-23 once each; missing or duplicate hour near index ${h}`,
      );
    }
  }

  const { solarFactor, minReserve, noCharge, noDischarge, maxGrid } =
    buildDirectiveState(directives);

  const model: LpModel = {
    optimize: "cost",
    opType: "min",
    constraints: {},
    variables: {},
  };

  const v = (name: string): Record<string, number> => {
    let entry = model.variables[name];
    if (!entry) {
      entry = {};
      model.variables[name] = entry;
    }
    return entry;
  };

  const effectiveSolarAt = (h: number): number =>
    Math.max(0, sortedHours[h].solar_kwh * solarFactor[h]);

  for (let h = 0; h < HOURS; h++) {
    const hourInput = sortedHours[h];
    const reserve = Math.max(battery.minimum_energy_kwh, minReserve[h]);

    // Objective + energy balance: g_h + s_h + d_h - c_h = demand_kwh
    v(`g${h}`).cost = hourInput.tariff_bdt_per_kwh;
    v(`g${h}`)[`balance${h}`] = 1;

    v(`s${h}`).cost = 0;
    v(`s${h}`)[`balance${h}`] = 1;
    v(`s${h}`)[`solarCap${h}`] = 1;
    model.constraints[`solarCap${h}`] = { max: effectiveSolarAt(h) };

    v(`d${h}`).cost = BATTERY_ACTION_PENALTY;
    v(`d${h}`)[`balance${h}`] = 1;

    v(`c${h}`).cost = BATTERY_ACTION_PENALTY;
    v(`c${h}`)[`balance${h}`] = -1;

    model.constraints[`balance${h}`] = { equal: hourInput.demand_kwh };

    // Charge / discharge rate limits (zeroed under a no_charge/no_discharge directive)
    const maxCharge = noCharge[h] ? 0 : battery.max_charge_kwh_per_hour;
    const maxDischarge = noDischarge[h] ? 0 : battery.max_discharge_kwh_per_hour;
    v(`c${h}`)[`chargeLim${h}`] = 1;
    model.constraints[`chargeLim${h}`] = { max: maxCharge };
    v(`d${h}`)[`dischargeLim${h}`] = 1;
    model.constraints[`dischargeLim${h}`] = { max: maxDischarge };

    // Grid feeder cap, only constrained when a max_grid_window directive applies
    if (Number.isFinite(maxGrid[h])) {
      v(`g${h}`)[`gridLim${h}`] = 1;
      model.constraints[`gridLim${h}`] = { max: maxGrid[h] };
    }

    // Battery capacity and (directive-aware) minimum reserve bounds
    v(`E${h}`).cost = 0;
    v(`E${h}`)[`batCap${h}`] = 1;
    model.constraints[`batCap${h}`] = { max: battery.capacity_kwh };
    v(`E${h}`)[`batMin${h}`] = 1;
    model.constraints[`batMin${h}`] = { min: reserve };

    // Battery state transition
    if (h === 0) {
      v(`E${h}`)[`trans${h}`] = 1;
      v(`c${h}`)[`trans${h}`] = -1;
      v(`d${h}`)[`trans${h}`] = 1;
      model.constraints[`trans${h}`] = { equal: battery.initial_energy_kwh };
    } else {
      v(`E${h}`)[`trans${h}`] = 1;
      v(`E${h - 1}`)[`trans${h}`] = -1;
      v(`c${h}`)[`trans${h}`] = -1;
      v(`d${h}`)[`trans${h}`] = 1;
      model.constraints[`trans${h}`] = { equal: 0 };
    }
  }

  // End-of-day battery neutrality
  v(`E${HOURS - 1}`).eod = 1;
  model.constraints.eod = { equal: battery.initial_energy_kwh };

  let result: LpResult;
  try {
    result = solver.Solve(model) as LpResult;
  } catch (err) {
    throw new Error(
      `optimizeSchedule: LP solver threw an error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!result || result.feasible === false) {
    throw new Error(
      "optimizeSchedule: LP model is infeasible for the given hours, battery limits, and directives.",
    );
  }

  const getVar = (name: string): number => {
    const raw = result[name];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };

  const plan: HourlyPlanEntry[] = [];
  let prevEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < HOURS; h++) {
    const hourInput = sortedHours[h];
    const c = getVar(`c${h}`);
    const d = getVar(`d${h}`);

    // Hour 23 forces exact closure against drift instead of trusting c_23/d_23.
    const delta = h === HOURS - 1 ? battery.initial_energy_kwh - prevEnergy : c - d;

    let action: HourlyPlanEntry["battery_action"];
    let batteryKwh: number;
    if (delta > EPS) {
      action = "charge";
      batteryKwh = round4(delta);
    } else if (delta < -EPS) {
      action = "discharge";
      batteryKwh = round4(-delta);
    } else {
      action = "idle";
      batteryKwh = 0;
    }

    const batteryCharge = action === "charge" ? batteryKwh : 0;
    const batteryDischarge = action === "discharge" ? batteryKwh : 0;
    const energyAfter = round4(prevEnergy + batteryCharge - batteryDischarge);

    const solarUsed = round4(
      Math.min(Math.max(getVar(`s${h}`), 0), effectiveSolarAt(h)),
    );
    const gridKwh = Math.max(
      0,
      round4(hourInput.demand_kwh + batteryCharge - solarUsed - batteryDischarge),
    );

    plan.push({
      hour: hourInput.hour,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsed,
      battery_action: action,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: energyAfter,
    });

    prevEnergy = energyAfter;
  }

  return plan;
}
