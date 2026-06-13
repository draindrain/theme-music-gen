/**
 * Anthropic provider for the params step. Uses the official @anthropic-ai/sdk
 * structured-outputs API: messages.create() with output_config.format set to a
 * json_schema, which constrains the response to our reduced schema. We pass the
 * JSON Schema directly (built with the strict subset, so no unsupported
 * constraints) and JSON.parse the text result; the hard guarantee remains the
 * Zod parseParams() call in generate.ts. Imported dynamically so the offline
 * copy-paste path never loads the SDK.
 *
 * (We deliberately avoid the SDK's zodOutputFormat helper: its types/runtime
 * target zod v4 schemas, while this project pins zod v3.)
 */
import type { ParamGenRequest, ParamLlmProvider } from "./types.ts";

export const anthropicProvider: ParamLlmProvider = {
  name: "anthropic",
  async generate(req: ParamGenRequest): Promise<unknown> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = (req.client as InstanceType<typeof Anthropic>) ?? new Anthropic({ apiKey: req.apiKey });

    const resp = await client.messages.create(
      {
        model: req.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { format: { type: "json_schema", schema: req.jsonSchema } },
      },
      req.signal ? { signal: req.signal } : undefined,
    );

    if (resp.stop_reason === "refusal") throw new Error("Anthropic declined the request (refusal)");
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (!text) throw new Error(`Anthropic returned no text (stop_reason=${resp.stop_reason ?? "unknown"})`);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Anthropic response was not valid JSON: ${(e as Error).message}`);
    }
  },
};
