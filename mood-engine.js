/* ═══════════════════════════════════════════════════════════════════════
 *  MOOD ENGINE
 *
 *  Pure functions that map a live audio-energy reading (from a Web Audio
 *  AnalyserNode in the renderer) onto motion parameters for the renderer.
 *
 *  Design notes:
 *   - No THREE / DOM / Web Audio imports here. Sizes are returned as *unit-free
 *     multipliers* of the caller's base CHAR_SIZE, and colour is returned as
 *     plain HSL numbers. The caller constructs THREE.Color. This keeps the file
 *     side-effect-free and unit-testable in plain Node (see the test harness).
 *   - `sampleMood` reads the live value defensively: if the analyser has not
 *     produced a reading yet (or it is non-finite), it returns a neutral mood
 *     instead of throwing.
 *
 *  Signal source (local audio + Enhanced LRC architecture):
 *     audioState.energy : number in [0,1]  — normalized loudness from the
 *                                             AnalyserNode (RMS of the waveform).
 *   Valence is not recoverable from a raw waveform, so it is held neutral (0)
 *   and the hue stays mid-temperature; arousal is derived from energy.
 * ═══════════════════════════════════════════════════════════════════════ */
"use strict";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (x, y, t) => x + (y - x) * t;

/**
 * Derives a mood sample from a live audio-energy reading.
 * Never throws; returns neutral { valence:0, arousal:0, energy:0 } on failure.
 *
 * @param {{energy:number}} audioState - live analyser reading; energy in [0,1]
 * @param {number} [_timeSec]          - playback time (unused; kept for a stable
 *                                        signature should time-aware mood return)
 * @returns {{valence:number, arousal:number, energy:number}}
 */
function sampleMood(audioState, _timeSec) {
  let energy = 0;

  if (audioState && Number.isFinite(audioState.energy)) {
    energy = clamp(audioState.energy, 0, 1);
  }

  // Loudness drives intensity. Map energy [0,1] -> arousal [-1,1] so quiet
  // passages read calm/ambient and loud passages read hype. Valence has no
  // waveform source, so it stays neutral (mid hue temperature).
  const arousal = clamp(2 * energy - 1, -1, 1);
  const valence = 0;

  return { valence, arousal, energy };
}

/**
 * Maps a mood sample onto renderer motion parameters.
 *
 * Master dials:
 *   arousal -> intensity (spring stiffness, scale, fade speed, shake, font weight)
 *   valence -> hue temperature (cool/sad <-> warm/bright)
 *   energy  -> gates beat-synced camera shake so quiet passages stay still
 *
 * @param {{valence:number, arousal:number, energy:number}} mood
 * @returns {{
 *   stiffness:number, damping:number, sizeMul:number, trackMul:number,
 *   fadeRate:number, shake:number, spawnYMul:number, font:('serif'|'sans'),
 *   hsl:{h:number, s:number, l:number}
 * }}
 */
function moodToMotion(mood) {
  const arousal = clamp(mood.arousal, -1, 1);
  const valence = clamp(mood.valence, -1, 1);
  const energy = clamp(mood.energy, 0, 1);

  const a = (arousal + 1) / 2; // 0 = calm/ambient ... 1 = hype/energetic
  const warm = (valence + 1) / 2; // 0 = cool/sad ... 1 = warm/bright

  return {
    // Under-damped spring. Hype = stiff + low damping => sharp, hard-hitting
    // slide-ins. Calm = soft + high damping => slow flowing settle.
    stiffness: lerp(0.03, 0.16, a),
    damping: lerp(0.86, 0.58, a),

    // Multiplier of CHAR_SIZE. Hype scales typography up aggressively.
    sizeMul: lerp(1.0, 1.7, a),

    // Tracking (letter-spacing) as a multiplier of CHAR_SIZE.
    // Ambient/calm breathes wide; hype packs tight, grid-like.
    trackMul: lerp(0.22, 0.04, a),

    // Exit alpha decay per frame. Melancholy = slow lingering fade;
    // hype = near hard cut.
    fadeRate: lerp(0.012, 0.06, a),

    // Beat-synced camera-shake amplitude (world units), gated by vocal energy.
    shake: a * energy * 0.18,

    // Spawn offset as a multiplier of CHAR_SIZE: gentle drift-up (calm) vs.
    // slam-from-far-below (hype).
    spawnYMul: lerp(-1.8, -4.2, a),

    // Typeface selector for the serif <-> bold-sans contrast (feature #1).
    font: a > 0.62 ? "sans" : "serif",

    // Near-monochrome "ink" tuned for a white background. Valence drives hue
    // temperature; arousal drives weight (darker reads bolder on white).
    hsl: {
      h: lerp(220, 28, warm) / 360, // cool blue -> warm grey
      s: lerp(0.05, 0.2, a), // a touch more saturation when intense
      l: lerp(0.18, 0.09, a), // intense reads darker/bolder
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 *  LYRIC SENTIMENT HEURISTIC + THEME CLASSIFIER
 *
 *  No ML model: a small keyword lexicon scores lyric text on an energetic↔calm
 *  axis. The renderer combines this with the live loopback-audio energy (which
 *  is the ONLY real source of loudness/tempo) and the phrase cadence to pick a
 *  coarse theme that drives font family + layout-profile bias.
 * ───────────────────────────────────────────────────────────────────────── */
const ENERGETIC_WORDS = new Set(
  ("fire burn burning run running fight fighting alive loud scream shout jump " +
   "party wild fast faster beat beating rise rising power blood thunder storm " +
   "break breaking explode harder stronger lights move shake rock roll higher " +
   "fly dance dancing crazy bang boom hype energy electric").split(" ")
);
const CALM_WORDS = new Set(
  ("love slow rain dream dreaming quiet soft alone tears gentle sleep heart " +
   "stay home calm still silence cold lonely sad miss memory fade whisper " +
   "morning blue sea moon sky breathe tender hush peace rest gone").split(" ")
);

/**
 * Lyric sentiment -> intensity in [-1,1]. Positive = energetic, negative = calm.
 * Returns 0 for empty/unknown text. Tokenizes on whitespace after stripping
 * non-letters; works on Latin lyrics (CJK text yields 0 -> audio drives theme).
 * @param {string} text
 * @returns {number}
 */
function lyricTheme(text) {
  if (!text) return 0;
  const words = String(text).toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/);
  let e = 0;
  let c = 0;
  for (const w of words) {
    if (ENERGETIC_WORDS.has(w)) e++;
    else if (CALM_WORDS.has(w)) c++;
  }
  const total = e + c;
  return total === 0 ? 0 : clamp((e - c) / total, -1, 1);
}

/**
 * Coarse theme from live audio energy (primary), lyric intensity, and cadence.
 * @param {number} energy          - loopback RMS energy in [0,1] (real, live)
 * @param {number} lyricIntensity  - lyricTheme() result in [-1,1]
 * @param {number} cadence         - words per second of the current phrase
 * @returns {'calm'|'mid'|'energetic'}
 */
function classifyTheme(energy, lyricIntensity, cadence) {
  const e = clamp(energy, 0, 1);
  const li = clamp(lyricIntensity || 0, -1, 1);
  const cad = clamp((cadence || 0) / 4, 0, 1); // ~4 words/sec reads as very fast
  // Live loudness dominates; lyric sentiment + cadence nudge the result.
  const score = e * 0.55 + (li * 0.5 + 0.5) * 0.25 + cad * 0.2;
  if (score < 0.34) return "calm";
  if (score > 0.62) return "energetic";
  return "mid";
}

/**
 * VIBE PROFILE CLASSIFIER (Phase 2 mood engine).
 *
 * Folds live audio DSP + lyric heuristics into one intensity score and maps it
 * to a vibe quadrant that selects the layout/font/camera profile:
 *   A Melancholy/Calm  ·  B Chill/Groovy  ·  C High-Energy/Chorus  ·  D Aggressive
 *
 * The renderer computes the DSP features every frame but calls this ONCE PER
 * LINE (at onCotodamaNewLine) so the profile is stable for the phrase; the live
 * features still drive within-profile dynamics (camera intensity, pop, invert).
 *
 * @param {{energy:number, bassTreble:number, onsetRate:number, bpm:number,
 *          lyricIntensity:number, cadence:number}} f
 * @returns {{profile:'A'|'B'|'C'|'D', score:number}}
 */
function classifyVibe(f) {
  f = f || {};
  const energy = clamp(Number.isFinite(f.energy) ? f.energy : 0, 0, 1);
  const onsetRate = Math.max(0, Number.isFinite(f.onsetRate) ? f.onsetRate : 0);
  const bpm = Math.max(0, Number.isFinite(f.bpm) ? f.bpm : 0);
  const bassTreble = Math.max(0, Number.isFinite(f.bassTreble) ? f.bassTreble : 1);
  const li = clamp(Number.isFinite(f.lyricIntensity) ? f.lyricIntensity : 0, -1, 1);
  const cadence = Math.max(0, Number.isFinite(f.cadence) ? f.cadence : 0);

  const beat = clamp(onsetRate / 4, 0, 1); // ~4 onsets/sec reads as busy
  const fast = clamp((bpm - 60) / 120, 0, 1); // 60..180 BPM
  const liN = (li + 1) / 2; // calm(0) .. energetic(1)
  const cad = clamp(cadence / 4, 0, 1); // ~4 words/sec = very fast delivery
  const bass = clamp(bassTreble - 1, 0, 1); // >1 means bass-heavy

  // Loudness dominates; beat density, tempo, lyric sentiment, cadence nudge it.
  let score =
    energy * 0.42 + beat * 0.2 + fast * 0.14 + liN * 0.12 + cad * 0.07 + bass * energy * 0.05;
  score = clamp(score, 0, 1);

  let profile;
  if (score < 0.3) profile = "A";
  else if (score < 0.52) profile = "B";
  else if (score < 0.74) profile = "C";
  else profile = "D";
  return { profile, score };
}

export { sampleMood, moodToMotion, lyricTheme, classifyTheme, classifyVibe };
export default {
  sampleMood,
  moodToMotion,
  lyricTheme,
  classifyTheme,
  classifyVibe,
  _internal: { clamp, lerp },
};
