/**
 * "Reduced" schemas for the direct-LLM path: the creative fields only.
 * schemaVersion/kind/id/seed are injected by our code (see generate.ts), never
 * by the model, so the structured-output surface is just the fields the LLM
 * actually decides. These mirror the field definitions in schema/params.ts
 * exactly, so a merged object re-validates cleanly with parseParams().
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  PitchClassSchema, ModeSchema, TempoSchema, ContourSchema, IntervalStyleSchema,
  RhythmFeelSchema, BrightnessSchema, WeightSchema, InstrumentSchema,
  TextureSchema, LayerLevelSchema, EventTypeSchema, DensitySchema, SpaceSchema,
} from "../schema/params.ts";
import type { ParamKind } from "./types.ts";

export const CharacterParamsLlmSchema = z
  .object({
    key: z.object({ tonic: PitchClassSchema, mode: ModeSchema }).strict(),
    baseTempo: TempoSchema,
    contour: ContourSchema,
    intervals: IntervalStyleSchema,
    rhythm: RhythmFeelSchema,
    brightness: BrightnessSchema,
    weight: WeightSchema,
    palette: z
      .object({
        lead: InstrumentSchema,
        harmony: InstrumentSchema,
        bass: InstrumentSchema,
        pad: InstrumentSchema,
      })
      .strict(),
  })
  .strict();

export const LocationParamsLlmSchema = z
  .object({
    layers: z
      .array(z.object({ texture: TextureSchema, level: LayerLevelSchema }).strict())
      .min(1)
      .max(3),
    events: z
      .array(z.object({ type: EventTypeSchema, density: DensitySchema }).strict())
      .max(3),
    brightness: BrightnessSchema,
    space: SpaceSchema,
  })
  .strict();

export function llmSchemaFor(kind: ParamKind): z.ZodTypeAny {
  return kind === "character" ? CharacterParamsLlmSchema : LocationParamsLlmSchema;
}

// Keywords OpenAI/Groq strict json_schema mode rejects; we strip them and let
// Zod re-enforce the bounds after the model answers (parseParams in generate.ts).
const STRICT_DROP = new Set([
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "pattern", "format", "multipleOf",
]);

function clean(node: unknown, strict: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n, strict));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$schema" || k === "additionalProperties") continue;
      if (strict && STRICT_DROP.has(k)) continue;
      out[k] = clean(v, strict);
    }
    // Strict mode requires every object closed and all properties required.
    if (out["type"] === "object" && out["properties"]) {
      out["additionalProperties"] = false;
      if (strict) out["required"] = Object.keys(out["properties"] as object);
    }
    return out;
  }
  return node;
}

/** Build a JSON Schema for the reduced Zod schema. `strict` tailors it for Groq's strict mode. */
export function toJsonSchema(schema: z.ZodTypeAny, opts: { strict: boolean }): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" });
  return clean(raw, opts.strict) as Record<string, unknown>;
}
