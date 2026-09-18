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
| `solar_reduction` | `{ factor, hours? }` | `factor` missing, non-finite, or outside `[0, 1]`. `hours` is normalized and kept only if non-empty. |
| `minimum_battery_reserve` | `{ minimum_energy_kwh }` | missing, non-finite, `< 0`, or `> batteryCapacityKwh` |
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

- `solar_reduction` keeps its `hours` (the Phase 2 prompt has the LLM emit them and Phase 4's `effective_solar[h]` needs them), but the plan only requires validating `factor`, so an empty/missing `hours` is **not** a rejection. Phase 4 must decide what a solar reduction without hours means (e.g. all day).
- `max_grid_window` with empty hours is rejected, since a cap with no window is meaningless. The plan only said to normalize its hours.

### Verification

`npx tsc --noEmit` reports no errors in `guardrail.ts`. A throwaway script (not committed, per the "skip tests" default) exercised: `factor: 1.5` rejection, hallucinated extra fields dropped, hours `[15, 13, 13, 99, -1, 1.5]` → `[13, 15]`, out-of-order/duplicate/missing indices, `no_op` with a populated adjustment, negative `max_grid_kwh`, empty hours, and `undefined` input. All produced the expected output. `guardrail.ts` is not yet wired into a route handler — that happens in Phase 5.

---

## Not yet done

Per `PLAN.md`, still outstanding: Phase 4 (LP solver, needs `javascript-lp-solver`, not yet installed), Phase 5 (replay engine + route handlers — including wiring `interpretOperatorNotes` into the actual `/optimize-energy` handler), Phase 6 (sample-case regression tests), Phase 7 (Docker/deploy), Phase 8 (README/video). Also outstanding: setting `GEMINI_API_KEY` so Phase 2 can be smoke-tested against the live API.
