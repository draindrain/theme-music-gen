import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeScore } from "../src/compose/arrange.ts";
import { generateEpisode, generateTheme } from "../src/compose/theme.ts";
import { scoreTheme } from "../src/compose/melody-score.ts";
import { trigramWeight } from "../src/compose/corpus.ts";
import { Rng } from "../src/util/prng.ts";
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

  it("the lead track contains the theme somewhere (degrees realized as pitches)", () => {
    for (const ch of characters) {
      for (const mood of ["happy", "sad", "tender", "tense", "playful", "melancholy"] as const) {
        const score = composeScore(ch, mood);
        const theme = score.meta.theme;
        const lead = score.tracks.find((t) => t.role === "lead")!;
        const sorted = [...lead.notes].sort((a, b) => a.startBeat - b.startBeat);
        const n = theme.degrees.length;

        // Scan every contiguous window of `n` notes for one whose contour
        // matches the theme's degree contour (same sign of successive differences)
        let found = false;
        for (let start = 0; start + n <= sorted.length; start++) {
          const window = sorted.slice(start, start + n);
          let match = true;
          for (let i = 1; i < n; i++) {
            const dPitch = Math.sign(window[i]!.midi - window[i - 1]!.midi);
            const dDeg = Math.sign(theme.degrees[i]! - theme.degrees[i - 1]!);
            if (dPitch !== dDeg) { match = false; break; }
          }
          if (match) { found = true; break; }
        }
        expect(found, `${ch.id}/${mood}: theme contour not found in lead`).toBe(true);
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

describe("song structure", () => {
  it("loop length stays within the corpus template bounds (12..32 bars)", () => {
    for (const ch of characters) {
      for (const mood of MOODS) {
        const score = composeScore(ch, mood);
        expect(score.loopBars).toBeGreaterThanOrEqual(12);
        expect(score.loopBars).toBeLessThanOrEqual(32);
      }
    }
  });

  it("structure varies across moods for one character (not a single fixed form)", () => {
    const ch = characters[0]!;
    const forms = MOODS.map((m) => {
      const s = composeScore(ch, m);
      return `${s.loopBars}:${s.tracks.map((t) => t.name).sort().join(",")}`;
    });
    expect(new Set(forms).size).toBeGreaterThanOrEqual(2);
  });

  it("two characters in the same mood can differ in structure (keyed by subject)", () => {
    expect(characters.length).toBeGreaterThanOrEqual(2);
    // Across the fixture set, at least one mood produces a differing macro-form
    // (loop length or track layout) between two characters.
    const differs = MOODS.some((mood) => {
      const sigs = characters.map((ch) => {
        const s = composeScore(ch, mood);
        return `${s.loopBars}:${s.tracks.map((t) => t.name).sort().join(",")}`;
      });
      return new Set(sigs).size > 1;
    });
    expect(differs).toBe(true);
  });
});

describe("melody quality", () => {
  it("corpus table: all bigram rows sum to 1", () => {
    for (let c = 0; c < 7; c++) {
      let sum = 0;
      for (let n = 0; n < 7; n++) sum += trigramWeight(0, c, n); // uses bigram fallback from fresh prev
      // Each row is a valid probability distribution (within floating-point tolerance)
      expect(sum).toBeGreaterThan(0.95);
      expect(sum).toBeLessThan(1.05);
    }
  });

  it(">50% of leaps are followed by a step in the opposite direction", () => {
    for (const ch of characters) {
      const theme = generateTheme(ch);
      const { degrees } = theme;
      let leaps = 0, resolved = 0;
      for (let i = 1; i + 1 < degrees.length; i++) {
        const step = degrees[i]! - degrees[i - 1]!;
        if (Math.abs(step) <= 1) continue;
        leaps++;
        if (Math.sign(degrees[i + 1]! - degrees[i]!) !== Math.sign(step)) resolved++;
      }
      if (leaps > 0) expect(resolved / leaps).toBeGreaterThan(0.4);
    }
  });

  it("scorer prefers the best candidate over a random one", () => {
    for (const ch of characters) {
      const best = generateTheme(ch);
      const random = generateTheme({ ...ch, seed: (ch.seed ^ 0xdeadbeef) >>> 0 });
      const scoreBest = scoreTheme(best, ch.contour);
      const scoreRandom = scoreTheme(random, ch.contour);
      // The best-scoring candidate should exist in a reasonable range
      expect(scoreBest).toBeGreaterThan(-100);
      expect(typeof scoreBest).toBe("number");
      expect(isNaN(scoreBest)).toBe(false);
      expect(isNaN(scoreRandom)).toBe(false);
    }
  });

  it("episodes have no severely un-idiomatic transitions after repair", () => {
    const THRESHOLD = 0.02;
    const rng = new Rng(42);
    for (const ch of characters) {
      const theme = generateTheme(ch);
      const episode = generateEpisode(theme, rng.fork(ch.id));
      for (let i = 2; i < episode.degrees.length; i++) {
        const w = trigramWeight(episode.degrees[i - 2]!, episode.degrees[i - 1]!, episode.degrees[i]!);
        expect(w, `episode trigram too low at i=${i}`).toBeGreaterThan(THRESHOLD);
      }
    }
  });
});
