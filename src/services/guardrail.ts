import type { DirectiveInterpretation } from "../../types/gridwise";

type Adjustment = NonNullable<DirectiveInterpretation["structured_adjustment"]>;

type AdjustmentResult =
  | { ok: true; adjustment: Adjustment }
  | { ok: false; reason: string };

const reject = (reason: string): AdjustmentResult => ({ ok: false, reason });
const accept = (adjustment: Adjustment): AdjustmentResult => ({
  ok: true,
  adjustment,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// Dedupe, drop anything that isn't an integer in 0-23, sort ascending.
// Accepts any value so a non-array from the LLM yields [] instead of throwing.
export function normalizeHours(hours: unknown): number[] {
  if (!Array.isArray(hours)) return [];
  const valid = hours.filter(
    (h): h is number => Number.isInteger(h) && h >= 0 && h <= 23,
  );
  return [...new Set(valid)].sort((a, b) => a - b);
}

function buildAdjustment(
  directive: DirectiveInterpretation,
  batteryCapacityKwh: number,
): AdjustmentResult {
  const raw = directive.structured_adjustment;
  if (!isRecord(raw)) return reject("missing structured_adjustment");

  switch (directive.directive_type) {
    case "solar_reduction": {
      const { factor } = raw;
      if (!isFiniteNumber(factor) || factor < 0 || factor > 1) {
        return reject("factor must be a number in [0, 1]");
      }
      // The canonical spec requires `hours`; a missing/empty window is an LLM
      // hallucination we must not pass to the solver.
      const hours = normalizeHours(raw.hours);
      if (hours.length === 0) return reject("no valid hours in 0-23");
      return accept({ factor, hours });
    }

    case "minimum_battery_reserve": {
      const { minimum_energy_kwh } = raw;
      if (
        !isFiniteNumber(minimum_energy_kwh) ||
        minimum_energy_kwh < 0 ||
        minimum_energy_kwh > batteryCapacityKwh
      ) {
        return reject(
          `minimum_energy_kwh must be a finite number in [0, ${batteryCapacityKwh}]`,
        );
      }
      // The canonical spec requires `hours` for the reserve window too.
      const hours = normalizeHours(raw.hours);
      if (hours.length === 0) return reject("no valid hours in 0-23");
      return accept({ minimum_energy_kwh, hours });
    }

    case "max_grid_window": {
      const { max_grid_kwh } = raw;
      if (!isFiniteNumber(max_grid_kwh) || max_grid_kwh < 0) {
        return reject("max_grid_kwh must be a finite number >= 0");
      }
      const hours = normalizeHours(raw.hours);
      if (hours.length === 0) return reject("no valid hours in 0-23");
      return accept({ max_grid_kwh, hours });
    }

    case "no_charge_window":
    case "no_discharge_window": {
      const hours = normalizeHours(raw.hours);
      if (hours.length === 0) return reject("no valid hours in 0-23");
      return accept({ hours });
    }

    case "no_op":
      // Handled before this function is called; unreachable in practice.
      return reject("no_op carries no adjustment");
  }
}

function noOp(
  noteIndex: number,
  explanation: string,
): DirectiveInterpretation {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation,
  };
}

function normalizeOne(
  noteIndex: number,
  candidate: DirectiveInterpretation | undefined,
  batteryCapacityKwh: number,
): DirectiveInterpretation {
  if (!candidate) {
    return noOp(noteIndex, "Guardrail: no interpretation returned; defaulted to no_op.");
  }

  const explanation =
    typeof candidate.explanation === "string" ? candidate.explanation : "";

  if (candidate.directive_type === "no_op") {
    return noOp(noteIndex, explanation);
  }

  if (candidate.applies !== true) {
    return noOp(noteIndex, explanation || "Directive marked as not applicable.");
  }

  const result = buildAdjustment(candidate, batteryCapacityKwh);
  if (!result.ok) {
    return noOp(
      noteIndex,
      `Guardrail rejected ${String(candidate.directive_type)}: ${result.reason}. Defaulted to no_op.`,
    );
  }

  return {
    note_index: noteIndex,
    applies: true,
    directive_type: candidate.directive_type,
    structured_adjustment: result.adjustment,
    explanation,
  };
}

// Deterministic safety layer between the LLM and the solver. Never throws:
// anything it can't reconcile becomes a no_op for that note.
export function normalizeDirectives(
  rawInterpretations: DirectiveInterpretation[],
  noteCount: number,
  batteryCapacityKwh: number,
): DirectiveInterpretation[] {
  const count =
    Number.isInteger(noteCount) && noteCount > 0 ? noteCount : 0;
  const entries = Array.isArray(rawInterpretations) ? rawInterpretations : [];

  // First entry wins for a given in-range note_index; duplicates are dropped.
  const byIndex = new Map<number, DirectiveInterpretation>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const idx = entry.note_index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    if (!byIndex.has(idx)) byIndex.set(idx, entry);
  }

  return Array.from({ length: count }, (_, i) => {
    try {
      return normalizeOne(i, byIndex.get(i), batteryCapacityKwh);
    } catch {
      return noOp(i, "Guardrail: unexpected error; defaulted to no_op.");
    }
  });
}
