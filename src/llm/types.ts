/**
 * Provider registry for the *optional* direct-LLM path of the params step.
 * This is a separate concern from the audio `MusicProvider` (src/synth/api):
 * here an LLM turns a prose description into the parameter JSON that the rest
 * of the deterministic pipeline consumes. Providers are dynamically imported,
 * so the default offline copy-paste flow never loads an SDK or touches a key.
 */
import type { z } from "zod";

export type ParamKind = "character" | "location";

export interface ParamGenRequest {
  kind: ParamKind;
  /** The full prompt (from characterPrompt/locationPrompt + any retry feedback). */
  prompt: string;
  /** Reduced Zod schema — the creative fields only (no id/seed/kind/schemaVersion). */
  zodSchema: z.ZodTypeAny;
  /** Same shape as a JSON Schema, for providers that take raw json_schema (Groq strict). */
  jsonSchema: Record<string, unknown>;
  model: string;
  apiKey: string;
  /** Optional pre-built SDK client — a test seam so unit tests inject a fake. */
  client?: unknown;
  signal?: AbortSignal;
}

export interface ParamLlmProvider {
  readonly name: string;
  /** Returns the raw object of the *reduced* creative fields. */
  generate(req: ParamGenRequest): Promise<unknown>;
}

const providers = new Map<string, ParamLlmProvider>();

export function registerParamProvider(p: ParamLlmProvider): void {
  providers.set(p.name, p);
}

export function getParamProvider(name: string): ParamLlmProvider {
  const p = providers.get(name);
  if (!p)
    throw new Error(
      `Unknown LLM provider "${name}". Available: ${[...providers.keys()].join(", ")}`,
    );
  return p;
}

export function listParamProviders(): ParamLlmProvider[] {
  return [...providers.values()];
}

// ---------- model catalog ----------

export interface ModelInfo {
  id: string;
  /** One-line note shown in the interactive picker. */
  note: string;
  /** Whether this model supports strict json_schema decoding (Groq); ignored for Anthropic. */
  strictJsonSchema: boolean;
}

export interface ProviderCatalog {
  provider: string;
  /** Env var checked for the API key before prompting. */
  envVar: string;
  defaultModel: string;
  models: ModelInfo[];
}

/**
 * Pricing/notes verified June 2026. Groq model availability drifts — re-check
 * https://console.groq.com/docs/models . Anthropic IDs/pricing from the
 * Anthropic models catalog (Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5).
 */
export const MODEL_CATALOG: ProviderCatalog[] = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    models: [
      {
        id: "claude-sonnet-4-6",
        note: "balanced, recommended ($3/$15 per Mtok)",
        strictJsonSchema: true,
      },
      { id: "claude-opus-4-8", note: "best taste, priciest ($5/$25)", strictJsonSchema: true },
      { id: "claude-haiku-4-5", note: "cheapest, fastest ($1/$5)", strictJsonSchema: true },
    ],
  },
  {
    provider: "groq",
    envVar: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    models: [
      {
        id: "openai/gpt-oss-120b",
        note: "recommended default; strict JSON (~$0.15/$0.75)",
        strictJsonSchema: true,
      },
      {
        id: "moonshotai/kimi-k2-instruct-0905",
        note: "strongest judgment; strict JSON (~$1/$3)",
        strictJsonSchema: true,
      },
      {
        id: "llama-3.3-70b-versatile",
        note: "solid workhorse; JSON mode (~$0.59/$0.79)",
        strictJsonSchema: false,
      },
      {
        id: "meta-llama/llama-4-maverick-17b-128e-instruct",
        note: "Llama 4 Maverick; JSON mode",
        strictJsonSchema: false,
      },
      {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        note: "smaller Llama 4; JSON mode",
        strictJsonSchema: false,
      },
      { id: "qwen3-32b", note: "Qwen3; JSON mode", strictJsonSchema: false },
      {
        id: "openai/gpt-oss-20b",
        note: "budget; strict JSON (~$0.075/$0.30)",
        strictJsonSchema: true,
      },
      {
        id: "llama-3.1-8b-instant",
        note: "cheapest/fastest; JSON mode (~$0.05/$0.08)",
        strictJsonSchema: false,
      },
    ],
  },
];

export function catalogFor(provider: string): ProviderCatalog {
  const c = MODEL_CATALOG.find((x) => x.provider === provider);
  if (!c) throw new Error(`No model catalog for provider "${provider}"`);
  return c;
}

export function modelInfo(provider: string, model: string): ModelInfo | undefined {
  return catalogFor(provider).models.find((m) => m.id === model);
}
