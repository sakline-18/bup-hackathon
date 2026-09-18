"use client";

import { useState } from "react";
import testCases from "@/tests.json";
import type { OptimizeEnergyRequest, OptimizeEnergyResponse } from "@/types/gridwise";

type TestCase = {
  id: string;
  label: string;
  input: OptimizeEnergyRequest;
};

const CASES = (testCases as { cases: TestCase[] }).cases;

function emptyHours() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    demand_kwh: 0,
    solar_kwh: 0,
    tariff_bdt_per_kwh: 0,
  }));
}

function emptyRequest(): OptimizeEnergyRequest {
  return {
    scenario_id: "CUSTOM-1",
    operator_notes: [""],
    hours: emptyHours(),
    battery: {
      capacity_kwh: 0,
      initial_energy_kwh: 0,
      minimum_energy_kwh: 0,
      max_charge_kwh_per_hour: 0,
      max_discharge_kwh_per_hour: 0,
    },
  };
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 dark:border-white/10 dark:bg-slate-900 dark:text-white dark:focus:ring-emerald-400/20";
const cellInputClass =
  "w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 outline-none transition-colors focus:border-emerald-400 focus:ring-1 focus:ring-emerald-100 dark:border-white/10 dark:bg-slate-900 dark:text-white";
const labelClass =
  "text-xs font-medium text-slate-600 dark:text-slate-400";

export default function OptimizeForm() {
  const [form, setForm] = useState<OptimizeEnergyRequest>(() => ({
    ...CASES[0].input,
    hours: CASES[0].input.hours.map((h) => ({ ...h })),
    battery: { ...CASES[0].input.battery },
    operator_notes: [...CASES[0].input.operator_notes],
  }));
  const [selectedCase, setSelectedCase] = useState(CASES[0].id);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [response, setResponse] = useState<OptimizeEnergyResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function loadCase(caseId: string) {
    setSelectedCase(caseId);
    if (caseId === "__blank__") {
      setForm(emptyRequest());
      return;
    }
    const found = CASES.find((c) => c.id === caseId);
    if (!found) return;
    setForm({
      ...found.input,
      hours: found.input.hours.map((h) => ({ ...h })),
      battery: { ...found.input.battery },
      operator_notes: [...found.input.operator_notes],
    });
  }

  function updateHour(
    hour: number,
    field: "demand_kwh" | "solar_kwh" | "tariff_bdt_per_kwh",
    value: number,
  ) {
    setForm((prev) => ({
      ...prev,
      hours: prev.hours.map((h) => (h.hour === hour ? { ...h, [field]: value } : h)),
    }));
  }

  function updateBattery(field: keyof OptimizeEnergyRequest["battery"], value: number) {
    setForm((prev) => ({
      ...prev,
      battery: { ...prev.battery, [field]: value },
    }));
  }

  function updateNote(index: number, value: string) {
    setForm((prev) => ({
      ...prev,
      operator_notes: prev.operator_notes.map((n, i) => (i === index ? value : n)),
    }));
  }

  function addNote() {
    setForm((prev) =>
      prev.operator_notes.length >= 3
        ? prev
        : { ...prev, operator_notes: [...prev.operator_notes, ""] },
    );
  }

  function removeNote(index: number) {
    setForm((prev) =>
      prev.operator_notes.length <= 1
        ? prev
        : { ...prev, operator_notes: prev.operator_notes.filter((_, i) => i !== index) },
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMessage(null);
    setResponse(null);
    try {
      const res = await fetch("/optimize-energy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data?.error ?? `Request failed with status ${res.status}`);
        setStatus("error");
        return;
      }
      setResponse(data as OptimizeEnergyResponse);
      setStatus("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Network error");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      {/* Sample case loader */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Load a sample case from tests.json</label>
          <select
            value={selectedCase}
            onChange={(e) => loadCase(e.target.value)}
            className={`${inputClass} sm:w-80`}
          >
            {CASES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} — {c.label}
              </option>
            ))}
            <option value="__blank__">Blank / custom scenario</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={status === "loading"}
          className="flex h-11 items-center justify-center rounded-full bg-emerald-500 px-6 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "loading" ? "Optimizing…" : "Run optimization"}
        </button>
      </div>

      {/* Scenario + battery */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>scenario_id</label>
          <input
            className={inputClass}
            value={form.scenario_id}
            onChange={(e) => setForm((p) => ({ ...p, scenario_id: e.target.value }))}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-900">
        <h3 className="mb-4 text-sm font-semibold text-slate-900 dark:text-white">
          Battery
        </h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {(
            [
              ["capacity_kwh", "Capacity (kWh)"],
              ["initial_energy_kwh", "Initial energy (kWh)"],
              ["minimum_energy_kwh", "Minimum reserve (kWh)"],
              ["max_charge_kwh_per_hour", "Max charge / hr"],
              ["max_discharge_kwh_per_hour", "Max discharge / hr"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="flex flex-col gap-1">
              <label className={labelClass}>{label}</label>
              <input
                type="number"
                step="any"
                className={inputClass}
                value={form.battery[field]}
                onChange={(e) => updateBattery(field, Number(e.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Operator notes */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            Operator notes (1–3)
          </h3>
          <button
            type="button"
            onClick={addNote}
            disabled={form.operator_notes.length >= 3}
            className="text-xs font-medium text-emerald-600 hover:underline disabled:opacity-40 disabled:no-underline dark:text-emerald-400"
          >
            + Add note
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {form.operator_notes.map((note, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={inputClass}
                value={note}
                placeholder={`Operator note ${i + 1}`}
                onChange={(e) => updateNote(i, e.target.value)}
              />
              {form.operator_notes.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeNote(i)}
                  className="text-xs font-medium text-slate-400 hover:text-red-500"
                  aria-label={`Remove note ${i + 1}`}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hourly inputs */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-900">
        <h3 className="mb-4 text-sm font-semibold text-slate-900 dark:text-white">
          24-hour readings
        </h3>
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100 dark:border-white/5">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Hour
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Demand (kWh)
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Solar (kWh)
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Tariff (BDT/kWh)
                </th>
              </tr>
            </thead>
            <tbody>
              {form.hours.map((h) => (
                <tr key={h.hour} className="border-t border-slate-100 dark:border-white/5">
                  <td className="px-3 py-1.5 text-xs font-mono text-slate-500 dark:text-slate-400">
                    {String(h.hour).padStart(2, "0")}:00
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      step="any"
                      className={cellInputClass}
                      value={h.demand_kwh}
                      onChange={(e) =>
                        updateHour(h.hour, "demand_kwh", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      step="any"
                      className={cellInputClass}
                      value={h.solar_kwh}
                      onChange={(e) =>
                        updateHour(h.hour, "solar_kwh", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      step="any"
                      className={cellInputClass}
                      value={h.tariff_bdt_per_kwh}
                      onChange={(e) =>
                        updateHour(h.hour, "tariff_bdt_per_kwh", Number(e.target.value))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Result */}
      {status === "error" && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300">
          {errorMessage}
        </div>
      )}

      {response && (
        <div className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 dark:border-emerald-400/20 dark:bg-emerald-400/5">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            Result — {response.scenario_id}
          </h3>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-white/10 dark:bg-slate-900">
              <div className="text-lg font-semibold text-slate-900 dark:text-white">
                {response.total_grid_kwh.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Total grid (kWh)
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-white/10 dark:bg-slate-900">
              <div className="text-lg font-semibold text-slate-900 dark:text-white">
                {response.total_cost_bdt.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Total cost (BDT)
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-white/10 dark:bg-slate-900">
              <div className="text-lg font-semibold text-slate-900 dark:text-white">
                {response.peak_grid_kwh.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Peak grid (kWh)
              </div>
            </div>
          </div>

          <p className="text-sm leading-6 text-slate-700 dark:text-slate-300">
            {response.plan_summary}
          </p>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-400">
              Directive interpretation
            </h4>
            <div className="flex flex-col gap-1.5">
              {response.directive_interpretation.map((d) => (
                <div
                  key={d.note_index}
                  className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs dark:border-white/10 dark:bg-slate-900"
                >
                  <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    note {d.note_index}
                  </span>{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {d.directive_type}
                  </span>{" "}
                  <span className="text-slate-400">({d.applies ? "applied" : "not applied"})</span>
                  <div className="mt-1 text-slate-500 dark:text-slate-400">{d.explanation}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-400">
              Hourly plan
            </h4>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-100 dark:border-white/5">
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                  <tr>
                    {["Hour", "Grid", "Solar", "Action", "Batt kWh", "Batt after"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {response.hourly_plan.map((p) => (
                    <tr key={p.hour} className="border-t border-slate-100 dark:border-white/5">
                      <td className="px-3 py-1 text-xs font-mono text-slate-500 dark:text-slate-400">
                        {String(p.hour).padStart(2, "0")}:00
                      </td>
                      <td className="px-3 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {p.grid_kwh.toFixed(2)}
                      </td>
                      <td className="px-3 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {p.solar_used_kwh.toFixed(2)}
                      </td>
                      <td className="px-3 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {p.battery_action}
                      </td>
                      <td className="px-3 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {p.battery_kwh.toFixed(2)}
                      </td>
                      <td className="px-3 py-1 text-xs text-slate-700 dark:text-slate-300">
                        {p.battery_energy_after_kwh.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
