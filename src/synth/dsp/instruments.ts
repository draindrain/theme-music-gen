/**
 * Patch definitions for the from-scratch DSP backend. Each palette instrument
 * maps to a small subtractive/FM/Karplus voice description.
 */
import type { Instrument } from "../../schema/params.ts";

export type OscKind = "sine" | "triangle" | "saw" | "square" | "fm" | "karplus";

export interface Patch {
  osc: OscKind;
  /** FM only */
  fmRatio?: number;
  fmIndex?: number;
  fmIndexDecay?: number; // seconds for modulation index to decay
  /** number of detuned unison voices (1 = none) */
  unison?: number;
  detuneCents?: number;
  adsr: { a: number; d: number; s: number; r: number };
  /** lowpass cutoff as multiple of note frequency (keytracked) */
  cutoffRatio: number;
  cutoffMax?: number;
  vibrato?: { rateHz: number; depthCents: number; delaySec: number };
  /** mix of pitched noise breath (flutes etc.) */
  breath?: number;
  /** karplus damping 0..1 (higher = darker, faster decay) */
  kpDamp?: number;
  gain: number;
  reverbSend: number;
}

export const PATCHES: Record<Instrument, Patch> = {
  piano: { osc: "fm", fmRatio: 1, fmIndex: 1.6, fmIndexDecay: 0.4, adsr: { a: 0.004, d: 1.4, s: 0.0, r: 0.25 }, cutoffRatio: 9, gain: 0.8, reverbSend: 0.18 },
  electric_piano: { osc: "fm", fmRatio: 1, fmIndex: 0.9, fmIndexDecay: 0.6, adsr: { a: 0.004, d: 1.8, s: 0.05, r: 0.3 }, cutoffRatio: 7, gain: 0.8, reverbSend: 0.2 },
  music_box: { osc: "fm", fmRatio: 3.01, fmIndex: 0.8, fmIndexDecay: 0.15, adsr: { a: 0.002, d: 1.2, s: 0.0, r: 0.4 }, cutoffRatio: 14, gain: 0.65, reverbSend: 0.3 },
  celesta: { osc: "fm", fmRatio: 4.0, fmIndex: 0.5, fmIndexDecay: 0.12, adsr: { a: 0.002, d: 1.0, s: 0.0, r: 0.35 }, cutoffRatio: 12, gain: 0.6, reverbSend: 0.28 },
  bells: { osc: "fm", fmRatio: 3.53, fmIndex: 1.4, fmIndexDecay: 0.5, adsr: { a: 0.002, d: 2.2, s: 0.0, r: 0.8 }, cutoffRatio: 12, gain: 0.55, reverbSend: 0.35 },
  vibraphone: { osc: "fm", fmRatio: 3.98, fmIndex: 0.35, fmIndexDecay: 0.3, adsr: { a: 0.003, d: 1.8, s: 0.0, r: 0.7 }, cutoffRatio: 10, vibrato: { rateHz: 4.5, depthCents: 6, delaySec: 0.1 }, gain: 0.6, reverbSend: 0.3 },
  marimba: { osc: "fm", fmRatio: 3.99, fmIndex: 0.5, fmIndexDecay: 0.05, adsr: { a: 0.002, d: 0.4, s: 0.0, r: 0.15 }, cutoffRatio: 8, gain: 0.7, reverbSend: 0.22 },
  harp: { osc: "karplus", kpDamp: 0.28, adsr: { a: 0.002, d: 1.6, s: 0.0, r: 0.3 }, cutoffRatio: 10, gain: 0.7, reverbSend: 0.3 },
  acoustic_guitar: { osc: "karplus", kpDamp: 0.42, adsr: { a: 0.002, d: 1.2, s: 0.0, r: 0.2 }, cutoffRatio: 9, gain: 0.75, reverbSend: 0.18 },
  pluck: { osc: "karplus", kpDamp: 0.55, adsr: { a: 0.002, d: 0.7, s: 0.0, r: 0.12 }, cutoffRatio: 8, gain: 0.75, reverbSend: 0.15 },
  flute: { osc: "triangle", adsr: { a: 0.07, d: 0.1, s: 0.85, r: 0.18 }, cutoffRatio: 6, vibrato: { rateHz: 5, depthCents: 12, delaySec: 0.25 }, breath: 0.025, gain: 0.6, reverbSend: 0.25 },
  clarinet: { osc: "square", adsr: { a: 0.06, d: 0.1, s: 0.8, r: 0.16 }, cutoffRatio: 4, vibrato: { rateHz: 4.6, depthCents: 7, delaySec: 0.3 }, gain: 0.5, reverbSend: 0.2 },
  oboe: { osc: "saw", adsr: { a: 0.05, d: 0.1, s: 0.8, r: 0.15 }, cutoffRatio: 5, cutoffMax: 4000, vibrato: { rateHz: 5.2, depthCents: 9, delaySec: 0.22 }, gain: 0.45, reverbSend: 0.22 },
  strings: { osc: "saw", unison: 3, detuneCents: 9, adsr: { a: 0.18, d: 0.2, s: 0.85, r: 0.5 }, cutoffRatio: 5, cutoffMax: 6000, vibrato: { rateHz: 5, depthCents: 8, delaySec: 0.4 }, gain: 0.5, reverbSend: 0.3 },
  cello: { osc: "saw", unison: 2, detuneCents: 5, adsr: { a: 0.12, d: 0.2, s: 0.85, r: 0.4 }, cutoffRatio: 4, cutoffMax: 3000, vibrato: { rateHz: 4.6, depthCents: 10, delaySec: 0.35 }, gain: 0.55, reverbSend: 0.25 },
  warm_pad: { osc: "saw", unison: 3, detuneCents: 12, adsr: { a: 0.6, d: 0.4, s: 0.8, r: 1.2 }, cutoffRatio: 2.5, cutoffMax: 2200, gain: 0.42, reverbSend: 0.4 },
  bright_pad: { osc: "saw", unison: 3, detuneCents: 14, adsr: { a: 0.45, d: 0.3, s: 0.8, r: 1.0 }, cutoffRatio: 6, cutoffMax: 7000, gain: 0.36, reverbSend: 0.4 },
  soft_choir: { osc: "triangle", unison: 3, detuneCents: 10, adsr: { a: 0.5, d: 0.3, s: 0.85, r: 0.9 }, cutoffRatio: 3, cutoffMax: 2500, vibrato: { rateHz: 4.2, depthCents: 8, delaySec: 0.5 }, breath: 0.012, gain: 0.5, reverbSend: 0.45 },
};

/** General MIDI program numbers (0-based) for the soundfont backend + MIDI export. */
export const GM_PROGRAMS: Record<Instrument, number> = {
  piano: 0,
  electric_piano: 4,
  music_box: 10,
  celesta: 8,
  bells: 14, // tubular bells
  vibraphone: 11,
  marimba: 12,
  harp: 46,
  acoustic_guitar: 24,
  pluck: 45, // pizzicato strings
  flute: 73,
  clarinet: 71,
  oboe: 68,
  strings: 48,
  cello: 42,
  warm_pad: 89,
  bright_pad: 91,
  soft_choir: 52,
};
