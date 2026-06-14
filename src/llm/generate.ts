/**
 * Orchestrates the direct-LLM params path: build the same prompt the
 * copy-paste flow prints, ask a provider for the creative fields, inject the
 * fields our code owns (schemaVersion/kind/id/seed), then run the existing Zod
 * parseParams() as the hard guarantee. On a validation failure we retry once
 * with the issues fed back to the model before giving up.
 */
import {
  parseParams,
  ParamValidationError,
  type Description,
  type Params,
} from "../schema/params.ts";
import { characterPrompt, locationPrompt } from "../schema/prompt.ts";
import { getParamProvider, registerParamProvider, type ParamKind } from "./types.ts";
import { llmSchemaFor, toJsonSchema } from "./schema.ts";
import { anthropicProvider } from "./anthropic.ts";
import { groqProvider } from "./groq.ts";
import { mockParamProvider } from "./mock.ts";

// Register the built-ins. Provider modules only define plain objects at load
// time; their SDKs are imported lazily inside generate(), so this stays offline.
registerParamProvider(anthropicProvider);
registerParamProvider(groqProvider);
registerParamProvider(mockParamProvider);

export interface GenerateParamsOptions {
  providerName: string;
  model: string;
  apiKey: string;
  desc: Description;
  seed: number;
  signal?: AbortSignal;
}

function basePrompt(desc: Description, seed: number): string {
  return desc.kind === "character" ? characterPrompt(desc, seed) : locationPrompt(desc, seed);
}

function mergeAndValidate(raw: unknown, desc: Description, seed: number, source: string): Params {
  // Our fields come last so a model can't override the id/seed/kind we own.
  const full = {
    ...(raw as Record<string, unknown>),
    schemaVersion: 1,
    kind: desc.kind,
    id: desc.id,
    seed,
  };
  return parseParams(full, source);
}

export async function generateParams(opts: GenerateParamsOptions): Promise<Params> {
  const { providerName, model, apiKey, desc, seed, signal } = opts;
  const provider = getParamProvider(providerName);
  const kind = desc.kind as ParamKind;
  const zodSchema = llmSchemaFor(kind);
  const jsonSchema = toJsonSchema(zodSchema, { strict: true });
  const source = `${providerName}:${model}`;

  const baseReq = { kind, zodSchema, jsonSchema, model, apiKey, ...(signal ? { signal } : {}) };

  const raw = await provider.generate({ ...baseReq, prompt: basePrompt(desc, seed) });
  try {
    return mergeAndValidate(raw, desc, seed, source);
  } catch (e) {
    if (!(e instanceof ParamValidationError)) throw e;
    // One corrective retry: tell the model exactly what was wrong.
    const issues = e.issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n");
    const retryPrompt =
      `${basePrompt(desc, seed)}\n\n` +
      `Your previous answer was invalid:\n${issues}\n` +
      `Return a corrected JSON object using only the allowed values.`;
    const raw2 = await provider.generate({ ...baseReq, prompt: retryPrompt });
    return mergeAndValidate(raw2, desc, seed, source);
  }
}
