/**
 * Procedural ambience: location params -> looping stereo bed.
 * Textures are shaped noise / oscillator banks; events are granular one-shots
 * scattered by a seeded RNG. Always rendered by the DSP engine (sound design,
 * not notes), then run through the same loop/normalize post chain as music.
 */
import { createBuf, type AudioBuf } from "../audio/buffer.ts";
import type {
  LocationParams,
  Texture,
  AmbEventType,
  Density,
  LayerLevel,
} from "../schema/params.ts";
import { schroederReverb } from "../synth/dsp/render.ts";
import { Rng } from "../util/prng.ts";

export const AMBIENCE_LOOP_SEC = 45;
export const AMBIENCE_TAIL_SEC = 2.5;

const LEVEL_GAIN: Record<LayerLevel, number> = { bg: 0.3, mid: 0.6, fg: 1.0 };
const DENSITY_PER_MIN: Record<Density, number> = { sparse: 6, occasional: 16, frequent: 40 };

/** Renders loop + tail; caller wraps the tail. */
export function renderAmbience(params: LocationParams, sampleRate = 44100): AudioBuf {
  const sr = sampleRate;
  const total = Math.round((AMBIENCE_LOOP_SEC + AMBIENCE_TAIL_SEC) * sr);
  const loopN = Math.round(AMBIENCE_LOOP_SEC * sr);
  const buf = createBuf(sr, total);
  const rng = new Rng(params.seed).fork("ambience");

  const brightTilt = params.brightness === "bright" ? 1.5 : params.brightness === "dark" ? 0.55 : 1;

  for (const layer of params.layers) {
    renderTexture(
      buf,
      layer.texture,
      LEVEL_GAIN[layer.level],
      brightTilt,
      rng.fork(`tex:${layer.texture}`),
    );
  }
  for (const ev of params.events) {
    scatterEvents(buf, loopN, ev.type, ev.density, rng.fork(`ev:${ev.type}`));
  }

  // space: reverb wet level + stereo width
  const wet = { tiny: 0.05, room: 0.14, open: 0.22, vast: 0.4 }[params.space];
  const rev = schroederReverb(buf, wet, params.space === "vast" ? 0.86 : 0.78);
  const out = createBuf(sr, total);
  for (let c = 0; c < 2; c++) {
    const o = out.channels[c]!,
      d = buf.channels[c]!,
      w = rev.channels[c]!;
    for (let i = 0; i < total; i++) o[i] = d[i]! + w[i]!;
  }
  // gentle fade-from-zero attack on the very first 30ms so the wrapped seam is clean
  const fadeN = Math.floor(0.03 * sr);
  for (let c = 0; c < 2; c++) {
    const x = out.channels[c]!;
    for (let i = 0; i < fadeN; i++) x[i]! *= i / fadeN;
  }
  return out;
}

export function ambienceLoopSamples(sampleRate = 44100): number {
  return Math.round(AMBIENCE_LOOP_SEC * sampleRate);
}

// ---------- textures ----------

function renderTexture(
  buf: AudioBuf,
  texture: Texture,
  gain: number,
  brightTilt: number,
  rng: Rng,
): void {
  const sr = buf.sampleRate;
  const n = buf.channels[0].length;
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    const chRng = rng.fork(`ch${c}`);
    switch (texture) {
      case "rain": {
        // dense filtered noise + slow level undulation
        let lp = 0,
          lp2 = 0;
        const cut = 0.12 * brightTilt;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += cut * (w - lp);
          lp2 += 0.5 * (lp - lp2);
          const und = 0.8 + 0.2 * Math.sin((2 * Math.PI * 0.07 * i) / sr + c);
          x[i]! += (lp - lp2 * 0.4) * 0.5 * gain * und;
        }
        break;
      }
      case "wind": {
        // band-limited noise with wandering cutoff (gusts)
        let lp = 0,
          gust = 0.04,
          gustT = 0;
        for (let i = 0; i < n; i++) {
          if (--gustT <= 0) {
            gustT = Math.floor(sr * chRng.range(1.5, 4));
            gust = chRng.range(0.015, 0.09) * brightTilt;
          }
          const w = chRng.next() * 2 - 1;
          const coeff = Math.min(
            0.2,
            Math.max(0.004, gust + 0.02 * Math.sin((2 * Math.PI * 0.13 * i) / sr)),
          );
          lp += coeff * (w - lp);
          x[i]! += lp * 1.1 * gain;
        }
        break;
      }
      case "crowd_murmur": {
        // many slow band-passed noise "voices"
        for (let v = 0; v < 8; v++) {
          let bp = 0,
            bp2 = 0;
          const f = (2 * Math.PI * chRng.range(180, 700)) / sr;
          const vRng = chRng.fork(`v${v}`);
          let lvl = 0,
            lvlT = 0,
            lvlTarget = 0;
          for (let i = 0; i < n; i++) {
            if (--lvlT <= 0) {
              lvlT = Math.floor(sr * vRng.range(0.2, 1.4));
              lvlTarget = vRng.chance(0.4) ? vRng.range(0.2, 1) : 0;
            }
            lvl += (lvlTarget - lvl) / (sr * 0.08);
            const w = vRng.next() * 2 - 1;
            bp += f * (w * 0.7 - bp - bp2);
            bp2 += f * bp;
            x[i]! += bp2 * lvl * 0.18 * gain;
          }
        }
        break;
      }
      case "night_insects": {
        // continuous cricket-band shimmer: AM-modulated high band noise
        let bp = 0,
          bp2 = 0;
        const f = (2 * Math.PI * 4200 * Math.min(1.3, brightTilt)) / sr;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          bp += f * (w - bp - bp2 * 1.2);
          bp2 += f * bp;
          const am = 0.55 + 0.45 * Math.sin((2 * Math.PI * 24 * i) / sr + 2.1 * c);
          const slow = 0.7 + 0.3 * Math.sin((2 * Math.PI * 0.11 * i) / sr);
          x[i]! += bp2 * am * slow * 0.16 * gain;
        }
        break;
      }
      case "water_stream": {
        let lp = 0,
          lp2 = 0,
          lp3 = 0;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += 0.3 * brightTilt * (w - lp);
          lp2 += 0.07 * (lp - lp2);
          lp3 += 0.012 * (lp2 - lp3);
          const burble =
            0.7 +
            0.3 *
              Math.sin(
                (2 * Math.PI * (0.9 + 0.2 * c) * i) / sr +
                  Math.sin((2 * Math.PI * 0.23 * i) / sr) * 3,
              );
          x[i]! += (lp - lp2 + lp3 * 2) * 0.35 * gain * burble;
        }
        break;
      }
      case "room_tone": {
        let lp = 0;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += 0.02 * brightTilt * (w - lp);
          const hum = 0.012 * Math.sin((2 * Math.PI * 100 * i) / sr);
          x[i]! += (lp * 0.8 + hum) * gain;
        }
        break;
      }
      case "fire": {
        // low rumble + crackle bursts
        let lp = 0;
        let crackleEnv = 0;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += 0.035 * (w - lp);
          if (chRng.chance(0.00012)) crackleEnv = chRng.range(0.3, 1);
          crackleEnv *= 0.9985;
          const crackle = (chRng.next() * 2 - 1) * crackleEnv * crackleEnv * 0.9;
          x[i]! += (lp * 1.2 + crackle * brightTilt) * 0.5 * gain;
        }
        break;
      }
      case "seaside": {
        // wave swells: slow-enveloped broadband noise
        let lp = 0,
          lp2 = 0;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += 0.09 * brightTilt * (w - lp);
          lp2 += 0.015 * (lp - lp2);
          const t = i / sr;
          const swell = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 0.085 * t + c * 1.4), 2.2);
          x[i]! += (lp * 0.6 + lp2) * (0.25 + 0.95 * swell) * 0.6 * gain;
        }
        break;
      }
      case "city_hum": {
        let lp = 0;
        for (let i = 0; i < n; i++) {
          const w = chRng.next() * 2 - 1;
          lp += 0.015 * (w - lp);
          const t = i / sr;
          const drone =
            0.02 * Math.sin(2 * Math.PI * 60 * t) + 0.012 * Math.sin(2 * Math.PI * 89 * t + c);
          const surge = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.05 * t + c * 2);
          x[i]! += (lp * 1.4 + drone) * surge * gain;
        }
        break;
      }
    }
  }
}

// ---------- events ----------

function scatterEvents(
  buf: AudioBuf,
  loopN: number,
  type: AmbEventType,
  density: Density,
  rng: Rng,
): void {
  const sr = buf.sampleRate;
  const perMin = DENSITY_PER_MIN[density];
  const count = Math.max(1, Math.round((perMin * (loopN / sr)) / 60));
  for (let k = 0; k < count; k++) {
    // keep event onsets inside the loop; their decay may spill into the tail (wrapped later)
    const at = Math.floor(rng.next() * loopN);
    const pan = rng.range(-0.7, 0.7);
    const gL = Math.cos(((pan + 1) / 4) * Math.PI);
    const gR = Math.sin(((pan + 1) / 4) * Math.PI);
    const evRng = rng.fork(`k${k}`);
    const mono = renderEvent(type, sr, evRng);
    for (let i = 0; i < mono.length && at + i < buf.channels[0].length; i++) {
      buf.channels[0][at + i]! += mono[i]! * gL;
      buf.channels[1][at + i]! += mono[i]! * gR;
    }
  }
}

function renderEvent(type: AmbEventType, sr: number, rng: Rng): Float32Array {
  switch (type) {
    case "droplets":
      return decayedTone(sr, rng.range(900, 2600), 0.12, 0.4, rng, { chirp: -0.3 });
    case "clinks":
      return decayedTone(sr, rng.range(1800, 3400), 0.18, 0.3, rng, { metallic: true });
    case "birds":
      return birdChirp(sr, rng);
    case "owl":
      return owlHoot(sr, rng);
    case "frogs":
      return frogCroak(sr, rng);
    case "creaks":
      return creak(sr, rng);
    case "chimes":
      return decayedTone(sr, rng.pick([523.25, 659.25, 783.99, 1046.5]), 1.6, 0.22, rng, {
        metallic: true,
      });
    case "distant_thunder":
      return thunder(sr, rng);
    case "footsteps":
      return thud(sr, rng, rng.range(80, 140), 0.09, 0.5);
    case "pages":
      return noiseSwish(sr, rng, 0.22, 0.18);
    case "crickets_chirp":
      return cricketBurst(sr, rng);
    case "gull":
      return gullCry(sr, rng);
  }
}

function decayedTone(
  sr: number,
  freq: number,
  durSec: number,
  amp: number,
  rng: Rng,
  opts: { chirp?: number; metallic?: boolean } = {},
): Float32Array {
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  let phase = 0,
    phase2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = freq * Math.pow(2, (opts.chirp ?? 0) * t);
    phase += f / sr;
    phase2 += (f * 2.756) / sr;
    const env = Math.min(1, i / (0.002 * sr)) * Math.exp((-t / durSec) * 6);
    let s = Math.sin(2 * Math.PI * phase);
    if (opts.metallic) s = s * 0.7 + 0.3 * Math.sin(2 * Math.PI * phase2);
    out[i] = s * env * amp;
  }
  void rng;
  return out;
}

function birdChirp(sr: number, rng: Rng): Float32Array {
  const syllables = 1 + rng.int(3);
  const n = Math.floor((0.12 * syllables + 0.1) * sr);
  const out = new Float32Array(n);
  let pos = 0;
  for (let s = 0; s < syllables; s++) {
    const f0 = rng.range(2200, 4200);
    const sweep = rng.range(-1.2, 1.2);
    const dur = Math.floor(rng.range(0.05, 0.1) * sr);
    let phase = 0;
    for (let i = 0; i < dur && pos + i < n; i++) {
      const t = i / dur;
      phase += (f0 * Math.pow(2, sweep * t)) / sr;
      const env = Math.sin(Math.PI * t) ** 2;
      out[pos + i] = Math.sin(2 * Math.PI * phase) * env * 0.22;
    }
    pos += dur + Math.floor(0.04 * sr);
  }
  return out;
}

function owlHoot(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(0.7 * sr);
  const out = new Float32Array(n);
  const f = rng.range(330, 420);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 1.5;
    phase += (f * (1 - 0.12 * t)) / sr;
    out[i] = (Math.sin(2 * Math.PI * phase) + 0.25 * Math.sin(4 * Math.PI * phase)) * env * 0.2;
  }
  return out;
}

function frogCroak(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(0.25 * sr);
  const out = new Float32Array(n);
  const f = rng.range(90, 160);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += f / sr;
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 26 * t);
    const env = Math.sin(Math.PI * (i / n)) ** 1.2;
    out[i] = Math.sign(Math.sin(2 * Math.PI * phase)) * am * env * 0.16;
  }
  return out;
}

function creak(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(rng.range(0.3, 0.6) * sr);
  const out = new Float32Array(n);
  let f = rng.range(300, 700);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    if (i % 480 === 0) f *= rng.range(0.96, 1.05);
    phase += f / sr;
    const grit = Math.sign(Math.sin(2 * Math.PI * phase)) * 0.5 + (rng.next() * 2 - 1) * 0.5;
    const env = Math.sin(Math.PI * t) ** 2;
    out[i] = grit * env * 0.12;
  }
  return out;
}

function thunder(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(rng.range(2.2, 3.5) * sr);
  const out = new Float32Array(n);
  let lp = 0,
    lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const w = rng.next() * 2 - 1;
    lp += 0.012 * (w - lp);
    lp2 += 0.004 * (lp - lp2);
    const rumble = 0.5 + 0.5 * Math.sin(2 * Math.PI * rng.range(0.4, 0.6) * t);
    const env = Math.min(1, t / 0.4) * Math.exp(-t * 1.4);
    out[i] = (lp + lp2 * 2) * env * rumble * 1.6;
  }
  return out;
}

function thud(sr: number, rng: Rng, f0: number, durSec: number, amp: number): Float32Array {
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (f0 * Math.exp(-t * 18)) / sr;
    const env = Math.min(1, i / (0.002 * sr)) * Math.exp(-t * 30);
    out[i] = (Math.sin(2 * Math.PI * phase) + (rng.next() * 2 - 1) * 0.1) * env * amp;
  }
  return out;
}

function noiseSwish(sr: number, rng: Rng, durSec: number, amp: number): Float32Array {
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const w = rng.next() * 2 - 1;
    lp += (0.1 + 0.25 * t) * (w - lp);
    out[i] = lp * Math.sin(Math.PI * t) ** 1.5 * amp;
  }
  return out;
}

function cricketBurst(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(rng.range(0.4, 0.8) * sr);
  const out = new Float32Array(n);
  const f = rng.range(3800, 5200);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += f / sr;
    const pulse = Math.sin(2 * Math.PI * 31 * t) > 0.2 ? 1 : 0;
    const env = Math.sin(Math.PI * (i / n)) ** 0.8;
    out[i] = Math.sin(2 * Math.PI * phase) * pulse * env * 0.1;
  }
  return out;
}

function gullCry(sr: number, rng: Rng): Float32Array {
  const n = Math.floor(rng.range(0.5, 0.9) * sr);
  const out = new Float32Array(n);
  const f0 = rng.range(900, 1300);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 * (1 + 0.25 * Math.sin(Math.PI * t)) * (1 - 0.15 * t);
    phase += f / sr;
    const env = Math.sin(Math.PI * t) ** 1.3;
    out[i] =
      (Math.sin(2 * Math.PI * phase) * 0.8 + 0.2 * Math.sin(4 * Math.PI * phase + 0.5)) *
      env *
      0.17;
  }
  return out;
}
