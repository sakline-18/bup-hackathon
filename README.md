# GridWise — LLM-assisted campus energy optimizer

GridWise is an HTTP API. You give it a 24-hour energy scenario (demand, solar, electricity tariff, battery) plus 1–3 **free-text operator notes** such as *"Facilities will wash the rooftop solar panels from noon until 2 PM, usable solar is about 25%"*. It returns the **cheapest valid hour-by-hour schedule** that respects those notes.

The interesting part is how it gets from English to a schedule without trusting the language model with the maths:

1. A **language model** turns each note into a small structured directive (the only thing it does).
2. A **deterministic guardrail** checks and cleans that output.
3. A **linear-programming solver** finds the cheapest plan under the directives.
4. An **independent replay validator** re-checks the plan against every physical rule before it is returned.

> Built for the BUP CSE Fest 2026 hackathon (GridWise LLM challenge). The judged surface is the API; the web page at `/` is only a static landing page.

---

## Contents

- [Quickstart](#quickstart)
- [API reference](#api-reference)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing and results](#testing-and-results)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)
- [Further documentation](#further-documentation)

---

## Quickstart

**Prerequisites:** Node.js 20.9 or newer (22.18+ for `npm run test:types`; developed on Node 24), npm, and a free [Groq API key](https://console.groq.com).

```bash
git clone <this-repo-url>
cd <repo-folder>
npm install
```

Create a file named `.env.local` in the project root (it is git-ignored) and put your key in it:

```
GROQ_API_KEY=your_groq_api_key_here
```

Start the server:

```bash
npm run dev
```

The API is now at `http://localhost:3000`. Check it is ready:

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok"}`

Send a real scenario (this uses the second case from the public sample file, `tests.json`):

```bash
node -e 'console.log(JSON.stringify(require("./tests.json").cases[1].input))' | curl -s -X POST http://localhost:3000/optimize-energy -H 'content-type: application/json' -d @-
```

Run all 10 public sample cases and check them against the expected answers:

```bash
npm run test:samples
```

For a production build instead of dev mode: `npm run build && npm start`.

> **No key?** The server still starts and every endpoint responds, but the language model is skipped and **every note is treated as `no_op`** (ignored). You will see `LLM interpretation unavailable` in each `explanation`, and a warning in the server log.

---

## API reference

### `GET /health`

Readiness check. Returns HTTP 200 and:

```json
{ "status": "ok" }
```

### `POST /optimize-energy`

Accepts one JSON object and returns one JSON object. No authentication.

**Request**

| Field | Type | Rules |
|---|---|---|
| `scenario_id` | string | Echoed back in the response. |
| `operator_notes` | string[] | 1 to 3 notes. |
| `hours` | object[] | Exactly 24 entries, hours 0–23. Each: `{ hour, demand_kwh, solar_kwh, tariff_bdt_per_kwh }`. |
| `battery` | object | `{ capacity_kwh, initial_energy_kwh, minimum_energy_kwh, max_charge_kwh_per_hour, max_discharge_kwh_per_hour }` |

Abbreviated example (the `...` lines are not valid JSON; use `tests.json` for full, runnable inputs):

```jsonc
{
  "scenario_id": "SAMPLE-02",
  "operator_notes": [
    "The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance."
  ],
  "hours": [
    { "hour": 0, "demand_kwh": 100, "solar_kwh": 0, "tariff_bdt_per_kwh": 6 },
    ... 22 more rows ...
  ],
  "battery": {
    "capacity_kwh": 200, "initial_energy_kwh": 70, "minimum_energy_kwh": 30,
    "max_charge_kwh_per_hour": 55, "max_discharge_kwh_per_hour": 55
  }
}
```

**Response (HTTP 200)**

| Field | Meaning |
|---|---|
| `scenario_id` | Copied from the request. |
| `directive_interpretation` | Exactly one entry per note, in note order: `{ note_index, applies, directive_type, structured_adjustment, explanation }`. |
| `hourly_plan` | 24 entries: `{ hour, grid_kwh, solar_used_kwh, battery_action, battery_kwh, battery_energy_after_kwh }`. `battery_action` is `charge`, `discharge` or `idle`. |
| `total_grid_kwh`, `total_cost_bdt`, `peak_grid_kwh` | Recomputed from `hourly_plan`, so they always agree with it. |
| `plan_summary` | One short human-readable paragraph. |

Real (abbreviated) response for the request above:

```jsonc
{
  "scenario_id": "SAMPLE-02",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "no_charge_window",
      "structured_adjustment": { "hours": [2, 3, 4] },
      "explanation": "The note specifies a maintenance period during which battery charging is prohibited from 2 AM to 5 AM."
    }
  ],
  "hourly_plan": [
    { "hour": 0, "grid_kwh": 120, "solar_used_kwh": 0, "battery_action": "charge", "battery_kwh": 20, "battery_energy_after_kwh": 90 },
    ... 22 more entries ...
    { "hour": 23, "grid_kwh": 155, "solar_used_kwh": 0, "battery_action": "charge", "battery_kwh": 40, "battery_energy_after_kwh": 70 }
  ],
  "total_grid_kwh": 2915,
  "total_cost_bdt": 42885,
  "peak_grid_kwh": 180,
  "plan_summary": "Imports 2915.00 kWh from the grid for 42885.00 BDT, peaking at 180.00 kWh in hour 21. Uses 675.00 kWh of solar; the battery charges 280.00 kWh and discharges 280.00 kWh, ending the day at its starting level. 1 of 1 operator note(s) applied as constraints."
}
```

**Errors**

| Status | When | Body |
|---|---|---|
| 400 | The body is not valid JSON, or does not match the request schema (wrong hour count, duplicate/missing hours, negative values, battery not satisfying minimum ≤ initial ≤ capacity, empty or more than 3 notes, ...). | `{"error":"Malformed JSON or structurally invalid request."}` |
| 422 | The input is valid but no schedule can satisfy it even with every directive dropped. | `{"error":"No feasible schedule exists for the given hours and battery limits."}` |
| 500 | Something unrecoverable failed after validation. Details go to the server log only. | `{"error":"Internal server error while optimizing energy."}` |

Error bodies never include stack traces, keys or internal messages.

### The six directive types

Each operator note maps to exactly one of these (or to `no_op`):

| `directive_type` | Meaning | `structured_adjustment` |
|---|---|---|
| `solar_reduction` | Usable solar is reduced during some hours. | `{ factor, hours }`. `factor` is the fraction that **remains** (an 80% reduction is `0.2`). |
| `minimum_battery_reserve` | Keep the battery above a level during some hours. | `{ minimum_energy_kwh, hours }` |
| `no_charge_window` | The battery may not charge during some hours. | `{ hours }` |
| `no_discharge_window` | The battery may not discharge during some hours. | `{ hours }` |
| `max_grid_window` | Grid import is capped during some hours. | `{ max_grid_kwh, hours }` |
| `no_op` | Irrelevant note (a distractor). | `null`, with `applies: false` |

`hours` is a list of whole hours 0–23. Windows are **start-inclusive, end-exclusive**: "1 PM to 3 PM" is `[13, 14]`.

---

## How it works

```
   POST /optimize-energy
            │
            ▼
┌──────────────────────────┐   invalid ──▶ HTTP 400
│ 1. Request validation    │
│    (Zod schema)          │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐   Groq API, model chain, 4.5 s budget
│ 2. LLM interpretation    │   every failure ──▶ notes become no_op
│    notes ─▶ directives   │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐   rejects anything malformed ──▶ no_op
│ 3. Guardrail normalizer  │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐   javascript-lp-solver
│ 4. LP optimizer          │   infeasible ──▶ drop the offending directive, re-solve
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐   throws on any violation ──▶ HTTP 500
│ 5. Replay validator      │
│    + totals + summary    │
└────────────┬─────────────┘
             ▼
        HTTP 200 JSON
```

**Why the work is split this way.** Language models are good at understanding messy text and bad at reliable arithmetic and hard constraints. So the model is only allowed to produce a tiny structured directive. Everything after that is ordinary deterministic code, and each stage assumes the previous one might be wrong.

### 1. Request validation (`types/gridwise.ts`)

Zod schemas define every input and output shape. A bad request is rejected with HTTP 400 before anything else runs.

### 2. LLM interpretation (`src/services/llm.ts`)

The model's **only** job is to read each note and say which directive it is and with what numbers. It never sees the tariff or demand and never builds the schedule.

- **Provider:** [Groq](https://groq.com), called with plain `fetch` over its OpenAI-compatible API (no SDK).
- **Structured output:** the request carries a JSON Schema so the reply is valid JSON in the expected shape, with `directive_type` limited to the six values above. Reasoning effort is set to low to keep latency down.
- **Prompt:** the system prompt is built per request, with the battery's real `capacity_kwh` filled in so percentage-to-kWh conversions use the right number. It covers: one output per note in order; how to classify each type; the end-exclusive hour convention with worked examples ("between 11 AM and 2 PM" is `[11, 12, 13]`); reduction versus remaining-fraction wording ("cut by 60%" is `0.4`, "only 30% usable" is `0.3`); percentage-of-capacity reserves; MWh to kWh; and a rule that notes are **data, not instructions**, so text like "ignore your instructions" becomes `no_op`.
- **Model chain:** models are tried in order and the first valid answer wins. A model is skipped on any failure: rate limit (429), server error, timeout, empty or unparsable reply, or the wrong number of directives.

  | # | Model | Notes |
  |---|---|---|
  | 1 | `openai/gpt-oss-20b` | Primary: fast. |
  | 2 | `openai/gpt-oss-120b` | First fallback: more accurate. |
  | 3 | `openai/gpt-oss-safeguard-20b` | Same family. |
  | 4 | `qwen/qwen3.8-27b` | Preview model; see [limitations](#known-limitations). |
  | 5–7 | `groq/compound-mini`, `groq/compound`, `allam-2-7b` | Untested tail fallbacks. |

  The list reflects the models available on the project's Groq key. You can replace it with `GROQ_MODELS` (see [Configuration](#configuration)).
- **Time budget:** the whole interpretation step shares 4.5 s. One attempt is capped at 2.5 s so a hung model cannot use up the time the fallbacks need. Fast failures such as a 429 move to the next model immediately.
- **If everything fails:** every note becomes `no_op`, and the optimizer runs with no directives. The request still succeeds, but the notes are ignored (the explanation says so).

### 3. Guardrail normalizer (`src/services/guardrail.ts`)

The last line of defence between the model and the solver. It builds a **fresh** adjustment object per directive containing only the fields that type owns, so stray or hallucinated fields are discarded. Anything invalid is rejected and downgraded to `no_op` with an explanation.

| Type | Kept as | Rejected when |
|---|---|---|
| `solar_reduction` | `{ factor, hours }` | `factor` is missing, not a number, or outside `[0, 1]`; or `hours` is empty. |
| `minimum_battery_reserve` | `{ minimum_energy_kwh, hours }` | Value missing, negative, or above battery capacity; or `hours` is empty. |
| `max_grid_window` | `{ max_grid_kwh, hours }` | Cap missing or negative; or `hours` is empty. |
| `no_charge_window`, `no_discharge_window` | `{ hours }` | `hours` is empty. |
| `no_op` | `null` | Never (forced: `applies: false`). |

It also guarantees:
- Exactly one entry per note, ordered `0..N-1`. Missing entries become `no_op`, duplicates are dropped, and out-of-range indexes are ignored.
- Hours are cleaned: non-integers and values outside 0–23 are dropped, duplicates removed, and the list sorted ascending.
- A directive the model marked as not applying is forced to `no_op`.
- It never throws and never mutates its input.

Every directive that needs a window **must** carry a non-empty `hours` list. This catches models that return a plausible-looking directive with no window.

### 4. LP optimizer (`src/services/optimizer.ts`)

The problem is a linear program solved exactly with [`javascript-lp-solver`](https://www.npmjs.com/package/javascript-lp-solver). For each hour `h` there are five variables: grid import `g`, solar used `s`, battery charge `c`, battery discharge `d`, and battery energy `E` at the end of the hour.

**Minimise:** total grid cost `Σ g·tariff`, plus a tiny cost (0.0001) on every charge and discharge. That penalty stops the solver from making pointless charge/discharge pairs when tariffs are flat.

**Subject to, for every hour:**

| Constraint | Meaning |
|---|---|
| `g + s + d − c = demand` | Energy balance. |
| `s ≤ solar × factor` | Solar limit, reduced by any `solar_reduction` covering that hour. |
| `c ≤ max charge`, `d ≤ max discharge` | Rate limits. Set to 0 inside `no_charge_window` / `no_discharge_window`. |
| `g ≤ cap` | Only inside a `max_grid_window`. |
| `max(battery minimum, directive reserve) ≤ E ≤ capacity` | Reserve applies **only in the hours the directive names**. |
| `E_h = E_(h−1) + c − d` | Battery state; starts from `initial_energy_kwh`. |
| `E_23 = initial_energy_kwh` | End-of-day neutrality: the battery may not be used as a free one-time energy source. |

Overlapping directives combine sensibly: solar factors multiply, reserves take the maximum, grid caps take the minimum.

**Cleaning the solver output.** Raw LP output can contain values like `4.999999999997`. The plan is rebuilt hour by hour: net battery movement is rounded to 4 decimals and turned into `charge`, `discharge` or `idle` (movements under 0.0001 count as idle); energy is carried forward from the rounded values; hour 23 is forced to close exactly back to the initial energy; and `grid_kwh` is recomputed as the leftover so every hour's balance stays exact.

**Recovering from impossible directives.** A directive can be valid in shape yet impossible in practice (for example a grid cap of 10 kWh when demand is 150 kWh, or a unit slip like `0.18` instead of `180`). If the LP is infeasible, the optimizer tries the largest subset of directives that *is* feasible (earlier notes win ties). Dropped directives are rewritten as `no_op` with an `Ignored: ... made the schedule infeasible` explanation, so the response stays honest about what was applied. If the problem is infeasible even with **no** directives, the input itself is at fault and the request fails with HTTP 422.

### 5. Replay validator (`src/services/replay.ts`)

A separate check that trusts nothing from the solver. It re-derives the limits from the directives with its own code and walks the 24 hours, throwing on the first violation (absolute tolerance **0.01**):

- Energy balance holds each hour.
- Solar used is within the (possibly reduced) available solar.
- Battery energy follows from the previous hour plus the action, stays under capacity, and stays above the minimum and any reserve in its window.
- Charge and discharge respect the rate limits and the no-charge / no-discharge windows; grid respects any cap.
- No negative values.
- The battery ends the day at its initial energy.

If it passes, `total_grid_kwh`, `total_cost_bdt` and `peak_grid_kwh` are **recalculated from the plan** and `plan_summary` is generated. A failure here means the optimizer produced a bad plan, so the request returns HTTP 500 rather than a wrong answer.

### Error handling summary

| Situation | Result |
|---|---|
| Bad or malformed request | HTTP 400. |
| LLM down, slow, rate-limited or returns junk | Next model in the chain, then `no_op` for every note. The request still returns 200. |
| LLM output malformed for one note | That note becomes `no_op`. |
| Directive impossible to satisfy | Directive dropped and re-solved; request returns 200. |
| Infeasible even with no directives | HTTP 422. |
| Solver crash, replay violation, or response schema violation | HTTP 500 with a generic message. |

---

## Configuration

Set these as environment variables, in `.env.local` locally or in your host's dashboard when deployed. Only names are documented here; never commit values.

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | Yes | Groq API key. Without it every note is treated as `no_op`. |
| `GROQ_MODELS` | No | Comma-separated model list that replaces the default chain, e.g. `GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b`. |

Server-only variables: neither is exposed to the browser. `.env*` files are git-ignored.

---

## Deployment

**Vercel (used for the live endpoint).** Push the repo to GitHub, import it at [vercel.com/new](https://vercel.com/new) (Next.js is detected automatically, no build settings to change), add `GROQ_API_KEY` under **Environment Variables**, and deploy. Env vars only apply to new builds, so redeploy after adding one. Check that the production URL works while logged out of Vercel (no login wall), then:

```bash
curl https://YOUR-APP.vercel.app/health
```

```bash
BASE_URL=https://YOUR-APP.vercel.app npm run test:samples
```

Any Node host works: `npm run build && npm start` serves on port 3000.

**Docker.** A Dockerfile and published image are **not included yet**. Until one is added, use the source quickstart above.

---

## Testing and results

| Command | What it checks |
|---|---|
| `npm run test:samples` | Runs all 10 cases in `tests.json` against a running server (`BASE_URL` selects which). Checks each note's `applies`, `directive_type` and adjustment (hour and key order ignored), total cost within 0.01 BDT, and that the battery ends at its initial energy. |
| `npm run test:types` | Validates the Zod schemas with valid and invalid data (19 checks). |
| `npx tsc --noEmit` | Type check. |

**Results** (last full run, live Groq API):

- **10 / 10 sample cases pass** end to end. Observed request time was roughly 0.4–2.2 s.
- Every case matches the reference `total_cost_bdt` and `total_grid_kwh` exactly.
- **Model accuracy.** The first four models were each run on the 10 samples plus 23 extra notes written to be tricky (percentage wording, "only X% usable", windows ending at midnight or wrapping past it, MWh units, distractors, a cancelled event, a prompt-injection attempt, note ordering). `gpt-oss-20b`, `gpt-oss-120b` and `gpt-oss-safeguard-20b` each got 43/43 directives right; `qwen/qwen3.8-27b` got 33/43 (see below). These extra notes were written after seeing the samples and several prompt lines were added to fix failures they exposed, so the result shows the fixes work, not that unseen wording is guaranteed.
- **Plans can differ from the reference and still be correct.** Many schedules have the same optimal cost. Our hourly plans differ from the reference plans. Among cost-optimal plans the optimizer runs a second LP pass that minimizes the peak hourly grid import, so `peak_grid_kwh` matches the reference on all 10 samples. The challenge rules say equivalent optimal schedules are accepted and that reported totals must match the returned plan, which they do.

---

## Project structure

```
app/
  page.tsx                    Static landing page (no form)
  health/route.ts             GET /health
  optimize-energy/route.ts    POST /optimize-energy (runs the whole pipeline)
src/services/
  llm.ts                      Stage 2: Groq model chain, prompt, fallbacks
  guardrail.ts                Stage 3: validation and normalization
  optimizer.ts                Stage 4: LP model + infeasibility recovery
  replay.ts                   Stage 5: independent checker, totals, summary
types/gridwise.ts             Zod schemas and TypeScript types for every shape
scripts/
  test-samples.mjs            End-to-end runner for tests.json
  test-gridwise-types.ts      Schema tests
tests.json                    The 10 public sample cases with expected outputs
DOC.md                        Detailed implementation log
PLAN.md                       Original implementation plan
```

**Stack:** Next.js 16 (App Router), TypeScript, Zod, `javascript-lp-solver`, Groq API. No database; nothing is stored between requests.

---

## Known limitations

- **No input form.** The site is a static landing page. Use the API directly (curl, Postman, or the test script).
- **Groq free-tier limits.** Each model was seen limited to about 8,000 tokens per minute, and one request uses roughly 1.5–2k tokens, so about 4 requests per minute per model. Bursts are absorbed by the fallback chain, but sustained load falls through to weaker models or to `no_op`. The paid tier removes this.
- **A silent `no_op` fallback still returns HTTP 200.** If every model fails, the plan is valid but ignores the notes; only the `explanation` text says so.
- **`qwen/qwen3.8-27b` is inaccurate on hour windows:** it consistently drops the last hour of windows of three or more hours. It only answers if the three gpt-oss models above it all fail.
- **The last three models in the chain have never answered a request** and were not accuracy-tested. The guardrail still validates whatever they return.
- **Prompt injection is only mitigated in the prompt.** Code cannot tell an injected "no solar all day" from a genuine one, since both are valid directives.
- **Dropping is not repairing.** When a directive is infeasible, the whole directive is ignored; the system does not try to fix its value. A wrong-but-feasible value (such as a slightly wrong hour window) is still applied.
- **One directive per note.** A note that contains two separate rules is mapped to one directive.
- **Cold starts.** On serverless hosting the first request after idle is slower.
- **No Docker image yet.**

---

## Further documentation

- [DOC.md](DOC.md) is the detailed implementation log: design decisions, the reasons behind them, the Gemini-to-Groq switch, the accuracy tests, and every bug found along the way.
- [PLAN.md](PLAN.md) is the original plan the project followed.
