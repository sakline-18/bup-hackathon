# GridWise — Implementation Log

This document tracks what has been built so far against [PLAN.md](PLAN.md), where it lives, and why it matters. It is written as work happens, not all at once at the end.

---

## 1. UI Shell (landing page)

**Status:** done (mock UI, no real data yet — per `CLAUDE.md`'s "hardcode first" rule).

Replaced the default `create-next-app` boilerplate with a landing page themed around the GridWise challenge, so the app has a real front door instead of the Next.js starter template.

| File | What changed |
|---|---|
| [app/page.tsx](app/page.tsx) | Full rewrite: hero section, a 4-stat row, and a 5-card pipeline visualization (Input Validation → LLM Interpretation → Guardrail Normalizer → LP Math Solver → Replay & Formatting) mirroring the architecture diagram in `PLAN.md`. |
| [app/layout.tsx](app/layout.tsx) | Metadata title/description updated from "Create Next App" to "GridWise". |
| [app/globals.css](app/globals.css) | Body font falls back to the already-loaded Geist variable instead of plain Arial. |
| [.claude/launch.json](.claude/launch.json) | Added so the dev server can be opened in the in-app browser preview (`npm run dev` on port 3000). |

No functions here — it's static presentational JSX, verified visually in both light and dark mode via the browser preview.

---

## 2. Phase 1, Part 2 — Strict Data Contracts

**Status:** done. Corresponds to PLAN.md → Phase 1 → "Define Strict Data Contracts (`src/types/gridwise.ts`)".

**Location note:** the plan's reference command scaffolds a project with `--src-dir`, but this repo's actual `tsconfig.json` has no `src/` dir and aliases `@/*` to the repo root. The contracts were placed at **[types/gridwise.ts](types/gridwise.ts)** (not `src/types/`) to match the project that already exists, rather than restructuring it.

### What's in `types/gridwise.ts`

Every entry is a [Zod](https://zod.dev) schema paired with an inferred TypeScript type (`z.infer<typeof X>`), so the same definition drives both compile-time types and runtime validation.

| Schema (+ inferred type) | Shape | Why it matters |
|---|---|---|
| `DirectiveTypeSchema` → `DirectiveType` | Enum: `solar_reduction \| minimum_battery_reserve \| no_charge_window \| no_discharge_window \| max_grid_window \| no_op` | The fixed vocabulary the LLM interpretation step (Phase 2) is allowed to emit. Anything outside this set fails validation instead of silently reaching the solver. |
| `BatteryActionSchema` → `BatteryAction` | Enum: `charge \| discharge \| idle` | The only three states the optimizer's output plan can describe per hour (Phase 4/5). |
| `HourInputSchema` → `HourInput` | `{ hour: 0–23 int, demand_kwh, solar_kwh, tariff_bdt_per_kwh }` | One row of the 24-hour input timeline the request carries. |
| `BatteryInputSchema` → `BatteryInput` | `{ capacity_kwh, initial_energy_kwh, minimum_energy_kwh, max_charge_kwh_per_hour, max_discharge_kwh_per_hour }` | The battery's physical limits — these become hard constraints in the Phase 4 LP model. |
| `OptimizeEnergyRequestSchema` → `OptimizeEnergyRequest` | `{ scenario_id, operator_notes: 1–3 strings, hours: exactly 24 HourInput, battery: BatteryInput }` | The full shape of the `POST /optimize-energy` request body. Enforces exactly 24 hours and 1–3 notes at the door, before any business logic runs (Phase 1's job per the plan). |
| `DirectiveInterpretationSchema` → `DirectiveInterpretation` | `{ note_index, applies, directive_type, structured_adjustment: object \| null, explanation }` | What the LLM interpretation step (Phase 2) produces per operator note, before the Phase 3 guardrail layer normalizes it. `structured_adjustment` is intentionally left as a loose object here — its per-directive shape (e.g. `factor` for `solar_reduction`, `minimum_energy_kwh` for `minimum_battery_reserve`) is exactly what Phase 3's guardrail/normalizer is specified to validate, so tightening it here would duplicate that phase's job ahead of schedule. |
| `HourlyPlanEntrySchema` → `HourlyPlanEntry` | `{ hour, grid_kwh, solar_used_kwh, battery_action, battery_kwh, battery_energy_after_kwh }` | One row of the solver's output dispatch plan (Phase 4/5). |
| `OptimizeEnergyResponseSchema` → `OptimizeEnergyResponse` | `{ scenario_id, directive_interpretation[], hourly_plan: exactly 24 HourlyPlanEntry, total_grid_kwh, total_cost_bdt, peak_grid_kwh, plan_summary }` | The full shape of the API response. Used by the eventual route handler to validate its own output before returning it (belt-and-suspenders against a malformed plan escaping Phase 5's replay validator). |

No standalone functions were introduced — this file only exports schemas and types, which is exactly what "Phase 1, Part 2" scopes it to. The schemas themselves are used as functions in the sense that every one exposes `.parse()` (throws on invalid input) and `.safeParse()` (returns a `{ success, data | error }` result) from Zod; the route handler built in a later phase will call `.safeParse()` on incoming requests to produce the HTTP 400 behavior the plan specifies.

### Test coverage

**Location:** [scripts/test-gridwise-types.ts](scripts/test-gridwise-types.ts)
**Run with:** `npm run test:types`

A runtime smoke test (not a unit-test framework — none is installed, per the hackathon's "skip tests unless asked" default; this was added because it was explicitly requested here) that exercises every schema above with both valid and deliberately invalid data, using `safeParse` and asserting the expected pass/fail outcome. 17 checks total, covering:

- Boundary validation (hour must be an integer in `0–23`).
- Cardinality rules (`operator_notes` must have 1–3 entries, `hours` and `hourly_plan` must have exactly 24).
- Enum rejection (unknown `directive_type`, unknown `battery_action`).
- Required-field rejection (a `BatteryInput` missing a field fails).
- A full valid request and a full valid response both parse successfully end-to-end.

All 17 checks currently pass (`npm run test:types`), `npx tsc --noEmit` is clean, and `npm run build` succeeds.

**Config change required to support the test:** [tsconfig.json](tsconfig.json) gained `"allowImportingTsExtensions": true`. Node 24's built-in TypeScript execution (used to run the test script directly with `node scripts/test-gridwise-types.ts`, no `ts-node`/`tsx` install needed) requires explicit `.ts` extensions on relative imports; TypeScript's checker normally forbids that unless this flag is set (which itself requires `noEmit: true`, already the case here). This only affects type-checking behavior, not what Next.js bundles.

### Dependency change

`zod` (`^4.6.5`) was added to `package.json` dependencies — it wasn't actually installed despite being listed in `PLAN.md`'s Phase 1 setup command. It underpins every schema in `types/gridwise.ts`.

---

## Not yet done

Per `PLAN.md`, still outstanding: Phase 2 (LLM interpretation service), Phase 3 (guardrail normalizer — including the per-directive `structured_adjustment` shape checks noted above), Phase 4 (LP solver, needs `javascript-lp-solver`, not yet installed), Phase 5 (replay engine + route handlers), Phase 6 (sample-case regression tests), Phase 7 (Docker/deploy), Phase 8 (README/video).
