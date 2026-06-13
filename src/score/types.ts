/**
 * Score IR: the MIDI-like intermediate representation produced by composition
 * and consumed by every synthesis backend and the MIDI exporter.
 */
import type { Instrument, Mode, Mood, PitchClass } from "../schema/params.ts";

export interface Note {
  /** Start time in beats from the top of the loop. */
  startBeat: number;
  /** Duration in beats. */
  durBeats: number;
  /** MIDI note number; for percussion tracks this is a GM drum key. */
  midi: number;
  /** 0..1 */
  velocity: number;
}

export type TrackRole = "lead" | "harmony" | "bass" | "pad" | "arp" | "counter" | "percussion";

export interface Track {
  name: string;
  role: TrackRole;
  /** Palette instrument; ignored for percussion tracks. */
  instrument: Instrument;
  isPercussion: boolean;
  gainDb: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  notes: Note[];
}

export interface Score {
  id: string;
  key: { tonic: PitchClass; mode: Mode };
  tempoBpm: number;
  /** beats per bar; denominator fixed at 4 */
  beatsPerBar: number;
  loopBars: number;
  tracks: Track[];
  meta: {
    subject: string;
    mood: Mood;
    seed: number;
    /** the leitmotif as scale degrees + onsets/durations in beats: the subject's identity */
    theme: { degrees: number[]; onsets: number[]; durations: number[] };
  };
}

export function loopBeats(score: Score): number {
  return score.loopBars * score.beatsPerBar;
}

export function loopSeconds(score: Score): number {
  return (loopBeats(score) * 60) / score.tempoBpm;
}
