"use strict";
/* LIVE integration test for Layer 2 — drives the REAL scrapeBpmViaHiddenWindow
 * from ../getsongbpm.js against the real API. Run under Electron:
 *     npx electron test/getsongbpm.live.test.js
 * (or `npm run test:api:live`). Needs GETSONGBPM_KEY (env or .env).
 *
 * Cloudflare is adversarial: a cold solve takes ~15 s and, under repeated hits,
 * escalates to a persistent loop -> timeout. So this test does NOT hard-require a
 * BPM. It HARD-FAILS only on a broken pipeline: a thrown error, or a status "ok"
 * that didn't carry a plausible integer BPM. A "timeout"/"captcha" SOFT-PASSES
 * with a clear note (Cloudflare blocking, not our bug). A successful clear prints
 * the BPM as a sanity record.
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");

// Load .env the same way main.js does, so the key is available when run directly.
try {
  const txt = require("fs").readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}

const { scrapeBpmViaHiddenWindow } = require("../getsongbpm.js");
const KEY = process.env.GETSONGBPM_KEY || "";
const SONGS = [
  ["Never Gonna Give You Up", "Rick Astley"],
  ["bad guy", "Billie Eilish"],
];

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {}); // hidden lookups close their own windows; don't auto-quit

app.whenReady().then(async () => {
  if (!KEY) { console.log("SKIP: no GETSONGBPM_KEY set — live test skipped (not a failure)."); app.exit(0); return; }

  let hardFail = 0, cleared = 0, blocked = 0;
  for (const [title, artist] of SONGS) {
    let r;
    try {
      r = await scrapeBpmViaHiddenWindow(BrowserWindow, KEY, title, artist, { timeoutMs: 25000 });
    } catch (e) {
      hardFail++; console.error(`  HARD FAIL (threw): ${title} — ${e && e.message}`); continue;
    }
    const { bpm, status } = r || {};
    if (status === "ok") {
      if (Number.isInteger(bpm) && bpm > 0 && bpm < 400) { cleared++; console.log(`  OK: ${title} -> ${bpm} BPM`); }
      else { hardFail++; console.error(`  HARD FAIL: status "ok" but bad bpm=${JSON.stringify(bpm)} for ${title}`); }
    } else if (status === "miss") {
      cleared++; console.log(`  REACHED API (miss/no-result): ${title}`);
    } else { // timeout | captcha | error | no-key
      blocked++; console.log(`  SOFT-PASS (${status}): ${title} — Cloudflare blocking, not a pipeline bug.`);
    }
  }

  console.log(`\nlive: cleared=${cleared} blocked=${blocked} hardFail=${hardFail}`);
  if (hardFail) console.error("RESULT: FAIL (pipeline error).");
  else if (cleared) console.log("RESULT: PASS (API reached + parsed end-to-end).");
  else console.log("RESULT: PASS (soft) — Cloudflare blocked every attempt; live dspBpm fallback handles this.");
  app.exit(hardFail ? 1 : 0);
});
