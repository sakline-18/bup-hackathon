import { GoogleGenAI, Type } from "@google/genai";
import type {
  BatteryInput,
  DirectiveInterpretation,
} from "../../types/gridwise";

const MODEL = "gemini-3.6-flash";
const TIMEOUT_MS = 4500;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// structured_adjustment is a single flat schema covering the union of every
// directive's fields (Gemini structured output does not reliably support
// per-branch conditional schemas). The prompt instructs the model to only
// populate the keys relevant to the chosen directive_type and leave the
// rest unset; Phase 3 guardrails independently validate the result.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    directives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          note_index: { type: Type.INTEGER },
          applies: { type: Type.BOOLEAN },
          directive_type: {
            type: Type.STRING,
            enum: [
              "solar_reduction",
              "minimum_battery_reserve",
              "no_charge_window",
              "no_discharge_window",
              "max_grid_window",
              "no_op",
            ],
          },
          structured_adjustment: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              hours: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
              },
              factor: { type: Type.NUMBER },
              minimum_energy_kwh: { type: Type.NUMBER },
              max_grid_kwh: { type: Type.NUMBER },
            },
          },
          explanation: { type: Type.STRING },
        },
        required: [
          "note_index",
          "applies",
          "directive_type",
          "structured_adjustment",
          "explanation",
        ],
        propertyOrdering: [
          "note_index",
          "applies",
          "directive_type",
          "structured_adjustment",
          "explanation",
        ],
      },
    },
  },
  required: ["directives"],
} as const;

function buildSystemPrompt(capacityKwh: number): string {
  return `You are the directive-interpretation engine for GridWise, a campus energy optimizer. You convert free-text operator notes into strict, structured directives. Follow these rules exactly.

1. ORDERING: The caller supplies an \`operator_notes\` array. Process each note sequentially by its index (0 to N-1) and return exactly one interpretation object per note, in ascending \`note_index\` order. Never skip, merge, or duplicate a note.

2. CATEGORIZATION: Classify each note into exactly one of these five directive types, or "no_op" if the note does not describe an actionable energy directive:
   - "solar_reduction": reduce usable solar generation during specific hours.
   - "minimum_battery_reserve": keep the battery above a minimum energy level.
   - "no_charge_window": forbid battery charging during specific hours.
   - "no_discharge_window": forbid battery discharging during specific hours.
   - "max_grid_window": cap grid import during specific hours.
   - "no_op": irrelevant, off-topic, or distractor text (weather chit-chat, unrelated announcements, notes that don't map to any of the four directives above). For "no_op" you MUST set applies: false and structured_adjustment: null.

3. TIME RANGES (start-inclusive, end-exclusive): Convert human time windows into an array of integer hours in 0-23. The end hour is EXCLUDED.
   - "1 PM to 3 PM" -> hours: [13, 14]   (NOT 15)
   - "noon until 2 PM" -> hours: [12, 13]   (NOT 14)
   - "6 PM until 10 PM" -> hours: [18, 19, 20, 21]   (NOT 22)
   Put the hours array under structured_adjustment.hours. This field applies to no_charge_window, no_discharge_window, and max_grid_window (as the window during which the cap applies).

4. SOLAR NORMALIZATION: For solar_reduction, convert a stated reduction percentage into the REMAINING usable fraction (1 - reduction), placed at structured_adjustment.factor.
   - "reduce solar by 80%" -> factor: 0.2
   - "cut solar in half" -> factor: 0.5
   Also include structured_adjustment.hours for the hours the reduction applies to, using the start-inclusive/end-exclusive rule above.

5. RELATIVE BATTERY RESERVES: For minimum_battery_reserve, convert a stated percentage of capacity into an absolute kWh value using the battery's capacity_kwh, which is ${capacityKwh} kWh for this request. Place the result at structured_adjustment.minimum_energy_kwh.
   - "keep at least 50% of capacity" with capacity_kwh=${capacityKwh} -> minimum_energy_kwh: ${capacityKwh * 0.5}
   If the note states an absolute kWh value directly, use it as-is.

6. MAX GRID WINDOW: For max_grid_window, place the numeric cap (in kWh) at structured_adjustment.max_grid_kwh and the applicable hours at structured_adjustment.hours.

7. FIELD DISCIPLINE: structured_adjustment must contain ONLY the fields relevant to the chosen directive_type (per rules 3-6 above). Do not populate unrelated fields. For "no_op", structured_adjustment must be null.

8. EXPLANATION: Provide a one-sentence, human-readable explanation of how you interpreted the note (or why it was classified as no_op).

Return your answer ONLY via the record_directives structure — one object per input note, no extra commentary.`;
}

function buildUserPrompt(notes: string[]): string {
  const numbered = notes.map((note, i) => `${i}: ${note}`).join("\n");
  return `operator_notes (index: text):\n${numbered}`;
}

function fallbackDirectives(notes: string[]): DirectiveInterpretation[] {
  return notes.map((_, i) => ({
    note_index: i,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: "LLM interpretation unavailable; defaulted to no_op.",
  }));
}

export async function interpretOperatorNotes(
  operatorNotes: string[],
  battery: BatteryInput,
): Promise<DirectiveInterpretation[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: buildUserPrompt(operatorNotes),
      config: {
        systemInstruction: buildSystemPrompt(battery.capacity_kwh),
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
        maxOutputTokens: 2048,
        abortSignal: controller.signal,
        httpOptions: { timeout: TIMEOUT_MS },
      },
    });

    const text = result.text;
    if (!text) {
      return fallbackDirectives(operatorNotes);
    }

    const parsed = JSON.parse(text) as {
      directives?: DirectiveInterpretation[];
    };

    if (!parsed.directives || !Array.isArray(parsed.directives)) {
      return fallbackDirectives(operatorNotes);
    }

    return parsed.directives;
  } catch {
    // Timeout, abort, network error, or malformed JSON — never crash the
    // request. Degrade to no_op for every note; Phase 3 guardrails and the
    // solver operate correctly on an all-no_op interpretation.
    return fallbackDirectives(operatorNotes);
  } finally {
    clearTimeout(timer);
  }
}
