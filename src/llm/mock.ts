/**
 * Deterministic offline provider for tests. Returns a valid reduced object for
 * each kind so the generate() orchestrator (prompt → merge → parseParams) can
 * be exercised without a network or key.
 */
import type { ParamGenRequest, ParamLlmProvider } from "./types.ts";

export const mockParamProvider: ParamLlmProvider = {
  name: "mock",
  async generate(req: ParamGenRequest): Promise<unknown> {
    if (req.kind === "character") {
      return {
        key: { tonic: "C", mode: "ionian" },
        baseTempo: "medium",
        contour: "arch",
        intervals: "stepwise",
        rhythm: "even",
        brightness: "neutral",
        weight: "medium",
        palette: { lead: "piano", harmony: "strings", bass: "cello", pad: "warm_pad" },
      };
    }
    return {
      layers: [{ texture: "rain", level: "bg" }],
      events: [{ type: "droplets", density: "occasional" }],
      brightness: "neutral",
      space: "room",
    };
  },
};
