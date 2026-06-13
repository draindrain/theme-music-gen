/** Standard MIDI File (format 1) writer for the Score IR. No dependencies. */
import type { Score } from "./types.ts";
import { GM_PROGRAMS } from "../synth/dsp/instruments.ts";

const PPQ = 480;

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

interface Ev {
  tick: number;
  bytes: number[];
  /** sort priority at equal ticks: note-offs before note-ons */
  prio: number;
}

function trackChunk(events: Ev[]): Buffer {
  events.sort((a, b) => a.tick - b.tick || a.prio - b.prio);
  const data: number[] = [];
  let last = 0;
  for (const ev of events) {
    data.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00); // end of track
  const head = Buffer.alloc(8);
  head.write("MTrk", 0);
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, Buffer.from(data)]);
}

export interface MidiOpts {
  /** Pad the file out to this beat with a no-op meta event, so renderers
   *  (fluidsynth) keep running long enough to capture release/reverb tails. */
  padToBeat?: number;
}

export function scoreToMidi(score: Score, opts: MidiOpts = {}): Buffer {
  const chunks: Buffer[] = [];
  const nTracks = score.tracks.length + 1;
  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8); // format 1
  header.writeUInt16BE(nTracks, 10);
  header.writeUInt16BE(PPQ, 12);
  chunks.push(header);

  // tempo/meta track
  const usPerBeat = Math.round(60_000_000 / score.tempoBpm);
  const metaEvents: Ev[] = [
    { tick: 0, prio: 0, bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] },
    { tick: 0, prio: 0, bytes: [0xff, 0x58, 0x04, score.beatsPerBar, 2, 24, 8] },
  ];
  if (opts.padToBeat !== undefined) {
    const txt = [...Buffer.from("pad")];
    metaEvents.push({ tick: Math.round(opts.padToBeat * PPQ), prio: 2, bytes: [0xff, 0x01, txt.length, ...txt] });
  }
  chunks.push(trackChunk(metaEvents));

  let chan = 0;
  for (const track of score.tracks) {
    const channel = track.isPercussion ? 9 : nextMelodicChannel(chan++);
    const events: Ev[] = [];
    if (!track.isPercussion)
      events.push({ tick: 0, prio: 0, bytes: [0xc0 | channel, GM_PROGRAMS[track.instrument]] });
    // track volume from gainDb (0dB -> 100)
    const vol = Math.max(0, Math.min(127, Math.round(100 * Math.pow(10, track.gainDb / 20))));
    events.push({ tick: 0, prio: 0, bytes: [0xb0 | channel, 7, vol] });
    const pan = Math.max(0, Math.min(127, Math.round(64 + track.pan * 63)));
    events.push({ tick: 0, prio: 0, bytes: [0xb0 | channel, 10, pan] });
    for (const note of track.notes) {
      const onTick = Math.round(note.startBeat * PPQ);
      const offTick = Math.round((note.startBeat + note.durBeats) * PPQ);
      const vel = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      events.push({ tick: onTick, prio: 1, bytes: [0x90 | channel, note.midi & 0x7f, vel] });
      events.push({ tick: Math.max(onTick + 1, offTick), prio: 0, bytes: [0x80 | channel, note.midi & 0x7f, 0] });
    }
    chunks.push(trackChunk(events));
  }
  return Buffer.concat(chunks);
}

function nextMelodicChannel(i: number): number {
  return i >= 9 ? i + 1 : i; // skip the GM drum channel
}

export const MIDI_PPQ = PPQ;
