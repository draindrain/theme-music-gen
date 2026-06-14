import { describe, expect, it } from "vitest";
import { MODES, PITCH_CLASSES } from "../src/schema/params.ts";
import {
  MODE_INTERVALS,
  degreeClass,
  degreeToMidi,
  maxVoiceMovement,
  scalePitchClasses,
  triadMidi,
  voiceLeadTriads,
} from "../src/theory/theory.ts";
import { MOOD_PROFILES } from "../src/compose/arrange.ts";

describe("degreeClass", () => {
  it("maps any integer degree to step 0..6 with true modulo", () => {
    expect([-14, -7, -1, 0, 1, 6, 7, 8, 14].map(degreeClass)).toEqual([0, 0, 6, 0, 1, 6, 0, 1, 0]);
  });
});

describe("scales", () => {
  it("every mode has 7 distinct intervals starting at 0", () => {
    for (const mode of MODES) {
      const ivs = MODE_INTERVALS[mode];
      expect(ivs).toHaveLength(7);
      expect(ivs[0]).toBe(0);
      expect(new Set(ivs).size).toBe(7);
    }
  });

  it("C ionian is the white keys", () => {
    expect([...scalePitchClasses({ tonic: "C", mode: "ionian" })].sort((a, b) => a - b)).toEqual([
      0, 2, 4, 5, 7, 9, 11,
    ]);
  });

  it("degreeToMidi maps tonic degree 0 to the tonic pitch class, octaves wrap", () => {
    expect(degreeToMidi({ tonic: "C", mode: "ionian" }, 0, 4)).toBe(60);
    expect(degreeToMidi({ tonic: "C", mode: "ionian" }, 7, 4)).toBe(72);
    expect(degreeToMidi({ tonic: "C", mode: "ionian" }, -7, 4)).toBe(48);
    expect(degreeToMidi({ tonic: "A", mode: "aeolian" }, 0, 4)).toBe(69);
  });

  it("diatonic triads stay inside the scale for every mode and degree", () => {
    for (const tonic of PITCH_CLASSES) {
      for (const mode of MODES) {
        const key = { tonic, mode };
        const scale = scalePitchClasses(key);
        for (let deg = 0; deg < 7; deg++) {
          for (const m of triadMidi(key, deg, 4)) {
            expect(scale.has(((m % 12) + 12) % 12)).toBe(true);
          }
        }
      }
    }
  });
});

describe("voice leading", () => {
  it("keeps per-voice movement small for every mood progression in every mode", () => {
    for (const mode of MODES) {
      const key = { tonic: "C" as const, mode };
      for (const profile of Object.values(MOOD_PROFILES)) {
        for (const prog of [profile.progressionA, profile.progressionB]) {
          const seq = [...prog, ...prog, prog[0]!];
          const voicings = voiceLeadTriads(key, seq, 4);
          expect(maxVoiceMovement(voicings)).toBeLessThanOrEqual(7);
          // chord tones remain in the scale after inversion shifts
          const scale = scalePitchClasses(key);
          for (const v of voicings)
            for (const m of v) expect(scale.has(((m % 12) + 12) % 12)).toBe(true);
        }
      }
    }
  });
});
