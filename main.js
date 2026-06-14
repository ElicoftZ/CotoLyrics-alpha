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
} = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

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
 *   LAYER 1  Local dictionary  — instant, no network (e.g. Memory Merge -> 184).
 *   LAYER 2  Spotify audio-features — INTENTIONALLY OMITTED. Spotify deprecated
 *            the /v1/audio-features tempo endpoint for new apps on 2024-11-27,
 *            so a fresh Client-Credentials app only gets 403 there.
 *   LAYER 3  GetSongBPM web lookup — via Electron net.fetch, which (unlike the
 *            renderer over app://) is NOT subject to CORS. Needs a free api_key.
 *   LAYER 4  Live dspBpm onset estimate — lives in the renderer (Web Audio), the
 *            final fallback when this resolver returns nothing.                */

// LAYER 1 — hardcoded tempos. "memory merge|yonkagor": 184 locks immediately.
const BPM_DICTIONARY = {
  "memory merge|yonkagor": 184,
};

// LAYER 3 key. Empty string disables the network layer (skips straight to dspBpm).
const GETSONGBPM_KEY = "";

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
// "don't"/"dont" collide). "Memory Merge"/"YonKaGor" -> "memory merge|yonkagor".
function tempoKey(title, artist) {
  const s = sanitizeTrackMetadata(title, artist);
  const keyify = (x) => x.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return keyify(s.title) + "|" + keyify(s.artist);
}

function lookupTempoLocal(title, artist) {
  const bpm = BPM_DICTIONARY[tempoKey(title, artist)];
  return Number.isFinite(bpm) ? bpm : null;
}

// LAYER 3 — GetSongBPM. Electron net.fetch (no renderer CORS restriction here).
async function lookupTempoGetSongBpm(title, artist) {
  if (!GETSONGBPM_KEY) return null;
  try {
    const q = encodeURIComponent(`song:${title} artist:${artist}`);
    const url = `https://api.getsongbpm.com/search/?api_key=${GETSONGBPM_KEY}&type=both&lookup=${q}`;
    const r = await net.fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j && j.search && (Array.isArray(j.search) ? j.search[0] : null);
    const tempo = hit && parseFloat(hit.tempo);
    return Number.isFinite(tempo) && tempo > 0 ? tempo : null;
  } catch (_) {
    return null; // network/parse failure -> fall through to the renderer's dspBpm
  }
}

// Waterfall on the SANITIZED metadata: LAYER 1 (keyword gate -> dictionary) ->
// LAYER 2 (GetSongBPM, cached) -> null. A successful network result is APPENDED
// to the dictionary (keyed by tempoKey) so the song is never re-queried.
async function resolveBpm(title, artist) {
  const s = sanitizeTrackMetadata(title, artist);
  // LAYER 1a — explicit keyword gate: force 184 BPM, zero network.
  if (s.title.includes("memory merge") || s.title.includes("opalite")) {
    return { bpm: 184, source: "keyword-gate" };
  }
  // LAYER 1b — local dictionary (sanitized key).
  const local = lookupTempoLocal(title, artist);
  if (Number.isFinite(local)) return { bpm: local, source: "dictionary" };
  // LAYER 2 — GetSongBPM on the sanitized strings (+ in-memory cache).
  const web = await lookupTempoGetSongBpm(s.title, s.artist);
  if (Number.isFinite(web)) {
    BPM_DICTIONARY[tempoKey(title, artist)] = web; // cache for the rest of the session
    return { bpm: web, source: "getsongbpm" };
  }
  return null;
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
      if (!res || !Number.isFinite(res.bpm)) return;
      if (key !== lastBpmTrackKey) return; // track changed again mid-lookup -> drop
      const bpm = parseInt(res.bpm, 10);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bpm-update", { title, artist, bpm, source: res.source });
      }
      console.log(`[BPM] ${title} — ${artist} -> ${bpm} (${res.source})`);
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
    title: "Lyric Speaker",
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
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
