/* ── bpm-estimator.js ──────────────────────────────────────────────────────
 * Robust live tempo estimation from a stream of onset timestamps.
 *
 * WHY THIS EXISTS — the old Layer 3 inferred tempo as an EMA of CONSECUTIVE
 * inter-onset gaps. That is fragile: a single missed kick doubles one gap (a
 * 160 BPM beat momentarily reads 80), and averaging drags the estimate toward
 * half-tempo — the "high BPM reads under 70" bug. The fix is to stop AVERAGING
 * and instead take the MODE of the interval distribution, read out through a
 * HARMONIC COMB so that missed-beat gaps (which land at 2x / 3x the true period)
 * are credited back to the true tempo instead of fighting it.
 *
 * Algorithm:
 *   • addOnset(t): splat the consecutive inter-onset interval into a decaying
 *     histogram over PERIOD (seconds). Decay lets it forget old tempo / a track
 *     change; the Gaussian splat absorbs timing jitter.
 *   • estimate(): for each candidate tempo, score H(p)+w2·H(2p)+w3·H(3p) (the
 *     comb — missed beats show up at 2p/3p and are summed back in) times a broad
 *     perceptual resonance weight that breaks octave ties toward the musical
 *     mid-range. The argmax is the tempo. The modal interval (no comb) is exposed
 *     as `raw` for diagnostics / learning.
 *
 * Pure and dependency-free: exposed as `window.BpmEstimator` for the renderer
 * (classic <script>) and `module.exports` for the Node test harness.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;          // Node (tests)
  if (typeof window !== "undefined") window.BpmEstimator = api;                     // renderer
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    minBpm: 50,           // output floor (genuine ballads live here)
    maxBpm: 200,          // output ceiling
    binSec: 0.005,        // period-histogram resolution (5 ms)
    periodMinSec: 0.20,   // ignore intervals faster than 300 BPM (debounce noise)
    periodMaxSec: 2.20,   // ignore intervals slower than ~27 BPM
    decayPerOnset: 0.94,  // histogram memory ~ 1/(1-decay) ≈ 16 onsets
    splatSigmaBins: 2,    // Gaussian splat width (jitter tolerance)
    lag2Weight: 0.4,      // also splat the 2-onset span (helps swing + missed beats;
                          // lands at 2x the period so it can't pull tempo DOWN an octave)
    combW2: 0.7,          // weight of the 2x-period (one-missed-beat) harmonic
    combW3: 0.35,         // weight of the 3x-period (two-missed-beat) harmonic
    resonanceCenter: 110, // perceptual tempo preference (~beat the listener taps)
    resonanceSigma: 0.5,  // breadth in log space (broad: nudges, never forces)
    minOnsets: 5,         // need this many onsets before emitting a number
    rateWindowSec: 6,     // window for the onsets/sec rate
    searchStepBpm: 0.5,   // tempo search granularity
    gateFrac: 0.15,       // candidate's own period must hold >= this * peak mass
  };

  function createTempoEstimator(opts) {
    const C = Object.assign({}, DEFAULTS, opts || {});
    const nBins = Math.ceil((C.periodMaxSec - C.periodMinSec) / C.binSec) + 1;
    let hist = new Float64Array(nBins);
    let onsets = [];          // recent onset timestamps (sec) for the rate window
    let lastOnset = -1;
    let total = 0;            // running count of intervals splatted (for warmup gate)
    let bpm = 0, raw = 0;     // last computed octave-corrected + modal estimates

    const periodToBin = (p) => Math.round((p - C.periodMinSec) / C.binSec);
    const binToPeriod = (b) => C.periodMinSec + b * C.binSec;

    // Sample the histogram at an arbitrary period (linear interpolation between
    // the two nearest bins). Out-of-range periods contribute 0.
    function histAt(period) {
      if (period < C.periodMinSec || period > C.periodMaxSec) return 0;
      const x = (period - C.periodMinSec) / C.binSec;
      const i = Math.floor(x), f = x - i;
      const a = i >= 0 && i < nBins ? hist[i] : 0;
      const b = i + 1 >= 0 && i + 1 < nBins ? hist[i + 1] : 0;
      return a * (1 - f) + b * f;
    }

    function splat(period, weight) {
      const center = periodToBin(period);
      const sig = C.splatSigmaBins;
      const lo = Math.max(0, Math.floor(center - 3 * sig));
      const hi = Math.min(nBins - 1, Math.ceil(center + 3 * sig));
      for (let b = lo; b <= hi; b++) {
        const d = b - center;
        hist[b] += weight * Math.exp(-0.5 * (d * d) / (sig * sig));
      }
    }

    const resonance = (b) => {
      const z = Math.log(b / C.resonanceCenter) / C.resonanceSigma;
      return Math.exp(-0.5 * z * z);
    };

    // Re-derive bpm/raw from the current histogram (called after each onset).
    function recompute() {
      if (total < C.minOnsets) { bpm = 0; raw = 0; return; }
      let histMax = 0;
      for (let i = 0; i < nBins; i++) if (hist[i] > histMax) histMax = hist[i];
      if (histMax <= 0) { bpm = 0; raw = 0; return; }
      // A candidate must have REAL support at its own period — otherwise a slow
      // track (mass only at 2p) could win the FAST octave purely on its harmonic
      // term, i.e. read 60 BPM as 120. The gate requires the fundamental bin to
      // hold a fraction of the peak before the comb's harmonics can count.
      const gate = C.gateFrac * histMax;
      let bestScore = -1, bestBpm = 0, bestRawVal = -1, bestRawBpm = 0;
      for (let b = C.minBpm; b <= C.maxBpm + 1e-9; b += C.searchStepBpm) {
        const p = 60 / b;
        const direct = histAt(p);
        if (direct > bestRawVal) { bestRawVal = direct; bestRawBpm = b; } // modal (no comb)
        if (direct < gate) continue;               // insufficient fundamental support
        const comb = direct + C.combW2 * histAt(2 * p) + C.combW3 * histAt(3 * p);
        const score = comb * resonance(b);
        if (score > bestScore) { bestScore = score; bestBpm = b; }
      }
      bpm = bestBpm ? Math.round(bestBpm) : 0;
      raw = bestRawBpm ? Math.round(bestRawBpm) : 0;
    }

    return {
      // Record a detected onset at time tSec (seconds).
      addOnset(tSec) {
        for (let i = 0; i < nBins; i++) hist[i] *= C.decayPerOnset; // age the histogram
        const n = onsets.length;
        if (lastOnset >= 0) {
          const iv = tSec - lastOnset;
          if (iv >= C.periodMinSec && iv <= C.periodMaxSec) { splat(iv, 1); total++; }
          // 2-onset span: lands at ~2x the beat period, so it reinforces the comb's
          // 2p harmonic for the TRUE tempo (recovers swing/missed beats) without
          // adding mass at the fundamental of a slower octave.
          if (C.lag2Weight > 0 && n >= 2) {
            const iv2 = tSec - onsets[n - 2];
            if (iv2 >= C.periodMinSec && iv2 <= C.periodMaxSec) splat(iv2, C.lag2Weight);
          }
        }
        lastOnset = tSec;
        onsets.push(tSec);
        const cut = tSec - C.rateWindowSec;
        while (onsets.length && onsets[0] < cut) onsets.shift();
        recompute();
      },

      // Current estimate. tSec only prunes the rate window; the BPM is cached
      // from the last onset, so calling this every animation frame is cheap.
      estimate(tSec) {
        if (typeof tSec === "number") {
          const cut = tSec - C.rateWindowSec;
          while (onsets.length && onsets[0] < cut) onsets.shift();
        }
        return { bpm, raw, onsetRate: onsets.length / C.rateWindowSec };
      },

      // Clear all state (call on track change so the old tempo can't bleed in).
      reset() {
        hist = new Float64Array(nBins);
        onsets = [];
        lastOnset = -1;
        total = 0;
        bpm = 0; raw = 0;
      },
    };
  }

  return { createTempoEstimator, DEFAULTS };
});
