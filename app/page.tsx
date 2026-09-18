const pipeline = [
  {
    step: "01",
    title: "Input Validation",
    description: "Zod schemas parse 24 hourly readings, battery specs, and operator notes.",
  },
  {
    step: "02",
    title: "LLM Interpretation",
    description: "A fast generative model turns free-text notes into structured directives.",
  },
  {
    step: "03",
    title: "Guardrail Normalizer",
    description: "Deterministic checks clamp hours, factors, and reserves before they touch the solver.",
  },
  {
    step: "04",
    title: "LP Math Solver",
    description: "A linear program minimizes 24-hour grid cost under battery and feeder constraints.",
  },
  {
    step: "05",
    title: "Replay & Formatting",
    description: "Totals are recomputed independently and packaged into the response.",
  },
];

const stats = [
  { value: "24h", label: "Optimization horizon" },
  { value: "5", label: "Directive types" },
  { value: "<5s", label: "Target p95 latency" },
  { value: "±0.01", label: "kWh / BDT tolerance" },
];

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* Decorative background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-32 h-96 w-96 rounded-full bg-emerald-300/30 blur-3xl dark:bg-emerald-500/10" />
        <div className="absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-sky-300/30 blur-3xl dark:bg-sky-500/10" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:56px_56px]" />
      </div>

      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-lg text-white shadow-lg shadow-emerald-500/30">
            ⚡
          </span>
          <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            GridWise
          </span>
        </div>
        <a
          href="#pipeline"
          className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
        >
          View pipeline
        </a>
      </header>

      <main className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col gap-24 px-6 pb-24 sm:px-10">
        {/* Hero */}
        <section className="flex flex-col items-center gap-6 pt-16 text-center sm:pt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-xs font-medium text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300">
            BUP CSE Fest 2026 · GridWise Challenge
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-6xl dark:text-white">
            LLM-assisted energy optimization for smart campuses
          </h1>
          <p className="max-w-xl text-balance text-lg leading-8 text-slate-600 dark:text-slate-400">
            Operator notes go in plain English. A structured plan comes out: 24 hours of
            grid, solar, and battery dispatch, optimized to minimize cost while honoring
            every constraint.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <a
              href="#pipeline"
              className="flex h-11 items-center justify-center rounded-full bg-slate-900 px-6 text-sm font-medium text-white shadow-lg shadow-slate-900/10 transition-colors hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
            >
              Explore the pipeline
            </a>
            <a
              href="#stats"
              className="flex h-11 items-center justify-center rounded-full border border-slate-200 px-6 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
            >
              See the numbers
            </a>
          </div>
        </section>

        {/* Stats */}
        <section id="stats" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl border border-slate-200 bg-white/60 p-6 text-center shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-white/5"
            >
              <div className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
                {stat.value}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {stat.label}
              </div>
            </div>
          ))}
        </section>

        {/* Pipeline */}
        <section id="pipeline" className="flex flex-col gap-10 scroll-mt-24">
          <div className="flex flex-col items-center gap-2 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
              From free-text notes to an optimal dispatch plan
            </h2>
            <p className="max-w-lg text-sm text-slate-500 dark:text-slate-400">
              Every request flows through five deterministic stages before a plan is
              returned.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {pipeline.map((phase, i) => (
              <div key={phase.step} className="group relative flex flex-col gap-3">
                <div className="flex h-full flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md dark:border-white/10 dark:bg-slate-900">
                  <span className="text-xs font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    {phase.step}
                  </span>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {phase.title}
                  </h3>
                  <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {phase.description}
                  </p>
                </div>
                {i < pipeline.length - 1 && (
                  <span className="absolute top-1/2 -right-3 hidden -translate-y-1/2 text-slate-300 lg:block dark:text-slate-700">
                    →
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative border-t border-slate-200 py-8 text-center text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Built for the BUP CSE Fest 2026 GridWise challenge.
      </footer>
    </div>
  );
}
