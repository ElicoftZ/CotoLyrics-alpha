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
});
