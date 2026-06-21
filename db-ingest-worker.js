"use strict";
/* ============================================================================
 *  db-ingest-worker.js  --  Electron utilityProcess entry for heavy ingestion.
 *
 *  Runs processMassiveSongDataset OFF the main thread so the SMTC bridge and the
 *  lyric IPC never stall during a multi-million-row build. better-sqlite3 is
 *  synchronous; keeping it here means its blocking calls never touch the main
 *  process event loop. WAL mode lets the main process keep reading while we write.
 *
 *  Protocol (over process.parentPort):
 *    in : { type:"ingest", userDataPath, inputFilePath, exportShards? }
 *    out: { type:"progress", total, inserted } ... { type:"done", ok, total, inserted }
 * ========================================================================== */
const mdb = require("./music-database");

process.parentPort.on("message", async (e) => {
  const msg = (e && e.data) || {};
  if (msg.type !== "ingest") return;
  try {
    mdb.init(msg.userDataPath);
    const res = await mdb.processMassiveSongDataset(msg.inputFilePath, (p) => {
      try { process.parentPort.postMessage({ type: "progress", total: p.total, inserted: p.inserted }); } catch (_) {}
    });
    if (msg.exportShards) await mdb.exportShards();
    mdb.close();
    try { process.parentPort.postMessage({ type: "done", ...res }); } catch (_) {}
  } catch (err) {
    try { process.parentPort.postMessage({ type: "done", ok: false, error: String(err && err.message || err) }); } catch (_) {}
  }
});
