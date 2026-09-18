import type {
  DirectiveInterpretation,
  HourlyPlanEntry,
  OptimizeEnergyRequest,
  OptimizeEnergyResponse,
} from "../../types/gridwise";

const HOURS = 24;
const TOL = 0.01;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function hourSet(hours: unknown): number[] {
  if (!Array.isArray(hours)) return [];
  return hours.filter(
    (h): h is number => Number.isInteger(h) && h >= 0 && h < HOURS,
  );
}

// Re-derives the per-hour limits straight from the directives so the check
// shares no state with the optimizer's own buildDirectiveState.
function deriveLimits(directives: DirectiveInterpretation[]) {
  const solarFactor = Array<number>(HOURS).fill(1);
  const minReserve = Array<number>(HOURS).fill(0);
  const noCharge = Array<boolean>(HOURS).fill(false);
  const noDischarge = Array<boolean>(HOURS).fill(false);
  const maxGrid = Array<number>(HOURS).fill(Infinity);

  for (const d of directives) {
    if (!d.applies || d.directive_type === "no_op" || !d.structured_adjustment) {
      continue;
    }
    const adj = d.structured_adjustment;
    const hours = hourSet(adj.hours);
    switch (d.directive_type) {
      case "solar_reduction":
        if (typeof adj.factor === "number") {
          for (const h of hours) solarFactor[h] *= adj.factor;
        }
        break;
      case "minimum_battery_reserve":
        if (typeof adj.minimum_energy_kwh === "number") {
          for (const h of hours) {
            minReserve[h] = Math.max(minReserve[h], adj.minimum_energy_kwh);
          }
        }
        break;
      case "no_charge_window":
        for (const h of hours) noCharge[h] = true;
        break;
      case "no_discharge_window":
        for (const h of hours) noDischarge[h] = true;
        break;
      case "max_grid_window":
        if (typeof adj.max_grid_kwh === "number") {
          for (const h of hours) maxGrid[h] = Math.min(maxGrid[h], adj.max_grid_kwh);
        }
        break;
    }
  }
  return { solarFactor, minReserve, noCharge, noDischarge, maxGrid };
}

function buildSummary(
  plan: HourlyPlanEntry[],
  directives: DirectiveInterpretation[],
  totalGrid: number,
  totalCost: number,
  peakGrid: number,
  peakHour: number,
): string {
  const charged = plan.reduce(
    (s, p) => s + (p.battery_action === "charge" ? p.battery_kwh : 0),
    0,
  );
  const discharged = plan.reduce(
    (s, p) => s + (p.battery_action === "discharge" ? p.battery_kwh : 0),
    0,
  );
  const solar = plan.reduce((s, p) => s + p.solar_used_kwh, 0);
  const applied = directives.filter((d) => d.applies).length;

  return (
    `Imports ${totalGrid.toFixed(2)} kWh from the grid for ${totalCost.toFixed(2)} BDT, ` +
    `peaking at ${peakGrid.toFixed(2)} kWh in hour ${peakHour}. ` +
    `Uses ${solar.toFixed(2)} kWh of solar; the battery charges ${charged.toFixed(2)} kWh ` +
    `and discharges ${discharged.toFixed(2)} kWh, ending the day at its starting level. ` +
    `${applied} of ${directives.length} operator note(s) applied as constraints.`
  );
}

// Independent check of the solver's plan against the original constraints.
// Throws on the first violation (abs tolerance 0.01); otherwise returns the
// final response with totals recomputed from the plan itself.
export function validateAndFormatPlan(
  request: OptimizeEnergyRequest,
  directives: DirectiveInterpretation[],
  plan: HourlyPlanEntry[],
): OptimizeEnergyResponse {
  const { hours, battery } = request;

  if (!Array.isArray(plan) || plan.length !== HOURS) {
    throw new Error(`Replay: expected ${HOURS} plan entries, got ${plan?.length ?? 0}`);
  }
  const inputByHour = new Map(hours.map((h) => [h.hour, h]));
  const { solarFactor, minReserve, noCharge, noDischarge, maxGrid } =
    deriveLimits(directives);

  let totalGrid = 0;
  let totalCost = 0;
  let peakGrid = 0;
  let peakHour = 0;
  let energy = battery.initial_energy_kwh;

  for (let h = 0; h < HOURS; h++) {
    const p = plan[h];
    const input = inputByHour.get(h);
    const fail = (msg: string): never => {
      throw new Error(`Replay: hour ${h} ${msg}`);
    };

    if (p.hour !== h || !input) fail("is missing or out of order");
    const inp = input!;

    const charge = p.battery_action === "charge" ? p.battery_kwh : 0;
    const discharge = p.battery_action === "discharge" ? p.battery_kwh : 0;

    if (p.grid_kwh < -TOL || p.solar_used_kwh < -TOL || p.battery_kwh < -TOL) {
      fail("has a negative energy value");
    }

    // Energy balance: grid + solar + discharge = demand + charge
    const balanceErr = p.grid_kwh + p.solar_used_kwh + discharge - (inp.demand_kwh + charge);
    if (Math.abs(balanceErr) > TOL) fail(`energy balance off by ${balanceErr.toFixed(4)} kWh`);

    // Solar usage limit, after any solar_reduction directive
    const solarCap = Math.max(0, inp.solar_kwh * solarFactor[h]);
    if (p.solar_used_kwh > solarCap + TOL) {
      fail(`solar used ${p.solar_used_kwh} exceeds available ${solarCap.toFixed(4)}`);
    }

    // Battery state must follow from the previous hour's state and this action
    energy += charge - discharge;
    if (Math.abs(energy - p.battery_energy_after_kwh) > TOL) {
      fail(`battery energy ${p.battery_energy_after_kwh} does not match replayed ${energy.toFixed(4)}`);
    }

    // Capacity and (directive-aware) minimum reserve
    if (p.battery_energy_after_kwh > battery.capacity_kwh + TOL) {
      fail(`battery energy ${p.battery_energy_after_kwh} exceeds capacity ${battery.capacity_kwh}`);
    }
    const floor = Math.max(battery.minimum_energy_kwh, minReserve[h]);
    if (p.battery_energy_after_kwh < floor - TOL) {
      fail(`battery energy ${p.battery_energy_after_kwh} is below minimum reserve ${floor}`);
    }

    // Rate limits and directive windows
    if (charge > battery.max_charge_kwh_per_hour + TOL) fail("exceeds max charge rate");
    if (discharge > battery.max_discharge_kwh_per_hour + TOL) fail("exceeds max discharge rate");
    if (noCharge[h] && charge > TOL) fail("charges during a no_charge_window");
    if (noDischarge[h] && discharge > TOL) fail("discharges during a no_discharge_window");
    if (p.grid_kwh > maxGrid[h] + TOL) fail(`grid ${p.grid_kwh} exceeds cap ${maxGrid[h]}`);

    totalGrid += p.grid_kwh;
    totalCost += p.grid_kwh * inp.tariff_bdt_per_kwh;
    if (p.grid_kwh > peakGrid) {
      peakGrid = p.grid_kwh;
      peakHour = h;
    }
  }

  // End-of-day neutrality
  const finalEnergy = plan[HOURS - 1].battery_energy_after_kwh;
  if (Math.abs(finalEnergy - battery.initial_energy_kwh) > TOL) {
    throw new Error(
      `Replay: end-of-day battery ${finalEnergy} != initial ${battery.initial_energy_kwh}`,
    );
  }

  totalGrid = round4(totalGrid);
  totalCost = round4(totalCost);
  peakGrid = round4(peakGrid);

  return {
    scenario_id: request.scenario_id,
    directive_interpretation: directives,
    hourly_plan: plan,
    total_grid_kwh: totalGrid,
    total_cost_bdt: totalCost,
    peak_grid_kwh: peakGrid,
    plan_summary: buildSummary(plan, directives, totalGrid, totalCost, peakGrid, peakHour),
  };
}
