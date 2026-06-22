"use strict";
/* Deep tests for the live tempo estimator (Layer 3). Feeds SYNTHETIC onset
 * trains at known tempos — clean, with missed beats, with extra subdivisions,
 * with timing jitter and swing — and asserts the recovered BPM. The headline
 * guard is the reported bug: a high-BPM track must NOT collapse under 70.
 * Run: node test/bpm-estimator.test.js   (exit 1 on any failure)
 */
const { createTempoEstimator } = require("../bpm-estimator.js");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

// Deterministic PRNG (mulberry32) so runs are reproducible.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build an onset-time array for `beats` beats at `bpm`, with options:
//   jitter   – ± seconds of uniform timing noise per onset
//   pMiss    – probability each beat's onset is dropped (detection miss)
//   pExtra   – probability a midpoint onset is inserted between two beats
//   swing    – fraction of the beat period that off-beats are delayed
function train(bpm, beats, opt = {}) {
  const r = rng(opt.seed || 1);
  const period = 60 / bpm;
  const jit = opt.jitter || 0;
  const out = [];
  let t = 1.0; // start a little in
  for (let k = 0; k < beats; k++) {
    const swung = opt.swing && k % 2 === 1 ? opt.swing * period : 0;
    if (!opt.pMiss || r() > opt.pMiss) out.push(t + swung + (jit ? (r() * 2 - 1) * jit : 0));
    if (opt.pExtra && r() < opt.pExtra) out.push(t + period / 2 + (jit ? (r() * 2 - 1) * jit : 0));
    t += period;
  }
  return out.sort((a, b) => a - b);
}

function run(onsets, opts) {
  const est = createTempoEstimator(opts);
  for (const t of onsets) est.addOnset(t);
  return est.estimate(onsets[onsets.length - 1]);
}

// ── 1. Clean grids across the range -> within ±3 ────────────────────────────
for (const bpm of [60, 75, 90, 100, 110, 120, 128, 140, 150, 160, 174, 184, 190]) {
  const { bpm: got } = run(train(bpm, 64, { jitter: 0.004, seed: bpm }));
  ok(`clean ${bpm}`, Math.abs(got - bpm) <= 3, `got ${got}`);
}

// ── 2. Missed beats at HIGH tempo -> must NOT collapse to half-tempo (the bug).
// Includes 176/184/190 — fast electronic/pop, exactly the "stuck on Calm at 184"
// report. The estimate must stay near the true tempo (NOT its ~half).
for (const bpm of [140, 160, 175, 184, 190]) {
  for (const pMiss of [0.15, 0.25, 0.35]) {
    const { bpm: got } = run(train(bpm, 110, { jitter: 0.006, pMiss, seed: bpm * 10 + pMiss * 100 }));
    ok(`missed ${bpm} @${pMiss}: not half-tempo`, got >= bpm * 0.75, `got ${got}`);
    ok(`missed ${bpm} @${pMiss}: near true`, Math.abs(got - bpm) <= 10, `got ${got}`);
  }
}

// ── 3. Extra subdivisions (hi-hat double-time) -> must NOT latch 2x ──────────
for (const bpm of [100, 120, 128]) {
  const { bpm: got } = run(train(bpm, 80, { jitter: 0.005, pExtra: 0.4, seed: bpm + 7 }));
  ok(`subdiv ${bpm}: not doubled`, got < bpm * 1.5, `got ${got}`);
  ok(`subdiv ${bpm}: near true`, Math.abs(got - bpm) <= 8, `got ${got}`);
}

// ── 4. Heavy jitter -> within ±5 ─────────────────────────────────────────────
for (const bpm of [120, 150]) {
  const { bpm: got } = run(train(bpm, 80, { jitter: 0.022, seed: bpm + 99 }));
  ok(`jitter ${bpm}`, Math.abs(got - bpm) <= 5, `got ${got}`);
}

// ── 5. Swing/shuffle feel ────────────────────────────────────────────────────
// Heavy swing delays off-beats so NO consecutive gap equals the true beat period;
// a pure inter-onset method reads the long-gap side. What matters for the
// visualizer is the motion TIER (profileFromBpm: 100–140 = tier B), so we assert
// the estimate stays in-tier (and within a sane bound) rather than dead-on.
const tier = (b) => (b < 100 ? "A" : b < 140 ? "B" : "D");
{
  const { bpm: got } = run(train(120, 80, { jitter: 0.005, swing: 0.12, seed: 555 }));
  ok(`swing 120 stays tier B`, tier(got) === "B", `got ${got} (tier ${tier(got)})`);
  ok(`swing 120 within ±15`, Math.abs(got - 120) <= 15, `got ${got}`);
}

// ── 6. Track change via reset() -> re-locks, no bleed-through ─────────────────
{
  const est = createTempoEstimator();
  for (const t of train(84, 48, { jitter: 0.004, seed: 3 })) est.addOnset(t);
  ok("pre-reset locks 84", Math.abs(est.estimate().bpm - 84) <= 4, `got ${est.estimate().bpm}`);
  est.reset();
  let t0 = 100; // fresh timeline
  for (const t of train(168, 64, { jitter: 0.004, seed: 4 })) est.addOnset(t0 + t);
  ok("post-reset locks 168", Math.abs(est.estimate(t0 + 64).bpm - 168) <= 6, `got ${est.estimate(t0 + 64).bpm}`);
}

// ── 7. Sparse / silent -> 0, never NaN ───────────────────────────────────────
{
  const a = run([1.0, 2.3]); // 2 onsets, below minOnsets
  ok("sparse -> 0", a.bpm === 0, `got ${a.bpm}`);
  ok("sparse -> finite", Number.isFinite(a.bpm) && !Number.isNaN(a.bpm), `got ${a.bpm}`);
  const b = createTempoEstimator().estimate(0);
  ok("empty -> 0/finite", b.bpm === 0 && Number.isFinite(b.bpm), `got ${b.bpm}`);
}

console.log(`\nbpm-estimator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
