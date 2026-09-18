# GridWise LLM-Assisted Energy Optimization - Action Plan

This document outlines the step-by-step execution plan for the BUP CSE Fest 2026 GridWise challenge. It is designed to be executed sequentially in a Next.js + TypeScript environment.

## System Architecture & Technical Specifications

```text
[ POST /optimize-energy Request ]
               │
               ▼
┌───────────────────────────────┐
│   Phase 1: Input Validation   │  <-- Zod schema parsing (24 hours, battery, 1–3 notes)
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│  Phase 2: LLM Interpretation  │  <-- Fast Generative Model (Structured JSON output)
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Phase 3: Guardrail Normalizer │  <-- Deterministic verification (hours, factors, reserves)
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│   Phase 4: LP Math Solver     │  <-- javascript-lp-solver / glpk.js (24h optimization)
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Phase 5: Replay & Formatting  │  <-- Recalculate totals, verify limits, build summary
└──────────────┬────────────────┘
               │
               ▼
[ 200 OK Structured JSON Response ]
```

---

## Step-by-Step Implementation Action Plan

### Phase 1: Environment Setup & Type System
Establish the Next.js TypeScript project, strict runtime validation schemas, and optimization dependencies.

1. **Initialize the Next.js Standalone Project**:
   ```bash
   npx create-next-app@latest gridwise-api --typescript --tailwind=false --eslint --app --src-dir --import-alias "@/*"
   cd gridwise-api
   npm install zod javascript-lp-solver dotenv
   npm install --save-dev @types/javascript-lp-solver
   ```
   In `next.config.mjs`, enable standalone Docker output:
   ```javascript
   /** @type {import('next').NextConfig} */
   const nextConfig = {
     output: 'standalone',
   };
   export default nextConfig;
   ```

2. **Define Strict Data Contracts (`src/types/gridwise.ts`)**:
   Create Zod schemas for all input and output structures to enforce contract safety:
   *   `DirectiveType`: `'solar_reduction' | 'minimum_battery_reserve' | 'no_charge_window' | 'no_discharge_window' | 'max_grid_window' | 'no_op'`
   *   `BatteryAction`: `'charge' | 'discharge' | 'idle'`
   *   `HourInput`: `{ hour: number (0-23), demand_kwh: number, solar_kwh: number, tariff_bdt_per_kwh: number }`
   *   `BatteryInput`: `{ capacity_kwh: number, initial_energy_kwh: number, minimum_energy_kwh: number, max_charge_kwh_per_hour: number, max_discharge_kwh_per_hour: number }`
   *   `OptimizeEnergyRequest`: `{ scenario_id: string, operator_notes: string[], hours: HourInput[24], battery: BatteryInput }`
   *   `DirectiveInterpretation`: `{ note_index: number, applies: boolean, directive_type: DirectiveType, structured_adjustment: object | null, explanation: string }`
   *   `HourlyPlanEntry`: `{ hour: number, grid_kwh: number, solar_used_kwh: number, battery_action: BatteryAction, battery_kwh: number, battery_energy_after_kwh: number }`
   *   `OptimizeEnergyResponse`: `{ scenario_id: string, directive_interpretation: DirectiveInterpretation[], hourly_plan: HourlyPlanEntry[24], total_grid_kwh: number, total_cost_bdt: number, peak_grid_kwh: number, plan_summary: string }`

---

### Phase 2: LLM Interpretation Engine
The LLM converts unformatted operator notes into machine-readable directives. Low latency is critical to keep p95 latency under 5 seconds.

1. **Prompt Engineering (`src/services/llm.ts`)**:
   *   Use structured generation (e.g., `response_format: { type: "json_object" }` or Tool Calling).
   *   **System Prompt Rules**:
       1. Parse each note in `operator_notes` array by index `0..N-1`.
       2. Recognize 5 operational directives or map irrelevant/distractor text to `no_op` with `applies: false` and `structured_adjustment: null`.
       3. Convert time ranges using the **start-inclusive, end-exclusive** rule: e.g., "1 PM to 3 PM" -> hours `[13, 14]`. "noon until 2 PM" -> `[12, 13]`. "6 PM until 10 PM" -> `[18, 19, 20, 21]`.
       4. Normalize solar reduction factors to the **remaining usable fraction**: an 80% reduction means `factor: 0.2`.
       5. Calculate relative battery reserves using `battery.capacity_kwh`: e.g., "50% of capacity" for a 200 kWh battery -> `minimum_energy_kwh: 100`.
   *   Implement fallback retry logic with a strict 4-second timeout to handle provider errors without crashing.

---

### Phase 3: Deterministic Guardrails & Normalizer
Raw LLM output must not be passed directly to the solver; it must be filtered and validated through deterministic code.

1. **Implement Validation Layer (`src/services/guardrail.ts`)**:
   *   **Index & Cardinality Integrity**: Ensure exactly one entry per input note in ascending `note_index` order.
   *   **Hour Array Normalization**: Deduplicate hours, reject or drop values outside `0–23`, and sort strictly ascending: `[...new Set(hours)].filter(h => h >= 0 && h <= 23).sort((a, b) => a - b)`.
   *   **Adjustment Shape Invariants**:
       *   `solar_reduction`: Verify `factor` is a number in range `[0, 1]`.
       *   `minimum_battery_reserve`: Verify `minimum_energy_kwh` is finite, `>= 0`, and `<= capacity_kwh`.
       *   `max_grid_window`: Verify `max_grid_kwh` is finite and `>= 0`.
       *   `no_charge_window` / `no_discharge_window`: Verify `hours` array is present.
       *   `no_op`: Force `applies = false` and `structured_adjustment = null`.
   *   **Safe Failure Handling**: If an LLM response cannot be reconciled, fall back gracefully to `directive_type: "no_op"`, `applies: false`, `structured_adjustment: null` to avoid crashing.

---

### Phase 4: Linear Programming Math Optimizer
Model the 24-hour dispatch as a standard Linear Program (LP) to minimize total electricity purchase costs.

1. **Formulate Optimization Model (`src/services/optimizer.ts`)**:
   *   **Decision Variables (for each hour `h` in `[0..23]`)**:
       *   `g_h >= 0`: Grid electricity import (kWh)
       *   `s_h >= 0`: Solar energy utilized (kWh)
       *   `c_h >= 0`: Battery charging energy (kWh)
       *   `d_h >= 0`: Battery discharging energy (kWh)
       *   `E_h`: Battery state-of-charge at the end of hour `h`
   *   **Objective Function**:
       *   Minimize: Sum of `(g_h * tariff_bdt_per_kwh[h])` for all `h`.
   *   **Operational Constraints**:
       1. *Energy Balance (every hour)*: `g_h + s_h + d_h = demand_kwh[h] + c_h`
       2. *Solar Availability*: `0 <= s_h <= effective_solar[h]`
       3. *Battery Energy Dynamics*: 
          * `E_0 = initial_energy_kwh + c_0 - d_0`
          * `E_h = E_{h-1} + c_h - d_h`
       4. *Battery Storage Capacity & Reserves*: 
          * `E_h <= capacity_kwh`
          * `E_h >= max(minimum_energy_kwh, directive_reserve[h])`
       5. *Charge & Discharge Rate Limits*:
          * `c_h <= max_charge_kwh_per_hour` (force `c_h = 0` if `h` in `no_charge_window`)
          * `d_h <= max_discharge_kwh_per_hour` (force `d_h = 0` if `h` in `no_discharge_window`)
       6. *Feeder Grid Capacity*:
          * `g_h <= max_grid_kwh[h]` (if `h` in `max_grid_window`)
       7. *End-of-Day Battery Neutrality*: `E_23 = initial_energy_kwh`
   *   **Action Discretization & Clean-up**:
       *   Calculate Net Delta: `Δ = c_h - d_h`.
       *   If `Δ > 10^-4`: `battery_action = "charge"`, `battery_kwh = round(Δ, 4)`
       *   If `Δ < -10^-4`: `battery_action = "discharge"`, `battery_kwh = round(-Δ, 4)`
       *   Otherwise: `battery_action = "idle"`, `battery_kwh = 0`
       *   Recompute `E_h` sequentially using discrete actions to ensure exact floating-point consistency.

---

### Phase 5: Replay Engine, Metrics, and Route Handlers
Combine outputs and expose exact endpoints expected by the evaluation harness.

1. **Independent Replay Validator (`src/services/replay.ts`)**:
   *   Compute summary values: `total_grid_kwh`, `total_cost_bdt`, `peak_grid_kwh`.
   *   Verify all absolute errors against constraints are within `0.01 kWh / 0.01 BDT`.
   *   Construct `plan_summary` synthesizing key trade-offs.

2. **Implement Next.js Route Handlers**:
   *   **Readiness Endpoint (`src/app/health/route.ts`)**:
       ```typescript
       import { NextResponse } from 'next/server';
       export async function GET() {
         return NextResponse.json({ status: 'ok' }, { status: 200 });
       }
       ```
   *   **Optimization Endpoint (`src/app/optimize-energy/route.ts`)**:
       *   Accept POST JSON payload.
       *   Validate request shape via Zod (return HTTP 400 on invalidity).
       *   Execute: LLM Interpretation -> Guardrails -> LP Solver -> Replay Validator.
       *   Catch unexpected errors and return safe HTTP 500 without leaking stack traces or secrets.

---

### Phase 6: Local Validation & Regression Suite
Verify the system locally using all 10 public reference cases before deploying.

1. **Validation Test Runner (`scripts/test-samples.ts`)**:
   *   Iterate through `cases` in `BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json`.
   *   Assert `directive_interpretation` matches ground truth (`applies`, `directive_type`, `structured_adjustment`).
   *   Assert solver achieves optimal cost matching `expected_output.total_cost_bdt` within `0.01 BDT` tolerance.
   *   Assert end-of-day battery state matches `initial_energy_kwh` exactly.

---

### Phase 7: Docker Fallback & Deployment
Prepare a reproducible container build and ensure the live deployment is publicly accessible.

1. **Production Containerization (`Dockerfile`)**:
   *   Use multi-stage builds (`base`, `deps`, `builder`, `runner`).
   *   Copy `.next/standalone` output for minimal image size.
   *   Expose port 3000 and run standard `node server.js`.

2. **Container Testing & Publishing**:
   *   Build image: `docker build -t <username>/gridwise-solution:v1.0 .`
   *   Run locally: `docker run -p 3000:3000 -e LLM_API_KEY="..." <username>/gridwise-solution:v1.0`
   *   Test endpoints with curl.
   *   Push to public registry (DockerHub/GHCR).

3. **Live Cloud Deployment**:
   *   Deploy to Poridhi, AWS, GCP, Render, or Railway.
   *   Verify public internet reachability of `/health` and `/optimize-energy` (no VPN or auth walls).

---

### Phase 8: Documentation & 3-Minute Video Preparation
Fulfill repository policies and prepare the tie-breaker asset.

1. **Repository & README Guide (`README.md`)**:
   *   Keep repo private during development; set to public after the deadline.
   *   Include setup steps, env variables list (`LLM_API_KEY`, `LLM_MODEL`), run/test commands, and architecture notes.
   *   Ensure zero committed secrets in Git history.

2. **3-Minute Solution Video Script**:
   *   **0:00–0:45**: Problem overview (24h campus energy optimization under NLP constraints).
   *   **0:45–1:45**: Architecture walk-through (Next.js -> LLM parser -> guardrails -> LP solver -> replay).
   *   **1:45–2:30**: Guardrail enforcement and mathematical model formulation.
   *   **2:30–3:00**: Local reproduction demo, Docker execution, and public sample validation pass.