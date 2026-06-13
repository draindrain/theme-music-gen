/**
 * Offline tests for the direct-LLM params path. No network, no keys: providers
 * are exercised with injected fake SDK clients, and the orchestrator with the
 * deterministic mock provider.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateParams, registerParamProvider, type ParamLlmProvider,
} from "../src/index.ts";
import { CharacterParamsLlmSchema, LocationParamsLlmSchema, toJsonSchema } from "../src/llm/schema.ts";
import { anthropicProvider } from "../src/llm/anthropic.ts";
import { groqProvider } from "../src/llm/groq.ts";
import { chooseParamsMode } from "../src/cli/main.ts";
import { ParamValidationError, type Description } from "../src/schema/params.ts";

const charDesc: Description = { kind: "character", id: "test", name: "Test", description: "a hero" };
const locDesc: Description = { kind: "location", id: "place", name: "Place", description: "a cave" };

const validCharFields = {
  key: { tonic: "C", mode: "ionian" }, baseTempo: "medium", contour: "arch",
  intervals: "stepwise", rhythm: "even", brightness: "neutral", weight: "medium",
  palette: { lead: "piano", harmony: "strings", bass: "cello", pad: "warm_pad" },
};

/** Register a one-off provider that returns the given objects in sequence. */
function sequenceProvider(name: string, ...returns: unknown[]): void {
  let i = 0;
  const p: ParamLlmProvider = {
    name,
    async generate() { return returns[Math.min(i++, returns.length - 1)]; },
  };
  registerParamProvider(p);
}

describe("generateParams orchestrator", () => {
  it("merges our schemaVersion/kind/id/seed and validates (character)", async () => {
    const params = await generateParams({
      providerName: "mock", model: "x", apiKey: "", desc: charDesc, seed: 42,
    });
    expect(params.kind).toBe("character");
    expect(params.id).toBe("test");
    expect(params.seed).toBe(42);
    expect(params.schemaVersion).toBe(1);
  });

  it("works for locations too", async () => {
    const params = await generateParams({
      providerName: "mock", model: "x", apiKey: "", desc: locDesc, seed: 7,
    });
    expect(params.kind).toBe("location");
    expect(params.id).toBe("place");
  });

  it("uses our id/seed, not anything the model emits", async () => {
    sequenceProvider("seq-spoof", { ...validCharFields, id: "evil", seed: 999, schemaVersion: 7 });
    const params = await generateParams({
      providerName: "seq-spoof", model: "x", apiKey: "", desc: charDesc, seed: 123,
    });
    expect(params.id).toBe("test");
    expect(params.seed).toBe(123);
    expect(params.schemaVersion).toBe(1);
  });

  it("retries once with feedback when the first answer is invalid", async () => {
    sequenceProvider("seq-retry", { ...validCharFields, baseTempo: "warp_speed" }, validCharFields);
    const params = await generateParams({
      providerName: "seq-retry", model: "x", apiKey: "", desc: charDesc, seed: 1,
    });
    expect(params.kind).toBe("character");
  });

  it("throws ParamValidationError when invalid twice", async () => {
    const bad = { ...validCharFields, contour: "spiral" };
    sequenceProvider("seq-bad", bad, bad);
    await expect(
      generateParams({ providerName: "seq-bad", model: "x", apiKey: "", desc: charDesc, seed: 1 }),
    ).rejects.toBeInstanceOf(ParamValidationError);
  });
});

describe("toJsonSchema strict subset", () => {
  it("closes objects, requires all props, and drops min/max for strict", () => {
    const js = toJsonSchema(LocationParamsLlmSchema, { strict: true });
    const text = JSON.stringify(js);
    expect(text).not.toContain("minItems");
    expect(text).not.toContain("maxItems");
    expect(js["additionalProperties"]).toBe(false);
    expect((js["required"] as string[]).sort()).toEqual(["brightness", "events", "layers", "space"]);
  });

  it("keeps enums for character fields", () => {
    const js = toJsonSchema(CharacterParamsLlmSchema, { strict: true }) as Record<string, unknown>;
    const props = js["properties"] as Record<string, { enum?: string[] }>;
    expect(props["contour"]!.enum).toContain("arch");
  });
});

describe("groqProvider with injected client", () => {
  it("sends strict json_schema for a strict-capable model", async () => {
    let sent: Record<string, unknown> | undefined;
    const fake = {
      chat: { completions: { create: async (body: Record<string, unknown>) => {
        sent = body;
        return { choices: [{ message: { content: JSON.stringify(validCharFields) } }] };
      } } },
    };
    const out = await groqProvider.generate({
      kind: "character", prompt: "p", zodSchema: CharacterParamsLlmSchema,
      jsonSchema: toJsonSchema(CharacterParamsLlmSchema, { strict: true }),
      model: "openai/gpt-oss-120b", apiKey: "", client: fake,
    });
    expect((sent!["response_format"] as { type: string }).type).toBe("json_schema");
    expect((out as typeof validCharFields).baseTempo).toBe("medium");
  });

  it("falls back to json_object for non-strict models", async () => {
    let sent: Record<string, unknown> | undefined;
    const fake = {
      chat: { completions: { create: async (body: Record<string, unknown>) => {
        sent = body;
        return { choices: [{ message: { content: JSON.stringify(validCharFields) } }] };
      } } },
    };
    await groqProvider.generate({
      kind: "character", prompt: "p", zodSchema: CharacterParamsLlmSchema,
      jsonSchema: {}, model: "llama-3.3-70b-versatile", apiKey: "", client: fake,
    });
    expect((sent!["response_format"] as { type: string }).type).toBe("json_object");
  });
});

describe("anthropicProvider with injected client", () => {
  it("uses output_config.format json_schema and parses the text result", async () => {
    let sent: Record<string, unknown> | undefined;
    const fake = {
      messages: { create: async (body: Record<string, unknown>) => {
        sent = body;
        return { content: [{ type: "text", text: JSON.stringify(validCharFields) }], stop_reason: "end_turn" };
      } },
    };
    const out = await anthropicProvider.generate({
      kind: "character", prompt: "p", zodSchema: CharacterParamsLlmSchema,
      jsonSchema: toJsonSchema(CharacterParamsLlmSchema, { strict: true }),
      model: "claude-sonnet-4-6", apiKey: "", client: fake,
    });
    const fmt = (sent!["output_config"] as { format: { type: string } }).format;
    expect(fmt.type).toBe("json_schema");
    expect((out as typeof validCharFields).contour).toBe("arch");
  });

  it("throws on a refusal stop_reason", async () => {
    const fake = { messages: { create: async () => ({ content: [], stop_reason: "refusal" }) } };
    await expect(anthropicProvider.generate({
      kind: "character", prompt: "p", zodSchema: CharacterParamsLlmSchema,
      jsonSchema: {}, model: "claude-sonnet-4-6", apiKey: "", client: fake,
    })).rejects.toThrow();
  });
});

describe("chooseParamsMode", () => {
  it("ingest flag wins", () => {
    expect(chooseParamsMode({ hasIngest: true, isTTY: true })).toBe("ingest");
    expect(chooseParamsMode({ hasIngest: true, provider: "groq", isTTY: false })).toBe("ingest");
  });
  it("provider flag -> generate", () => {
    expect(chooseParamsMode({ hasIngest: false, provider: "anthropic", isTTY: false })).toBe("generate");
  });
  it("interactive with no flags -> menu", () => {
    expect(chooseParamsMode({ hasIngest: false, isTTY: true })).toBe("menu");
  });
  it("non-TTY with no flags -> prompt (backward compatible)", () => {
    expect(chooseParamsMode({ hasIngest: false, isTTY: false })).toBe("prompt");
  });
});

// Sanity: the reduced schemas accept the field objects the rest of the suite uses.
describe("reduced schemas", () => {
  it("accept valid fields", () => {
    expect(() => CharacterParamsLlmSchema.parse(validCharFields)).not.toThrow();
    expect(() => LocationParamsLlmSchema.parse({
      layers: [{ texture: "rain", level: "bg" }], events: [], brightness: "dark", space: "vast",
    })).not.toThrow();
  });
  it("reject unknown enum values", () => {
    expect(() => z.object({}).parse(null)).toThrow(); // z import sanity
    expect(() => CharacterParamsLlmSchema.parse({ ...validCharFields, weight: "huge" })).toThrow();
  });
});
