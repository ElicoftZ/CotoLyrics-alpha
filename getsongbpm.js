"use strict";
/* ── GetSongBPM (Layer 2) helpers — extracted from main.js ───────────────────
 * Two pieces:
 *   • extractTempoFromPayload(data)  — PURE; unit-testable in plain Node.
 *   • scrapeBpmViaHiddenWindow(...)  — needs Electron's BrowserWindow (injected
 *     as a parameter so THIS module still loads in plain Node for the parser
 *     tests; only the scrape path touches Electron).
 *
 * api.getsongbpm.com sits behind a Cloudflare MANAGED challenge that 403s any
 * client which can't execute the challenge JS (so net.fetch / curl are blocked).
 * A real hidden Chromium window CAN clear it (~15 s cold, then instant while the
 * cf_clearance cookie persists), but Cloudflare escalates to a persistent loop
 * under repeated automated hits — hence the {status} the caller uses to back off.
 */

// Live shapes (probed against the real API): a HIT is {search:[{tempo:"112",…}]}
// (tempo is a STRING); a MISS is {search:{error:"no result"}} (search becomes an
// OBJECT, no [0]); a bad key is {error:"…"}. Array-first accessors handle the hit;
// the object/error shapes fall through every accessor to NaN (never throw).
const BPM_PROPERTY_ACCESSORS = [
  (d) => d && d.search && d.search[0] && d.search[0].tempo, // GetSongBPM hit (real)
  (d) => d && d.search && d.search[0] && d.search[0].bpm,
  (d) => d && d.search && !Array.isArray(d.search) && d.search.tempo, // single-object variant
  (d) => Array.isArray(d) && d[0] && (d[0].tempo ?? d[0].bpm), // data[0].bpm / .tempo
  (d) => d && d.tempo,     // data.tempo
  (d) => d && d.bpm,       // data.bpm
  (d) => d && d.song_bpm,  // data.song_bpm
];

// Returns a positive integer BPM, or NaN if no accessor yields a usable value.
function extractTempoFromPayload(data) {
  for (const accessor of BPM_PROPERTY_ACCESSORS) {
    let raw;
    try { raw = accessor(data); } catch (_) { continue; }
    if (raw === undefined || raw === null || raw === "") continue;
    const parsedBpm = parseInt(raw, 10); // strict force-cast (handles "174" strings)
    if (!isNaN(parsedBpm) && parsedBpm > 0) return parsedBpm;
  }
  return NaN;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 22000; // Cloudflare cold-solve measured ~15 s; budget over it.

/* Resolve to { bpm: number|null, status }:
 *   "ok"      JSON with a usable tempo (bpm set)
 *   "miss"    JSON parsed but no tempo (API reachable; song not found / error obj)
 *   "captcha" interactive CAPTCHA wall (we never solve these)
 *   "timeout" challenge never cleared within the budget (Cloudflare looping)
 *   "error"   hard load failure
 *   "no-key"  no API key configured
 * The caller treats ok/miss as "Cloudflare reachable" and captcha/timeout as
 * "blocked" (to drive a back-off breaker). BrowserWindow is injected. */
function scrapeBpmViaHiddenWindow(BrowserWindow, key, sanitizedTitle, sanitizedArtist, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const UA = opts.userAgent || DEFAULT_UA;
  return new Promise((resolve) => {
    if (!key) return resolve({ bpm: null, status: "no-key" });
    const lookup = encodeURIComponent(`song:${sanitizedTitle} artist:${sanitizedArtist}`);
    const url = `https://api.getsongbpm.com/search/?api_key=${key}&type=both&lookup=${lookup}`;

    console.log("[Network Request] Querying GetSongBPM (hidden window) for: " + sanitizedTitle);

    let win = new BrowserWindow({
      show: false, // invisible — never appears or steals focus
      width: 1000,
      height: 800,
      webPreferences: {
        // NOTE: do NOT disable images here — Cloudflare's challenge orchestrate
        // step is fingerprint-sensitive and the proven-working config loads as a
        // normal page (a text-only window was part of the old never-clears state).
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.setAudioMuted(true);

    let done = false, poll = null, timer = null;
    const finish = (bpm, status) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (win && !win.isDestroyed()) { try { win.destroy(); } catch (_) {} } // close hidden window -> no leak
      win = null;
      resolve({ bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, status });
    };

    timer = setTimeout(() => {
      console.warn("[Scraper] timed out clearing Cloudflare -> local fallback.");
      finish(null, "timeout");
    }, timeoutMs);

    // Prefer the <pre> Chromium wraps raw JSON in; else the body text.
    const READ_JS =
      "(function(){var p=document.querySelector('pre');return p?p.innerText:(document.body?document.body.innerText:'');})()";

    const tryRead = async () => {
      if (done || !win || win.isDestroyed()) return;
      let text = "";
      try { text = await win.webContents.executeJavaScript(READ_JS, true); } catch (_) { return; }
      if (!text) return;
      if (/cf-turnstile|verify you are human|complete the captcha|recaptcha/i.test(text)) {
        console.warn("[Scraper] interactive CAPTCHA wall (will not solve) -> local fallback.");
        return finish(null, "captcha");
      }
      if (/just a moment|checking your browser|enable javascript and cookies/i.test(text)) {
        return; // managed challenge still running -> keep polling through its reloads
      }
      const brace = text.indexOf("{");
      if (brace < 0) return;
      let data;
      try { data = JSON.parse(text.slice(brace)); } catch (_) { return; } // partial -> keep polling
      console.log("[Network Response] Raw Payload: " + JSON.stringify(data).slice(0, 300));
      const bpm = extractTempoFromPayload(data);
      finish(bpm, Number.isFinite(bpm) ? "ok" : "miss");
    };

    win.webContents.on("did-finish-load", tryRead);
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      if (code === -3) return; // ERR_ABORTED fires on Cloudflare's own redirects — ignore
      console.warn(`[Scraper] load failed (${code} ${desc}) -> local fallback.`);
      finish(null, "error");
    });
    poll = setInterval(tryRead, 500); // Cloudflare reloads a few times; poll independently

    // Cloudflare's challenge issues client-side redirects that reject loadURL with
    // ERR_ABORTED (-3) MID-SOLVE — treating that as fatal (the old bug) killed the
    // scrape right as the challenge was clearing. Swallow the rejection and let the
    // poller keep reading; a real load failure is caught by did-fail-load / timeout.
    win.loadURL(url, { userAgent: UA }).catch((e) => {
      console.warn("[Scraper] loadURL aborted (likely a CF redirect): " + (e && e.message ? e.message : e) + " — still polling.");
    });
  });
}

module.exports = { extractTempoFromPayload, scrapeBpmViaHiddenWindow, BPM_PROPERTY_ACCESSORS, DEFAULT_UA };
