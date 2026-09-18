import { NextResponse } from "next/server";
import { OptimizeEnergyRequestSchema } from "@/types/gridwise";
import { interpretOperatorNotes } from "@/src/services/llm";
import { normalizeDirectives } from "@/src/services/guardrail";
import { optimizeWithRecovery } from "@/src/services/optimizer";
import { validateAndFormatPlan } from "@/src/services/replay";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }

  const parsed = OptimizeEnergyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Malformed JSON or structurally invalid request." },
      { status: 400 },
    );
  }
  const req = parsed.data;

  try {
    const raw = await interpretOperatorNotes(req.operator_notes, req.battery);
    const directives = normalizeDirectives(
      raw,
      req.operator_notes.length,
      req.battery.capacity_kwh,
    );
    // Drops directives that make the LP infeasible instead of failing the request.
    const solved = optimizeWithRecovery(req.hours, req.battery, directives);
    const response = validateAndFormatPlan(req, solved.directives, solved.plan);
    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    // Full detail stays in server logs only; the client gets a generic message.
    console.error("[optimize-energy] pipeline failed:", err);
    return NextResponse.json(
      { error: "Internal server error while optimizing energy." },
      { status: 500 },
    );
  }
}
