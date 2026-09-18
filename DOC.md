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

## 3. Phase 2 — LLM Interpretation Engine

**Status:** done. Corresponds to `PLAN.md` → Phase 2 → "Prompt Engineering (`src/services/llm.ts`)".

**Location note:** placed at **[src/services/llm.ts](src/services/llm.ts)**, matching the plan's own path (unlike Phase 1's types, which were relocated to match the existing repo layout — see §2 above). This is the first file to actually introduce a `src/` directory into the project.

**Model choice — deviation from PLAN.md:** the plan describes a generic "Fast Generative Model" and doesn't name a provider. This was implemented against the **Google Gemini API** (`gemini-3.6-flash`, via the official `@google/genai` SDK) at explicit user request, not Anthropic's API. `@google/genai` was added as a new dependency.

### What the module does

`src/services/llm.ts` exports one function:

```ts
interpretOperatorNotes(operatorNotes: string[], battery: BatteryInput): Promise<DirectiveInterpretation[]>
```

Given the request's `operator_notes` array and `battery` object, it returns one `DirectiveInterpretation` (from `types/gridwise.ts`) per note — the exact shape Phase 3's guardrail layer expects to receive and re-validate. It never throws: every failure path degrades to a safe default (see Fallback strategy below), because a crashed Phase 2 call would take down the whole `/optimize-energy` request.

### Why structured output instead of prompting for JSON text

The naive approach — asking the model to "reply with JSON" and `JSON.parse()`-ing free text — is fragile: models wrap output in markdown fences, add prose before/after, or produce near-JSON that fails to parse. Instead, this uses Gemini's **structured output** feature: a `responseSchema` (built from the SDK's `Type` enum: `OBJECT`, `ARRAY`, `STRING`, `INTEGER`, `BOOLEAN`, `NUMBER`) passed alongside `responseMimeType: "application/json"`. This constrains generation at the API level so the response is guaranteed to be syntactically valid JSON matching the schema's structure — no markdown-fence stripping, no "hope the model behaved" step.

The schema mirrors `DirectiveInterpretationSchema` from `types/gridwei.ts` (array of `{ note_index, applies, directive_type, structured_adjustment, explanation }`), with `directive_type` constrained to the same 6-value enum used everywhere else in the codebase, so the LLM literally cannot emit a directive type the rest of the pipeline doesn't recognize.

**One deliberate simplification, and why:** the plan (and the follow-up prompt) asked for `structured_adjustment`'s shape to vary per `directive_type` — e.g. only `factor` for `solar_reduction`, only `minimum_energy_kwh` for `minimum_battery_reserve`. Gemini's structured-output schema format (a constrained subset of OpenAPI) does not reliably support "shape of field X depends on the value of field Y" (conditional/discriminated-union schemas). Rather than fight the API into an unreliable shape under a hard latency budget, `structured_adjustment` is defined as **one flat object with all four possible fields optional** (`hours`, `factor`, `minimum_energy_kwh`, `max_grid_kwh`), and the "only populate the fields relevant to this directive type" rule is pushed into the **system prompt** instead of the schema. This is safe specifically because **Phase 3 (not yet built) is specified to re-validate `structured_adjustment` per-directive-type anyway** — so an LLM that ignores the field-discipline instruction and leaves a stray field populated is caught downstream, not silently trusted.

### System prompt — encoding PLAN.md's 5 interpretation rules

`buildSystemPrompt()` generates a prompt (parameterized by the request's actual `battery.capacity_kwh`, so the model does the percentage→kWh math against the real number, not a placeholder) that encodes every rule from `PLAN.md` Phase 2, each with a worked example so the model has a concrete pattern to match rather than an abstract rule to interpret:

| Rule | Encoded as | Example baked into the prompt |
|---|---|---|
| Sequential processing, 1 output per input note | "ORDERING" section | — |
| 5 directives + `no_op` fallback for distractors | "CATEGORIZATION" section, one line per directive type | `no_op` explicitly requires `applies: false`, `structured_adjustment: null` |
| Start-inclusive/end-exclusive time windows | "TIME RANGES" section | `"1 PM to 3 PM" → hours: [13, 14]` (not 15); `"noon until 2 PM" → [12, 13]` (not 14); `"6 PM until 10 PM" → [18, 19, 20, 21]` (not 22) — the exact three examples from `PLAN.md` |
| Solar reduction → remaining fraction | "SOLAR NORMALIZATION" | `"reduce solar by 80%" → factor: 0.2` |
| Relative battery reserve → absolute kWh | "RELATIVE BATTERY RESERVES" | `"keep at least 50% of capacity"` with the request's actual `capacity_kwh` interpolated into both the instruction text and the worked example, so the model sees the real arithmetic it needs to reproduce |
| Field discipline (the schema simplification above) | "FIELD DISCIPLINE" | explicit: only populate fields relevant to the chosen `directive_type`; `no_op` must be null |

The user-turn message (`buildUserPrompt()`) is just the notes array rendered as `index: text` lines — all the interpretation logic lives in the system prompt, keeping the per-request payload minimal (matters for latency and token cost on every call).

### Latency and fallback strategy — why this shape specifically

PLAN.md requires p95 latency under 5 seconds for the *whole* `/optimize-energy` request, and the follow-up prompt specified a strict 4500ms budget for this one sub-step with **zero retries**. The reasoning: a retry after a timeout would already blow the remaining budget before Phase 3/4/5 even start, so retrying is strictly worse than failing fast.

- **Model choice for speed:** `gemini-3.6-flash` (not a larger/slower Gemini tier) — this task is short text → small structured JSON, well within a fast model's capability, and speed is the binding constraint here, not raw intelligence.
- **Hard timeout, belt-and-suspenders:** an `AbortController` fires `.abort()` at exactly 4500ms via `setTimeout`, and its `signal` is passed to the SDK call *twice* — as `config.abortSignal` and via `config.httpOptions.timeout`. Two independent mechanisms were used because the exact abort-plumbing behavior of a fast-moving SDK isn't something to bet a hard deadline on; if one path doesn't actually cut the request, the other does.
- **Fallback, not failure:** the entire call is wrapped in `try/catch`. On *any* failure — timeout abort, network error, an empty `result.text`, or `JSON.parse` throwing on malformed output — `fallbackDirectives()` returns one `{ applies: false, directive_type: "no_op", structured_adjustment: null, explanation: "LLM interpretation unavailable; defaulted to no_op." }` per input note. This is a safe default because `no_op` directives are inert — Phase 4's solver runs the optimization with no directive constraints applied, i.e., it degrades to "ignore the operator notes, optimize on hard battery/grid physics alone" rather than crashing the request or returning a half-formed plan.
- **`finally { clearTimeout(timer) }`** ensures the abort timer doesn't fire after a request that already completed (or already failed and returned).

### Dependency change

`@google/genai` was added to `package.json` dependencies — the official Google Gen AI SDK, used for the `GoogleGenAI` client and the `Type` enum that builds the structured-output schema. The client reads `GEMINI_API_KEY` from the environment; this key is **not yet set** anywhere in the repo (no `.env` / `.env.example` exists yet) — needed before this code can actually run against the live API.

### Verification

`npx tsc --noEmit -p tsconfig.json` is clean for `src/services/llm.ts` specifically (the project's one remaining type error, in `app/layout.tsx`, is a pre-existing Next.js 16 generated-types issue unrelated to this work). No runtime test was added yet — there's no sample-case harness to run it against until Phase 6, and no live `GEMINI_API_KEY` in this environment to smoke-test an actual call.

---

## 4. Phase 3 — Deterministic Guardrails & Normalizer

**Status:** done. Corresponds to `PLAN.md` → Phase 3 → "Implement Validation Layer (`src/services/guardrail.ts`)".

**File created:** [src/services/guardrail.ts](src/services/guardrail.ts). It exports two functions and defines no new schemas — it only imports `DirectiveInterpretation` from `types/gridwise.ts`.

```ts
normalizeDirectives(rawInterpretations: DirectiveInterpretation[], noteCount: number, batteryCapacityKwh: number): DirectiveInterpretation[]
normalizeHours(hours: unknown): number[]
```

### How it resolves the loose `structured_adjustment`

Phase 1 typed `structured_adjustment` as `Record<string, unknown> | null`, and Phase 2 had the LLM emit one flat object with every possible field (`hours`, `factor`, `minimum_energy_kwh`, `max_grid_kwh`) optional, because Gemini's structured output can't express per-directive schemas. That means anything the LLM returned could reach the solver with stray or wrong-typed fields.

`normalizeDirectives` closes that gap. A `switch` on `directive_type` builds a **fresh** `structured_adjustment` object containing only the fields that directive owns. Extra fields the LLM populated are discarded, never copied. The solver (Phase 4) can therefore rely on the exact shape per directive:

| `directive_type` | Guaranteed output shape | Rejected (→ `no_op`) when |
|---|---|---|
| `solar_reduction` | `{ factor, hours }` | `factor` missing, non-finite, or outside `[0, 1]`; or `hours` missing/empty after normalization |
| `minimum_battery_reserve` | `{ minimum_energy_kwh, hours }` | `minimum_energy_kwh` missing, non-finite, `< 0`, or `> batteryCapacityKwh`; or `hours` missing/empty after normalization |
| `max_grid_window` | `{ max_grid_kwh, hours }` | `max_grid_kwh` missing, non-finite, or `< 0`; or `hours` empty after normalization |
| `no_charge_window` / `no_discharge_window` | `{ hours }` | `hours` missing or empty after normalization |
| `no_op` | `null`, `applies: false` | never rejected — forced |

### Normalization rules implemented

- **Cardinality and ordering:** output always has exactly `noteCount` entries, ordered `note_index` 0 to `noteCount - 1`. Indices are re-assigned from the position, so out-of-order input is sorted. Missing entries are filled with a `no_op`. Out-of-range or non-integer `note_index` values are ignored. On duplicate indices the first entry wins.
- **Hour cleaning (`normalizeHours`):** non-arrays become `[]`. Keeps only integers in `0–23`, dedupes with `[...new Set(hours)]`, then sorts ascending with `.sort((a, b) => a - b)`.
- **Inconsistent flags:** a non-`no_op` directive with `applies !== true` is downgraded to `no_op`, so the solver never sees a populated adjustment the LLM said doesn't apply.
- **Safe failure:** the function never throws (per-note `try/catch` plus type checks that accept malformed runtime input). Every rejection becomes `directive_type: "no_op"`, `applies: false`, `structured_adjustment: null`, with an `explanation` like `Guardrail rejected solar_reduction: factor must be a number in [0, 1]. Defaulted to no_op.`
- **Purity:** the input array and its objects are never mutated; a new array of new objects is returned.

### Judgment calls worth knowing

- **Strict `hours` enforcement.** The canonical specification requires an `hours` array for both `minimum_battery_reserve` and `solar_reduction`. `guardrail.ts` now rejects either directive (downgrading it to `no_op`) if `hours` is missing or empty after normalization. Because the LLM emits a flat object schema, this is the layer that catches hallucinated or incomplete output, so non-compliant directives never reach the solver.
- `max_grid_window` with empty hours is likewise rejected, since a cap with no window is meaningless.
- The Phase 2 prompt in `llm.ts` was updated to tell the LLM to emit `hours` for `minimum_battery_reserve` as well, so valid notes aren't rejected.

### Verification

`npx tsc --noEmit` reports no errors in `guardrail.ts`. A throwaway script (not committed, per the "skip tests" default) exercised: `factor: 1.5` rejection, hallucinated extra fields dropped, hours `[15, 13, 13, 99, -1, 1.5]` → `[13, 15]`, out-of-order/duplicate/missing indices, `no_op` with a populated adjustment, negative `max_grid_kwh`, empty hours, and `undefined` input. All produced the expected output. `guardrail.ts` was wired into the route handler in Phase 5.

---

## 5. Phase 4 — Linear Programming Math Optimizer

**Status:** done. Corresponds to `PLAN.md` → Phase 4 → "Formulate Optimization Model (`src/services/optimizer.ts`)".

**File created:** [src/services/optimizer.ts](src/services/optimizer.ts). It exports one function:

```ts
optimizeSchedule(hours: HourInput[], battery: BatteryInput, directives: DirectiveInterpretation[]): HourlyPlanEntry[]
```

It takes the 24 validated hourly rows, the battery's physical limits, and the guardrail-normalized directives (Phase 3's output), and returns the 24-entry dispatch plan Phase 5's replay engine will re-check and format into the final response.

### Dependency

`javascript-lp-solver` (`^1.0.3`) was installed — it ships its own TypeScript types (`dist/index.d.ts`), so no separate `@types/javascript-lp-solver` package exists or is needed (`PLAN.md`'s reference install command lists one, but the registry has no such package).

### LP model construction

Five decision variables are created per hour `h` (`g{h}`, `s{h}`, `c{h}`, `d{h}`, `E{h}` for grid import, solar used, battery charge, battery discharge, and end-of-hour state-of-charge), built as a plain JSON model object matching the solver's native format (`{ optimize, opType, constraints, variables }`) rather than its fluent `Model` class API — this keeps the per-hour constraint wiring a flat loop instead of 24 rounds of imperative `addTerm` calls.

The objective (`optimize: "cost"`, `opType: "min"`) sums `g_h * tariff_bdt_per_kwh[h]` over all hours, plus a `0.0001` cost on every `c_h` and `d_h`. That penalty exists specifically to kill zero-cost charge/discharge cycling: when tariffs are flat across a stretch of hours, a pure grid-cost objective is indifferent between `idle` and `charge 5 / discharge 5` in the same hour (both cost the same, satisfy the same balance equation), so the solver could return either — nondeterministically, from run to run of the underlying simplex. The 0.0001 term makes `idle` strictly cheaper than any nonzero charge/discharge pair, so the solver only moves battery energy when it's cost-motivated, not as directionless noise the discretization step would then have to clean up.

Constraints per hour, keyed by hour index so hour-local terms never collide:

| Constraint | Shape | Directive interaction |
|---|---|---|
| `balance{h}` (equal) | `g_h + s_h + d_h - c_h = demand_kwh[h]` | — |
| `solarCap{h}` (max) | `s_h <= effective_solar[h]` | `effective_solar[h] = solar_kwh[h] * (product of all applicable solar_reduction factors)` — see below |
| `chargeLim{h}` / `dischargeLim{h}` (max) | `c_h <= max_charge_kwh_per_hour`, `d_h <= max_discharge_kwh_per_hour` | forced to `0` for any hour inside a `no_charge_window` / `no_discharge_window` directive |
| `gridLim{h}` (max) | `g_h <= max_grid_kwh` | constraint is only added at all when a `max_grid_window` directive covers that hour — otherwise `g_h` is unbounded above (its only real cap comes indirectly through cost minimization) |
| `batCap{h}` (max) | `E_h <= capacity_kwh` | — |
| `batMin{h}` (min) | `E_h >= max(battery.minimum_energy_kwh, directive_reserve[h])` | see reserve handling below |
| `trans{h}` (equal) | `h=0`: `E_0 - c_0 + d_0 = initial_energy_kwh`; `h>0`: `E_h - E_{h-1} - c_h + d_h = 0` | — |
| `eod` (equal, once) | `E_23 = initial_energy_kwh` | — |

### Turning directives into per-hour arrays (`buildDirectiveState`)

Before the model loop runs, `buildDirectiveState` walks the (already guardrail-normalized) `directives` array once and produces five parallel 24-length arrays — `solarFactor`, `minReserve`, `noCharge`, `noDischarge`, `maxGrid` — so the per-hour constraint-building loop never has to re-scan directives. Non-applying and `no_op` entries are skipped up front.

Both `solar_reduction` and `minimum_battery_reserve` are now strictly scoped to the `hours` array in their directive. Phase 3's guardrail guarantees that array is present and non-empty for both (see §4), so the optimizer has no "missing hours" fallback and never applies either directive globally:

- **`solar_reduction` applies only to its listed hours.** `effective_solar[h]` is multiplied by `factor` only for `h` in `hours`. Factors from multiple overlapping directives combine multiplicatively (each is a "remaining usable fraction," so two 50%-reduction notes on the same hour compound to 25%, not overridden 50%).
- **`minimum_battery_reserve` is enforced only during its listed hours.** `minReserve[h]` is raised to `minimum_energy_kwh` only for `h` in `hours`, so the `batMin{h}` floor on `E_h` applies just inside that window; other hours keep the battery's own `minimum_energy_kwh`. Multiple such directives combine via `Math.max` (the strictest reserve wins) per hour.

### Post-processing: why the solver's raw output isn't the answer

An LP relaxation's solution is a real-valued vector — a solved `c_h` might be `4.999999999997` or the solver might, for a genuinely indifferent hour, land on some arbitrary micro-nonzero split between `c_h` and `d_h` that nets to the same balance but doesn't read as a clean action. Passing that straight into `HourlyPlanEntry` would produce a technically-valid-but-ugly plan and, worse, floating-point drift that compounds hour over hour until `E_23` no longer exactly equals `initial_energy_kwh` — which Phase 6's regression suite checks for an **exact** match, not a tolerance. The discretization pass exists specifically to convert "LP-optimal but numerically messy" into "clean and exactly closed."

The result-processing loop runs a second time over `h = 0..23`, sequentially, carrying `prevEnergy` (starting at `battery.initial_energy_kwh`) forward by hand rather than trusting the solver's own `E_h` values, per this exact sequence:

1. **Net delta.** `Δ = c_h - d_h`, taken from the solver's raw `c_h`/`d_h` — **except** for `h = 23`, where `Δ` is instead forced to `battery.initial_energy_kwh - prevEnergy` (`prevEnergy` here is the *already-recalculated* `E_22`, not the solver's raw one). This is the strict-closure rule from the spec: hour 23 doesn't get to have its own opinion about `c_23`/`d_23` at all — whatever the running recalculated total is, hour 23's action is defined as exactly what closes the loop back to `initial_energy_kwh`, so `E_23 = initial_energy_kwh` holds as an *identity* of the post-processing arithmetic, not as something that depends on the solver's floating-point precision.
2. **Action routing.** `Δ > 1e-4` → `charge` with `battery_kwh = round(Δ, 4)`; `Δ < -1e-4` → `discharge` with `battery_kwh = round(-Δ, 4)`; otherwise → `idle`, `battery_kwh = 0`. This is where the 0.0001 objective penalty pays off: because the solver was already biased away from spurious simultaneous charge/discharge, the `1e-4` dead-zone here is cleaning up genuine floating-point noise, not adjudicating a real ambiguous case the objective left unresolved.
3. **Sequential state recalculation.** `battery_energy_after_kwh = round(prevEnergy + batteryCharge - batteryDischarge, 4)`, then `prevEnergy` is reassigned to that rounded value before moving to `h + 1`. Every hour's `E_h` is therefore built from the previous *rounded* hour, not the solver's raw (and now-superseded) values — this is what makes the chain exact instead of merely close.
4. **Grid slack rebalancing.** `solar_used_kwh` is taken from the solver's raw `s_h` (clamped to `[0, effective_solar[h]]` and rounded — the solver has no reason to produce a value outside that range, the clamp is defensive) but `grid_kwh` is **not** taken from the solver's raw `g_h` at all. It's recomputed from the already-rounded battery numbers: `grid_kwh = max(0, round(demand_kwh + battery_charge - solar_used - battery_discharge, 4))`. This is required because steps 1–3 can shift the battery's contribution by up to the rounding epsilon relative to what the solver assumed when it picked `g_h` — if `grid_kwh` were left as the solver's original value, the hour's energy balance (`grid + solar + discharge = demand + charge`) would no longer hold exactly against the *rounded* battery numbers. Recomputing `g_h` as the residual makes it the slack variable that absorbs 100% of the discretization's rounding, keeping every single hour's balance equation exact by construction.

### Robustness / failure handling

- **Malformed hour input:** `hours` must be exactly 24 entries, sorted by `.hour`, covering `0..23` with no gaps or duplicates — checked explicitly before any model construction, throwing `optimizeSchedule: expected exactly 24 hourly inputs...` or `...missing or duplicate hour near index {h}` otherwise. The plan's spec assumes valid input reaches this function (Phase 1's Zod schema already enforces `hours.length === 24`), but hour *ordering* and *coverage* (0–23 each exactly once) aren't things the schema checks, so this function checks them itself rather than trusting the caller.
- **Solver throwing:** wrapped in `try/catch`; rethrown as `optimizeSchedule: LP solver threw an error: {message}`.
- **Infeasible model:** `javascript-lp-solver` doesn't throw for infeasibility — it returns `{ feasible: false, ... }`. That's checked explicitly and converted into `optimizeSchedule: LP model is infeasible for the given hours, battery limits, and directives.` (An infeasible model is possible in practice — e.g. a `minimum_battery_reserve` directive demanding more than `battery.capacity_kwh` slips past the guardrail's `<= capacity_kwh` check only because the guardrail checks against the *raw* request's `battery.capacity_kwh` at parse time, which is the same value the solver uses, so this path mainly guards against directive combinations that are individually valid but jointly unsatisfiable, e.g. a `no_charge_window` covering enough hours that the battery physically cannot reach a later `minimum_battery_reserve` floor in time.)

In every failure path, `optimizeSchedule` throws a plain `Error` with a message prefixed `optimizeSchedule:` rather than returning a partial or malformed plan — Phase 5's route handler catches this and turn it into the route handler's safe HTTP 500, per `PLAN.md`'s Phase 5 spec ("Catch unexpected errors and return safe HTTP 500 without leaking stack traces or secrets").

### Verification

`npx tsc --noEmit -p tsconfig.json` reports no errors for `optimizer.ts`. Two throwaway smoke scripts (run via `npx tsx`, not committed, per the "skip tests" default) were used to exercise the module end-to-end since there's no sample-case harness until Phase 6:

- A 24-hour scenario with a cheap overnight tariff, an expensive evening peak (hours 18–21), solar available hours 6–17, and a `no_discharge_window` directive over hours 6–8. Result: the solver charged the battery overnight when the grid was cheap, discharged it to cover the evening peak, respected the no-discharge window, and the plan's own totals independently confirm energy balance (`total_grid + total_solar + total_discharge - total_charge == total_demand`, within `0.05` on hand-summed floats) and exact end-of-day closure (`plan[23].battery_energy_after_kwh === battery.initial_energy_kwh`).
- A deliberately-infeasible scenario (a `minimum_battery_reserve` directive demanding `100` kWh against a `5` kWh battery capacity) confirmed `optimizeSchedule` throws the expected infeasibility error rather than returning a bogus plan.

`optimizer.ts` is not yet wired into a route handler — wired in during Phase 5, along with Phase 3's `guardrail.ts`.

---

## 6. Phase 5 — Replay Engine, Metrics, and Route Handlers

**Status:** done. Corresponds to `PLAN.md` → Phase 5.

**Files created:** [src/services/replay.ts](src/services/replay.ts), [app/health/route.ts](app/health/route.ts), [app/optimize-energy/route.ts](app/optimize-energy/route.ts).

> **Location note:** `PLAN.md` says `src/app/...`, but this project's App Router lives at the repo root (`app/`). Next.js ignores `src/app` whenever a root `app/` exists, so the routes are in `app/health/` and `app/optimize-energy/` — otherwise they would 404.

### `src/services/replay.ts` — independent replay validator

```ts
validateAndFormatPlan(request: OptimizeEnergyRequest, directives: DirectiveInterpretation[], plan: HourlyPlanEntry[]): OptimizeEnergyResponse
```

It trusts nothing from the solver. It re-derives the per-hour limits (solar factor, reserve floor, no-charge / no-discharge / grid-cap windows) directly from the directives with its own code, not by reusing the optimizer's `buildDirectiveState`. Then it walks the 24 hours once, carrying the battery energy forward itself.

**How the 0.01 tolerance is enforced:** a single constant `TOL = 0.01`. Every check is an absolute comparison against it and **throws** an `Error` (message prefixed `Replay: hour N ...`) on the first violation:

| Check | Throws when |
|---|---|
| Energy balance | `abs(grid + solar + discharge - (demand + charge)) > 0.01` |
| Solar limit | `solar_used > solar_kwh × (product of solar_reduction factors for that hour) + 0.01` |
| Battery state chain | `abs(replayed E_h - battery_energy_after_kwh) > 0.01`, where the replayed value is the previous hour's energy plus charge minus discharge |
| Capacity | `battery_energy_after > capacity_kwh + 0.01` |
| Minimum reserve | `battery_energy_after < max(battery.minimum_energy_kwh, directive reserve for that hour) - 0.01`. The directive reserve applies only inside its `hours` window. |
| End-of-day neutrality | `abs(E_23 - initial_energy_kwh) > 0.01` |

Beyond the five required checks it also rejects negative values, charge/discharge above the rate limits, charging or discharging inside a `no_charge_window` / `no_discharge_window`, and grid above a `max_grid_window` cap, each with the same `0.01` tolerance. A deviation of 0.005 passes; 0.5 throws.

**Metrics** are recomputed from the plan, not taken from the solver: `total_grid_kwh = Σ grid_kwh`, `total_cost_bdt = Σ grid_kwh × tariff`, `peak_grid_kwh = max grid_kwh` (each rounded to 4 decimals). `plan_summary` is a one-paragraph string with the totals, the peak hour, solar used, battery charged/discharged, and how many operator notes applied as constraints.

### `app/health/route.ts`

`GET` returns HTTP 200 with exactly `{ "status": "ok" }`.

### `app/optimize-energy/route.ts`

`POST` is the whole pipeline: Zod validation → `interpretOperatorNotes` → `normalizeDirectives` → `optimizeSchedule` → `validateAndFormatPlan` → HTTP 200 with the response.

- **400 (bad request):** the body is read with `request.json()` inside its own `try/catch`, and the result goes through `OptimizeEnergyRequestSchema.safeParse()`. Unparseable JSON and structurally invalid bodies both produce HTTP 400 `{ "error": "Malformed JSON or structurally invalid request." }`. The pipeline never runs.
- **500 (internal failure):** the four pipeline steps sit in a second `try/catch`. Any throw (LP infeasibility, solver error, replay violation, unexpected bug) is logged server-side with `console.error` and answered with HTTP 500 `{ "error": "Internal server error while optimizing energy." }`. The response contains no message, stack trace, or environment detail from the underlying error.
- An LLM timeout or failure does not reach this handler: `interpretOperatorNotes` already degrades to all-`no_op` (Phase 2), so the request still succeeds with an unconstrained plan.

### Verification

`npx tsc --noEmit` is clean. Against the dev server: `GET /health` → 200 `{"status":"ok"}`; a body missing fields → 400; a non-JSON body → 400; a valid 24-hour payload → 200 with a full plan (no `GEMINI_API_KEY` is set, so the notes fell back to `no_op`). `replay.ts` was also exercised with a throwaway script (not committed) using real reserve and solar-reduction directives through the optimizer: the untampered plan passed, and tampering with the energy balance, solar usage, reserve, and end-of-day energy each threw. A 0.005 deviation passed. The 500 path was not triggered end to end, and nothing has been run against a live Gemini response.

---

## Not yet done

Per `PLAN.md`, still outstanding: Phase 6 (sample-case regression tests), Phase 7 (Docker/deploy), Phase 8 (README/video). Also outstanding: setting `GEMINI_API_KEY` so the full pipeline can be smoke-tested against the live API.
