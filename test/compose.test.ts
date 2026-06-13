import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeScore } from "../src/compose/arrange.ts";
import { generateTheme } from "../src/compose/theme.ts";
import { MOODS, parseCharacterParams, type CharacterParams } from "../src/schema/params.ts";
import { loopBeats } from "../src/score/types.ts";
import { scalePitchClasses } from "../src/theory/theory.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "characters");
const characters: CharacterParams[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".params.json"))
  .map((f) => parseCharacterParams(JSON.parse(readFileSync(join(FIXTURES, f), "utf8")), f));

describe("leitmotif identity", () => {
  it("same character, same theme across ALL moods (degrees + rhythm identical)", () => {
    for (const ch of characters) {
      const themes = MOODS.map((m) => composeScore(ch, m).meta.theme);
      for (const t of themes.slice(1)) {
        expect(t.degrees).toEqual(themes[0]!.degrees);
        expect(t.onsets).toEqual(themes[0]!.onsets);
        expect(t.durations).toEqual(themes[0]!.durations);
      }
    }
  });

  it("the lead track actually opens with the theme (degrees realized as pitches)", () => {
    for (const ch of characters) {
      for (const mood of ["happy", "sad"] as const) {
        const score = composeScore(ch, mood);
        const theme = score.meta.theme;
        const lead = score.tracks.find((t) => t.role === "lead")!;
        const opening = lead.notes
          .filter((n) => n.startBeat < 8)
          .sort((a, b) => a.startBeat - b.startBeat);
        expect(opening.length).toBe(theme.degrees.length);
        // contour identity: successive pitch differences have the same sign
        // pattern as the theme's degree differences in every mood
        for (let i = 1; i < opening.length; i++) {
          const dPitch = Math.sign(opening[i]!.midi - opening[i - 1]!.midi);
          const dDeg = Math.sign(theme.degrees[i]! - theme.degrees[i - 1]!);
          expect(dPitch).toBe(dDeg);
        }
      }
    }
  });

  it("different characters get clearly distinct themes", () => {
    expect(characters.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < characters.length; i++) {
      for (let j = i + 1; j < characters.length; j++) {
        const a = generateTheme(characters[i]!);
        const b = generateTheme(characters[j]!);
        const same =
          JSON.stringify(a.degrees) === JSON.stringify(b.degrees) &&
          JSON.stringify(a.onsets) === JSON.stringify(b.onsets);
        expect(same).toBe(false);
      }
    }
  });

  it("themes are deterministic: same params -> identical score, different seed -> different theme", () => {
    const ch = characters[0]!;
    expect(composeScore(ch, "tender")).toEqual(composeScore(ch, "tender"));
    const reseeded = { ...ch, seed: (ch.seed + 1) >>> 0 };
    expect(JSON.stringify(generateTheme(reseeded).degrees)).not.toBe(
      JSON.stringify(generateTheme(ch).degrees),
    );
  });
});

describe("score validity", () => {
  it("every pitched note is in the declared (mood-shifted) scale; starts inside the loop", () => {
    for (const ch of characters) {
      for (const mood of MOODS) {
        const score = composeScore(ch, mood);
        const scale = scalePitchClasses(score.key);
        const total = loopBeats(score);
        for (const track of score.tracks) {
          expect(track.notes.length).toBeGreaterThan(0);
          for (const note of track.notes) {
            expect(note.startBeat).toBeGreaterThanOrEqual(0);
            expect(note.startBeat).toBeLessThan(total);
            expect(note.velocity).toBeGreaterThan(0);
            expect(note.velocity).toBeLessThanOrEqual(1);
            if (!track.isPercussion) {
              expect(scale.has(((note.midi % 12) + 12) % 12),
                `${ch.id}/${mood}/${track.name} midi=${note.midi}`).toBe(true);
              expect(note.midi).toBeGreaterThanOrEqual(24);
              expect(note.midi).toBeLessThanOrEqual(108);
            }
          }
        }
      }
    }
  });

  it("mood changes tempo and mode color but keeps the tonic", () => {
    const ch = characters.find((c) => c.id === "bram")!;
    const happy = composeScore(ch, "happy");
    const sad = composeScore(ch, "sad");
    expect(happy.key.tonic).toBe(ch.key.tonic);
    expect(sad.key.tonic).toBe(ch.key.tonic);
    expect(happy.tempoBpm).toBeGreaterThan(sad.tempoBpm);
    expect(happy.key.mode).not.toBe(sad.key.mode);
  });

  it("moods differ in arrangement (layer sets differ across the mood space)", () => {
    const ch = characters.find((c) => c.id === "nyx")!;
    const layerSets = new Set(
      MOODS.map((m) => composeScore(ch, m).tracks.map((t) => t.name).sort().join(",")),
    );
    expect(layerSets.size).toBeGreaterThanOrEqual(3);
  });
});
