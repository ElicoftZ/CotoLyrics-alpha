/* ═══════════════════════════════════════════════════════════════════════
 *  PRELOAD  (SMTC-only)
 *
 *  Runs in an isolated context (contextIsolation: true) and is the ONLY bridge
 *  between the renderer and the main process. The renderer must never call
 *  require('electron') directly — with contextIsolation + nodeIntegration:false
 *  that throws. Everything it needs is exposed on window.cotodama below.
 *
 *  - onSmtcUpdate(cb): subscribe to the Windows SMTC "now playing" stream (the
 *    single source of truth — Spotify / Apple Music / browsers). Each payload is
 *    the parsed JSON object; returns an unsubscribe function. IpcRendererEvent is
 *    not cloneable across the bridge, so we forward only the payload.
 * ═══════════════════════════════════════════════════════════════════════ */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cotodama", {
  onSmtcUpdate: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("smtc-update", h);
    return () => ipcRenderer.removeListener("smtc-update", h);
  },
  // §1 — backend BPM waterfall result: { title, artist, bpm:<int>, source }.
  // Resolved once per track in main and pushed here; returns an unsubscribe fn.
  onBpmUpdate: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("bpm-update", h);
    return () => ipcRenderer.removeListener("bpm-update", h);
  },
  // §genre — Last.fm-resolved canonical genre for the current track:
  // { title, artist, genre, animation, source, tags }. Resolved once per track in
  // main and pushed here; drives the per-letter animation. Returns an unsubscribe fn.
  onGenreUpdate: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("genre-update", h);
    return () => ipcRenderer.removeListener("genre-update", h);
  },
  // §learn — ship a settled dspBpm estimate for an UNKNOWN track to main, which
  // appends it to the persistent bpm-dictionary.json (fire-and-forget).
  learnBpm: (title, artist, bpm) => ipcRenderer.send("learn-bpm", { title, artist, bpm }),
  // §5 — tempo+year lookup. Tries the local SQLite cache first, then an open
  // metadata network fallback (3s budget) which is cached back for next time.
  // Resolves to { bpm:int, year:int|null } or null (caller then falls to live
  // dspBpm). Frontend stays clean either way.
  getBpm: (title, artist) => ipcRenderer.invoke("music-database:get-bpm", title, artist),
  // §settings — persist / restore the user's uploaded lyrics font. saveFont ships
  // the raw bytes to main (written under userData); loadFont returns { name, bytes }
  // or null. Bytes cross the bridge as a Uint8Array.
  saveFont: (name, bytes) => ipcRenderer.invoke("settings:save-font", { name, bytes }),
  loadFont: () => ipcRenderer.invoke("settings:load-font"),
});
