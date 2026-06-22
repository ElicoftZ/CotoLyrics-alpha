/* ═══════════════════════════════════════════════════════════════════════
 *  MAIN PROCESS  (SMTC-only)
 *
 *  Responsibilities:
 *   1. Serve the renderer over a custom *standard* scheme (app://) instead of
 *      file://. Required because the renderer uses <script type="module"> + an
 *      import map (three's ESM build, ./mood-engine.js). Module scripts are
 *      fetched with CORS, which Chromium blocks over file://. A standard, secure
 *      custom scheme is treated like an http(s) origin, so same-origin module +
 *      import-map resolution works without a bundler.
 *   2. Spawn the Windows SMTC bridge (smtc-bridge.ps1) — the SINGLE source of
 *      truth for "now playing" — and forward each JSON line to the renderer over
 *      the "smtc-update" IPC channel. SMTC reads Spotify / Apple Music / browsers
 *      natively (no Spicetify extension needed).
 *   3. Grant system-audio loopback to the renderer's getDisplayMedia() call so
 *      the Web Audio AnalyserNode can drive the beat/BPM analysis from whatever
 *      is playing, with no picker and no native module.
 *
 *  (AirPlay/UxPlay and all network-audio listeners have been removed.)
 * ═══════════════════════════════════════════════════════════════════════ */
"use strict";

const {
  app,
  BrowserWindow,
  session,
  protocol,
  net,
  desktopCapturer,
  ipcMain,
  utilityProcess,
} = require("electron");
const path = require("path");
const fsp = require("fs").promises;
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const musicDb = require("./music-database"); // sandboxed local SQLite BPM store (guarded load)
const { scrapeBpmViaHiddenWindow } = require("./getsongbpm"); // Layer 2 hidden-window scraper

/* ── .env loader (dependency-free) ─────────────────────────────────────────
 * Parse simple KEY=VALUE lines from a gitignored .env at the project root into
 * process.env (only when not already set), so secrets like GETSONGBPM_KEY never
 * have to live in tracked source. A missing file is the normal case (no key) and
 * is silently ignored. NOTE: in a PACKAGED build __dirname is inside the asar and
 * the .env is NOT bundled (by design — the key must not ship), so packaged users
 * set a real environment variable instead; dev (`npm start`) reads .env here. */
(function loadDotEnv() {
  try {
    const txt = require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      if (!(key in process.env)) process.env[key] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) { /* no .env -> rely on real environment variables */ }
})();

const APP_SCHEME = "app";
const APP_HOST = "bundle";
const ROOT = __dirname; // project root is the web root served under app://bundle/

// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const APPROVED_PERMISSIONS = [
  "audioCapture",
  "mediaKeySystem",
  "media",
  "microphone",
  "display-capture", // renderer getDisplayMedia() for system loopback audio
];

let mainWindow = null;
let smtcProc = null;
let shuttingDown = false;

/* ── app:// static file server (directory-traversal guarded) ──────────────── */
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === "/" || relPath === "") relPath = "/index.html";

    const resolved = path.normalize(path.join(ROOT, relPath));
    if (!resolved.startsWith(ROOT)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

/* ── SMTC bridge: powershell.exe -> JSON lines -> "smtc-update" IPC ─────────
 * The bridge prints one compact JSON object per line. We parse each line inside
 * a try/catch (a malformed/partial line is skipped, never crashing the bridge)
 * and forward the parsed payload to the renderer. */
function smtcScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "smtc-bridge.ps1")
    : path.join(__dirname, "smtc-bridge.ps1");
}

function startSmtcBridge() {
  if (process.platform !== "win32") {
    console.warn("[smtc] SMTC is Windows-only; bridge not started on this platform.");
    return;
  }
  const script = smtcScriptPath();
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true }
  );
  smtcProc = ps;

  let buf = "";
  ps.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line); // strict try/catch — a partial line never breaks the bridge
      } catch (_) {
        continue;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("smtc-update", obj);
      }
      maybeResolveBpm(obj); // §1 — resolve + push BPM once per track over "bpm-update"
    }
  });
  ps.stderr.on("data", (d) => console.error("[smtc] " + d.toString().trim()));
  ps.on("exit", (code) => {
    console.warn("[smtc] bridge exited (code " + code + ")");
    smtcProc = null;
    if (!shuttingDown) setTimeout(startSmtcBridge, 1500); // resilient restart
  });
  ps.on("error", (e) => console.error("[smtc] spawn error: " + e.message));
}

function stopChildren() {
  if (smtcProc && !smtcProc.killed) {
    try {
      smtcProc.kill();
    } catch (_) {}
  }
  smtcProc = null;
}

/* ── BPM RESOLVER — multi-layer waterfall (main-process authority) ──────────
 * Resolve a track's numeric BPM ONCE per track and push it to the renderer
 * over the "bpm-update" IPC channel. The renderer maps it to a motion profile.
 *
 *   LAYER 1  Local dictionary + SQLite cache — instant, no network.
 *   LAYER 2  GetSongBPM scrape — OFF by default (Cloudflare-gated); kept behind
 *            ENABLE_BPM_SCRAPER. (Spotify /v1/audio-features is NOT used:
 *            deprecated for new apps on 2024-11-27, and this SMTC app holds no
 *            Spotify session token.)
 *   LAYER 3  Live dspBpm onset estimate — renderer (Web Audio): the PRIMARY
 *            tempo source for unknown tracks. Its settled estimate is shipped
 *            back over "learn-bpm" and written into the SQLite cache (with a
 *            best-effort MusicBrainz release year), so the track is local from
 *            then on. Steady-state playback makes zero network requests.        */

// LAYER 1 - in-memory tempo dictionary. EMPTY in the public source: it is filled
// at runtime from the user's local bpm-dictionary.json (below) and grows as the
// renderer's live dspBpm estimator learns unknown tracks. Ship no personal data.
const BPM_DICTIONARY = {};

/* ── SELF-LEARNING PERSISTENT DICTIONARY (bpm-dictionary.json) ──────────────
 * A human-readable JSON file in userData (writable even when packaged), keyed
 * "Title - Artist": bpm. Loaded into BPM_DICTIONARY at startup, and grown
 * automatically: when the renderer's dspBpm estimator settles on a tempo for an
 * UNKNOWN track it ships the value here over IPC and we append it.
 * NOTE: learned values are live ESTIMATES, not ground truth — edit the JSON by
 * hand to correct any that read wrong. */
let bpmDbPath = null;                     // resolved at app-ready (needs app.getPath)
let bpmDbWriteChain = Promise.resolve();  // serialize writes so they can't clobber

function bpmDbHumanKey(title, artist) {
  return `${String(title || "").trim()} - ${String(artist || "").trim()}`;
}

// Load the persistent dictionary into BPM_DICTIONARY (sanitized keys for robust
// matching). Missing file is normal on first run.
async function loadBpmDictionary() {
  bpmDbPath = path.join(app.getPath("userData"), "bpm-dictionary.json");
  try {
    const json = JSON.parse(await fsp.readFile(bpmDbPath, "utf8"));
    let n = 0;
    for (const humanKey of Object.keys(json || {})) {
      const bpm = parseInt(json[humanKey], 10);
      if (!Number.isFinite(bpm) || bpm <= 0) continue;
      const sep = humanKey.lastIndexOf(" - "); // "Title - Artist" -> split on LAST " - "
      const t = sep >= 0 ? humanKey.slice(0, sep) : humanKey;
      const a = sep >= 0 ? humanKey.slice(sep + 3) : "";
      BPM_DICTIONARY[tempoKey(t, a)] = bpm;
      n++;
    }
    console.log(`[BPM Dictionary] Loaded ${n} learned song(s) from ${bpmDbPath}`);
  } catch (err) {
    if (err && err.code === "ENOENT") console.log(`[BPM Dictionary] No file yet - created on first learn: ${bpmDbPath}`);
    else console.warn("[BPM Dictionary] Load failed: " + (err && err.message ? err.message : err));
  }
}

// Append one learned entry, then write the whole map back atomically (tmp+rename).
// Writes are chained so concurrent learns serialize. Never overwrites a known key.
function persistLearnedBpm(title, artist, bpm) {
  const parsed = parseInt(bpm, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 400) return; // plausibility guard
  if (!title && !artist) return;
  const sanitizedKey = tempoKey(title, artist);
  if (Number.isFinite(BPM_DICTIONARY[sanitizedKey])) return; // already known -> keep it
  BPM_DICTIONARY[sanitizedKey] = parsed; // update in-memory immediately

  const humanKey = bpmDbHumanKey(title, artist);
  bpmDbWriteChain = bpmDbWriteChain
    .then(async () => {
      if (!bpmDbPath) return;
      let json = {};
      try { json = JSON.parse(await fsp.readFile(bpmDbPath, "utf8")) || {}; } catch (_) { json = {}; }
      if (json[humanKey]) return; // already on disk
      json[humanKey] = parsed;
      const tmp = bpmDbPath + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(json, null, 2) + "\n", "utf8");
      await fsp.rename(tmp, bpmDbPath); // atomic replace
      console.log(`[BPM Dictionary] Learned "${humanKey}" -> ${parsed} BPM (saved).`);
    })
    .catch((e) => console.warn("[BPM Dictionary] Save failed: " + (e && e.message ? e.message : e)));
}

// Renderer ships a settled dspBpm estimate for an unknown track -> persist it.
// This is where the app BUILDS ITS OWN offline database: the locally-computed
// tempo is written straight into offline_cache.db, paired with a best-effort
// MusicBrainz release year, so the next play of this track is a 100% offline hit.
ipcMain.on("learn-bpm", (_e, payload) => {
  if (!payload) return;
  persistLearnedBpm(payload.title, payload.artist, payload.bpm); // -> bpm-dictionary.json (bpm only)
  // Async + optional year lookup (the ONLY network call in normal playback, and
  // only for unknown tracks). On miss/error we still persist the row, year:null.
  const s = sanitizeTrackMetadata(payload.title, payload.artist);
  const save = (year) => { try { musicDb.putMany([{ title: payload.title, artist: payload.artist, bpm: payload.bpm, year }]); } catch (_) {} };
  fetchYearFromMusicBrainz(s.title, s.artist).then(save, () => save(null));
});

// §5 — pristine frontend isolation: the renderer can ask for a track's cached
// tempo+year with one invoke. PURE local lookup against offline_cache.db -- no
// network here (BPM is learned from dspBpm; the row is written by learn-bpm).
// Resolves to { bpm:int, year:int|null } or null (caller falls to live dspBpm).
ipcMain.handle("music-database:get-bpm", (_e, title, artist) => {
  try { return musicDb.getBpm(title, artist); } catch (_) { return null; }
});

// §2 — launch the heavy ingest in a utilityProcess so it never stalls the main
// thread (SMTC bridge + lyric IPC stay responsive). Call from a menu/CLI hook.
function startMassiveIngest(inputFilePath, opts) {
  const worker = utilityProcess.fork(path.join(__dirname, "db-ingest-worker.js"));
  worker.on("message", (m) => {
    if (!m) return;
    if (m.type === "progress") console.log(`[music-db] ${m.total} parsed -> ${m.inserted} inserted`);
    else if (m.type === "done") console.log(`[music-db] ingest worker finished: ${JSON.stringify(m)}`);
  });
  worker.postMessage({
    type: "ingest",
    userDataPath: app.getPath("userData"),
    inputFilePath,
    exportShards: !!(opts && opts.exportShards),
  });
  return worker;
}

// GetSongBPM API key. Read from the environment ONLY so no key ships in this
// public source. "" disables the (off-by-default) GetSongBPM layer entirely.
// Set GETSONGBPM_KEY in your environment or a gitignored .env to enable it.
const GETSONGBPM_KEY = process.env.GETSONGBPM_KEY || "";

// LAYER 2 hidden-window scraper toggle. DEFAULT ON when a key is present.
// api.getsongbpm.com sits behind a Cloudflare MANAGED challenge ("Just a
// moment…", Cf-Mitigated: challenge) that 403s any client which can't execute
// the challenge JS — so net.fetch / curl are hard-blocked, but a real hidden
// Chromium window DOES clear it (measured: ~15 s cold, then instant while the
// cf_clearance cookie persists in the default session, even across restarts).
// The earlier "stuck forever" diagnosis was really a 6.5 s timeout bailing
// before the ~15 s solve (now SCRAPER_TIMEOUT_MS). Cloudflare can still escalate
// to a CAPTCHA / loop under rapid repeated hits; per-track spaced lookups + the
// renderer's live dspBpm fallback keep that from ever hanging playback.
const ENABLE_BPM_SCRAPER = true;

// Fuzzy metadata cleaner for open-source libraries with unpredictable tagging.
// Lowercases and strips noise tags so lookups are stable. Regexes are the
// BOUNDED / word-boundaried / space-required forms (the naive greedy versions
// eat 'Jay-Z'->'Jay', '(Forever)', and multi-bracket titles):
//   1) "(… remix …)" / "[… remix …]"  — confined to ONE bracket group
//   2) "(… remaster|live|official|cover|version|edit …)" — \b-bounded tokens
//   3) " - <anything>"               — only with a real " - " separator
function sanitizeTrackMetadata(title, artist) {
  const clean = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s*[\(\[][^)\]]*remix[^)\]]*[)\]]/gi, " ")
      .replace(/\s*[\(\[][^)\]]*\b(?:remaster(?:ed)?|live|official|cover|version|edit(?:ed)?)\b[^)\]]*[)\]]/gi, " ")
      .replace(/\s+-\s+.*$/, " ")
      .replace(/\s+/g, " ")
      .trim();
  return { title: clean(title), artist: clean(artist) };
}

// Stable dictionary key from the sanitized metadata (punctuation folded out so
// "don't"/"dont" collide). "Some Title"/"Some Artist" -> "some title|some artist".
function tempoKey(title, artist) {
  const s = sanitizeTrackMetadata(title, artist);
  const keyify = (x) => x.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return keyify(s.title) + "|" + keyify(s.artist);
}

function lookupTempoLocal(title, artist) {
  const bpm = BPM_DICTIONARY[tempoKey(title, artist)];
  return Number.isFinite(bpm) ? bpm : null;
}

// (Layer-2 tempo extraction + the hidden-window scraper now live in
// ./getsongbpm.js so the parser is unit-testable in plain Node.)

/* ── MUSICBRAINZ RELEASE-YEAR LOOKUP (year ONLY; no Spotify token, no API key) ─
 * On-demand metadata loop inspired by the approach in L3N0X's spicetify-dj-info
 * (MIT). PROVENANCE: that extension reads data from the logged-in Spotify
 * client's OWN session token (it runs inside Spotify). This app reads "now
 * playing" from Windows SMTC and holds no Spotify token, so we cannot reuse its
 * endpoint. No code is copied from spicetify-dj-info; this is original.
 *
 * SCOPE: year only. BPM is handled entirely by the renderer's live dspBpm
 * estimator (160 Hz kick lowpass + octave-correction gate). Live testing showed
 * the open BPM databases (AcousticBrainz) hit ~1 track in 5, so they were
 * dropped to keep the network footprint tiny and private. This single call runs
 * ONCE per newly-learned track (from learn-bpm), never in the SMTC hot path.
 *
 * Year is BEST-EFFORT: MusicBrainz text-ranks reissues/remasters high, so the
 * earliest first-release-date across the top matches can be a later edition's
 * year rather than the original. We accept that; a miss simply stores null. */
const NET_LOOKUP_BUDGET_MS = 3000;
// MusicBrainz blocks generic/empty User-Agents; identify the app + a contact.
const METADATA_UA = "CotoLyricsAlpha/2.0 (https://github.com/ ; local BPM cache)";

async function fetchJsonWithTimeout(url, signal) {
  const resp = await net.fetch(url, { signal, headers: { "User-Agent": METADATA_UA, Accept: "application/json" } });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

// Resolve an integer release year for a SANITIZED title/artist, or null. Never
// throws; never runs past the 3s budget. One MusicBrainz request, year only.
async function fetchYearFromMusicBrainz(title, artist) {
  if (!title) return null;
  const signal = AbortSignal.timeout(NET_LOOKUP_BUDGET_MS);
  const yearOf = (d) => { const m = String(d || "").match(/^\d{4}/); return m ? parseInt(m[0], 10) : null; };
  try {
    const query = `recording:"${title}"` + (artist ? ` AND artist:"${artist}"` : "");
    const mbUrl = "https://musicbrainz.org/ws/2/recording/?fmt=json&limit=5&query=" + encodeURIComponent(query);
    const mb = await fetchJsonWithTimeout(mbUrl, signal);
    const recs = mb && Array.isArray(mb.recordings) ? mb.recordings : [];
    let year = null;
    for (const r of recs) { const y = yearOf(r["first-release-date"]); if (y !== null && (year === null || y < year)) year = y; }
    if (year !== null) console.log("[MusicBrainz] " + title + " -> year " + year);
    return year;
  } catch (e) {
    console.warn("[MusicBrainz] year lookup failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

// LAYER 2 budget. Cloudflare's managed challenge clears in ~15 s cold (measured),
// so the timeout must comfortably exceed that; a genuinely looping wall still
// can't hang playback because the renderer's live dspBpm runs meanwhile.
const SCRAPER_TIMEOUT_MS = 22000;

// CLOUDFLARE BACK-OFF BREAKER. Deep testing showed the managed challenge clears
// once cold, then escalates to a persistent loop under repeated automated hits.
// To avoid spawning doomed ~22 s windows in that state, we pause GetSongBPM after
// a couple of consecutive BLOCKED attempts (timeout/captcha); any clear (ok/miss
// = API reachable) resets the streak. A "miss" does NOT count as blocked — the
// API answered, the song just isn't in their DB.
const SCRAPE_FAIL_LIMIT = 2;
const SCRAPE_COOLDOWN_MS = 15 * 60 * 1000; // pause window after the breaker trips
let scrapeBlockStreak = 0;
let scrapeCooldownUntil = 0;

// Waterfall on the SANITIZED metadata: dictionary -> SQLite cache -> GetSongBPM
// scrape -> null. Layers 1a/1c are instant + offline; only an UNKNOWN track
// reaches Layer 2 (one hidden-window lookup, ~15 s cold then cached). A null
// here means the renderer's live dspBpm takes over and writes its own estimate
// back via learn-bpm, so playback never blocks on the network.
async function resolveBpm(title, artist) {
  const s = sanitizeTrackMetadata(title, artist);
  // LAYER 1a — local dictionary (sanitized key). Checked BEFORE any scraper: a
  // known track should never spin up a browser window.
  const local = lookupTempoLocal(title, artist);
  if (Number.isFinite(local)) return { bpm: local, source: "dictionary" };
  // LAYER 1c - sandboxed local SQLite cache (offline_cache.db). Instant indexed
  // hit; disabled-safe (returns null when better-sqlite3 isn't loaded).
  const cached = musicDb.getBpm(title, artist);
  if (cached && Number.isFinite(cached.bpm)) return { bpm: cached.bpm, year: cached.year, source: "sqlite-cache" };
  // LAYER 2 — GetSongBPM via a hidden Chromium window (the only client that
  // clears its Cloudflare managed challenge; net.fetch is hard-403'd). On a hit
  // we PERSIST to both stores (dictionary.json + SQLite, with a best-effort
  // release year) so this song is a 100% offline hit forever after. On a
  // 403 / CAPTCHA / timeout the scraper returns null -> live dspBpm takes over.
  if (ENABLE_BPM_SCRAPER && GETSONGBPM_KEY && Date.now() >= scrapeCooldownUntil) {
    const { bpm: web, status } = await scrapeBpmViaHiddenWindow(
      BrowserWindow, GETSONGBPM_KEY, s.title, s.artist, { timeoutMs: SCRAPER_TIMEOUT_MS });
    // Breaker bookkeeping: ok/miss = Cloudflare reachable (reset); timeout/captcha
    // = blocked (count, and pause scraping once the streak hits the limit).
    if (status === "ok" || status === "miss") {
      scrapeBlockStreak = 0;
    } else if (status === "timeout" || status === "captcha") {
      if (++scrapeBlockStreak >= SCRAPE_FAIL_LIMIT) {
        scrapeCooldownUntil = Date.now() + SCRAPE_COOLDOWN_MS;
        scrapeBlockStreak = 0;
        console.warn(`[Scraper] Cloudflare blocking (${status}) — pausing GetSongBPM ${SCRAPE_COOLDOWN_MS / 60000} min; live dspBpm only.`);
      }
    }
    if (Number.isFinite(web)) {
      persistLearnedBpm(title, artist, web); // -> BPM_DICTIONARY + bpm-dictionary.json
      const save = (year) => { try { musicDb.putMany([{ title, artist, bpm: web, year }]); } catch (_) {} };
      fetchYearFromMusicBrainz(s.title, s.artist).then(save, () => save(null)); // best-effort, fire-and-forget
      return { bpm: web, source: "getsongbpm-scrape" };
    }
  }
  return null;
}

// Map a numeric BPM to the 3-tier motion profile label (for the diagnostic log).
// Mirrors the renderer's profileFromBpm boundaries: <100 LOW, 100–140 MID, >140 HIGH.
function bpmProfileLabel(bpm) {
  if (!(bpm > 0)) return "UNKNOWN";
  if (bpm < 100) return "LOW (Profile 1)";
  if (bpm <= 140) return "MID (Profile 2)";
  return "HIGH (Profile 3)";
}

// Run the waterfall ONCE per track (SMTC heartbeats repeat the same track every
// ~1s) and forward the numeric result. The final value is strictly cast via
// parseInt(bpm, 10) before crossing the IPC bridge to the renderer.
let lastBpmTrackKey = "";
function maybeResolveBpm(obj) {
  if (!obj || obj.status === "none" || obj.status === "closed") return;
  const title = obj.title || "";
  const artist = obj.artist || "";
  if (!title && !artist) return;
  const key = (title + "|" + artist).toLowerCase();
  if (key === lastBpmTrackKey) return; // already resolved this track
  lastBpmTrackKey = key;
  resolveBpm(title, artist)
    .then((res) => {
      if (key !== lastBpmTrackKey) return; // track changed again mid-lookup -> drop
      if (!res || !Number.isFinite(res.bpm)) {
        // No dictionary/network tempo -> the renderer's live dspBpm estimator
        // takes over, so the profile never has to sit stuck at LOW.
        console.warn(`[BPM Debug] No backend tempo for "${title}" -> deferring to live dspBpm estimator.`);
        return;
      }
      const bpm = parseInt(res.bpm, 10);
      const currentBpmProfile = bpmProfileLabel(bpm);
      // Unified diagnostic token — fired right before the IPC send.
      console.log("[BPM Debug] Selected Profile: " + currentBpmProfile);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bpm-update", { title, artist, bpm, year: res.year, source: res.source });
      }
      console.log(`[BPM] ${title} - ${artist} -> ${bpm} (${res.source})`);
    })
    .catch(() => {});
}

/* ── Window ────────────────────────────────────────────────────────────── */
function createWindow() {
  // Grant system-audio loopback to getDisplayMedia() with no picker. We need a
  // video source for the request to resolve on Chromium; the renderer drops the
  // video track immediately and keeps only the loopback audio track.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({})); // deny gracefully -> renderer falls back to neutral
    },
    { useSystemPicker: false }
  );

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(APPROVED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    APPROVED_PERMISSIONS.includes(permission)
  );

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#FFFFFF",
    title: "CotoLyrics",
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Mirror renderer console to the main-process stdout so `npm start` shows the
  // live DSP/BPM diagnostics (and any renderer error) in the terminal — the
  // renderer's own DevTools console is otherwise invisible to a CLI launch.
  // Forwards our [DSP]/[BPM]/[CotoLyrics] traces plus all warnings/errors.
  mainWindow.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 || /^\[(DSP|BPM|CotoLyrics)\b/.test(message)) {
      const tag = level >= 3 ? "ERROR" : level === 2 ? "warn" : "log";
      console.log(`[renderer:${tag}] ${message}`);
    }
  });

  mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  musicDb.init(app.getPath("userData")); // open the sandboxed SQLite cache (creates dirs)
  await loadBpmDictionary(); // load the persistent self-learning dictionary first
  registerAppProtocol();
  createWindow();
  startSmtcBridge();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  shuttingDown = true;
  stopChildren();
});

app.on("window-all-closed", () => {
  shuttingDown = true;
  stopChildren();
  if (process.platform !== "darwin") app.quit();
});
