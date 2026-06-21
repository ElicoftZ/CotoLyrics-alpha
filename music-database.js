"use strict";
/* ============================================================================
 *  music-database.js  --  sandboxed local song/BPM store + bulk ingester
 *
 *  - SQLite (better-sqlite3) living in userData, NOT in the repo. A UNIQUE index
 *    handles dedup; WAL mode lets the main process read while a build writes.
 *  - Loaded GUARDED: if the native module isn't built for this Electron ABI, the
 *    store disables itself and getBpm() returns null, so the renderer falls
 *    cleanly to live dspBpm. The frontend stays oblivious either way.
 *  - Pure Node (no electron require) so it runs in the main process AND inside a
 *    utilityProcess ingest worker.
 *  - ASCII-only logging (no em-dash / ellipsis) to avoid Windows console mojibake.
 * ========================================================================== */
const path = require("path");
const fs = require("fs");
const readline = require("readline");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (e) {
  console.warn("[music-db] better-sqlite3 unavailable (" + (e && e.code ? e.code : (e && e.message)) +
    ") -> local DB disabled; dspBpm fallback only.");
}

let dbDir = null, stagingDir = null, dbPath = null;
let db = null, getStmt = null, insertStmt = null;

const BATCH = 50000;   // rows per transaction flush -> bounded memory
const MAX_BPM = 400;   // plausibility ceiling

/* ---- normalization (mirrors main.js sanitizeTrackMetadata so keys match) ---- */
function normField(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s*[\(\[][^)\]]*remix[^)\]]*[)\]]/gi, " ")
    .replace(/\s*[\(\[][^)\]]*\b(?:remaster(?:ed)?|live|official|cover|version|edit(?:ed)?)\b[^)\]]*[)\]]/gi, " ")
    .replace(/\s+-\s+.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// First two SAFE chars of the normalized title -> shardKey. Untrusted rows can
// hold "..", "/", control chars, or split surrogate pairs (CJK/emoji), so we
// strip to [a-z0-9] before slicing -> no path traversal, no invalid filenames.
function shardKeyFor(title) {
  const t = normField(title).replace(/[^a-z0-9]/g, "");
  return t.length < 2 ? "xx" : t.slice(0, 2);
}

/* ---- lifecycle ---- */
// init(userDataPath): resolve + create the sandboxed dirs, open the DB, build
// the schema. Always creates the dirs (even with the DB disabled). Returns bool.
function init(userDataPath) {
  dbDir = path.join(userDataPath, "database_storage");
  stagingDir = path.join(userDataPath, "database_build_staging");
  dbPath = path.join(dbDir, "offline_cache.db");
  for (const d of [dbDir, stagingDir]) {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      console.warn("[music-db] mkdir failed for " + d + ": " + (e && e.message));
    }
  }
  if (!Database) return false;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");   // concurrent reads during a build
    db.pragma("synchronous = NORMAL"); // fast bulk writes, still crash-safe under WAL
    db.exec(
      "CREATE TABLE IF NOT EXISTS songs (" +
      " title TEXT NOT NULL, artist TEXT NOT NULL, bpm INTEGER NOT NULL, year INTEGER, shardKey TEXT NOT NULL);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_key ON songs(title, artist);" +
      "CREATE INDEX IF NOT EXISTS idx_songs_shard ON songs(shardKey);"
    );
    // Additive migration for offline_cache.db files built before the `year`
    // column existed. CREATE TABLE IF NOT EXISTS never reshapes an existing
    // table, so we ADD COLUMN explicitly; it throws "duplicate column" once the
    // column is present, which we swallow to keep startup idempotent.
    try { db.exec("ALTER TABLE songs ADD COLUMN year INTEGER"); } catch (_) {}
    getStmt = db.prepare("SELECT bpm, year FROM songs WHERE title = ? AND artist = ? LIMIT 1");
    insertStmt = db.prepare("INSERT OR IGNORE INTO songs (title, artist, bpm, year, shardKey) VALUES (?, ?, ?, ?, ?)");
    console.log("[music-db] ready: " + dbPath);
    return true;
  } catch (e) {
    console.warn("[music-db] open failed: " + (e && e.message) + " -> DB disabled.");
    db = null;
    return false;
  }
}

// Release year is OPTIONAL metadata. Clamp to a sane band or store NULL so junk
// (0, "n/a", 12345, NaN) never lands in the column -- without rejecting the row,
// whose BPM is the value that actually matters.
function normYear(y) {
  const n = parseInt(y, 10); // parseInt("1997-08-25") -> 1997, so ISO dates work
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : null;
}

// Instant offline lookup. Returns { bpm:int, year:int|null } or null when there
// is no row / the store is disabled (caller then falls to dspBpm).
function getBpm(title, artist) {
  if (!getStmt) return null;
  try {
    const row = getStmt.get(normField(title), normField(artist));
    if (!row || !Number.isFinite(row.bpm)) return null;
    return { bpm: row.bpm, year: Number.isFinite(row.year) ? row.year : null };
  } catch (_) {
    return null;
  }
}

// Upsert rows ({title, artist, bpm}) -> dedup via INSERT OR IGNORE. Used by the
// renderer-learn path and the ingester. Returns the count actually inserted.
function putMany(rows) {
  if (!insertStmt || !db || !Array.isArray(rows) || !rows.length) return 0;
  const tx = db.transaction((items) => {
    let n = 0;
    for (const r of items) {
      const t = normField(r.title);
      const a = normField(r.artist);
      const b = parseInt(r.bpm, 10);
      if (!t || !Number.isFinite(b) || b <= 0 || b > MAX_BPM) continue;
      n += insertStmt.run(t, a, b, normYear(r.year), shardKeyFor(r.title)).changes;
    }
    return n;
  });
  try { return tx(rows); } catch (_) { return 0; }
}

/* ---- ingestion ---- */
// Pull title / artist / bpm out of a heterogeneous record (jsonl object or a
// csv column-map). Tries the common MetaBrainz / dataset field names.
function extractRow(obj) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
    }
    return "";
  };
  const title = pick("title", "song", "song_title", "track", "track_name", "recording", "name");
  const artist = pick("artist", "artist_name", "artists", "artist_credit", "albumartist");
  const bpm = parseInt(pick("bpm", "tempo", "song_bpm", "BPM", "Tempo"), 10);
  // Year is optional; accept a bare year or an ISO date (normYear slices it).
  const year = pick("year", "release_year", "date", "first-release-date", "Year", "Date");
  if (!String(title).trim() || !Number.isFinite(bpm) || bpm <= 0) return null;
  return { title, artist, bpm, year };
}

// Quote-aware CSV line splitter (handles commas inside quoted fields and ""
// escapes). NOTE: embedded NEWLINES inside quoted fields are not supported by
// this line-oriented reader -- fine for tabular BPM datasets, which don't use
// them; switch to a streaming CSV parser dependency if a source ever needs it.
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') {
      q = true;
    } else if (c === ",") {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// processMassiveSongDataset(inputFilePath, onProgress)
// Memory-safe streaming ingest of a bulk .jsonl or .csv dataset. Reads row by
// row (readline), batches into transactions every BATCH rows, dedups via the
// UNIQUE index. Memory stays bounded by one batch + the SQLite page cache, so it
// chews through millions of rows well under 80 MB.
async function processMassiveSongDataset(inputFilePath, onProgress) {
  if (!db) {
    console.warn("[music-db] ingest skipped: DB disabled.");
    return { ok: false, reason: "db-disabled" };
  }
  const isCsv = /\.csv$/i.test(inputFilePath);
  const isJsonl = /\.(jsonl|ndjson)$/i.test(inputFilePath);
  if (!isCsv && !isJsonl) {
    console.warn("[music-db] ingest: unsupported file type (need .csv or .jsonl): " + inputFilePath);
    return { ok: false, reason: "unsupported-type" };
  }
  if (!fs.existsSync(inputFilePath)) {
    console.warn("[music-db] ingest: file not found: " + inputFilePath);
    return { ok: false, reason: "not-found" };
  }
  console.log("[music-db] ingest start: " + inputFilePath + " (" + (isCsv ? "csv" : "jsonl") + ")");

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFilePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const flush = db.transaction((items) => {
    let n = 0;
    for (const r of items) {
      const t = normField(r.title);
      const a = normField(r.artist);
      if (!t || !Number.isFinite(r.bpm) || r.bpm <= 0 || r.bpm > MAX_BPM) continue;
      n += insertStmt.run(t, a, r.bpm, normYear(r.year), shardKeyFor(r.title)).changes;
    }
    return n;
  });

  let batch = [];
  let total = 0, inserted = 0;
  let header = null;

  for await (const line of rl) {
    if (!line) continue;
    let row = null;
    if (isJsonl) {
      try { row = extractRow(JSON.parse(line)); } catch (_) { continue; }
    } else {
      const cols = splitCsvLine(line);
      if (!header) { header = cols.map((h) => String(h).trim().toLowerCase()); continue; }
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i];
      row = extractRow(obj);
    }
    if (!row) continue;
    batch.push(row);
    total++;
    if (batch.length >= BATCH) {
      inserted += flush(batch);
      batch = [];
      console.log("[music-db] progress: " + total + " parsed -> " + inserted + " unique inserted...");
      if (onProgress) onProgress({ total, inserted });
    }
  }
  if (batch.length) { inserted += flush(batch); batch = []; }

  console.log("[music-db] ingest done: " + total + " parsed -> " + inserted + " unique inserted. [done]");
  if (onProgress) onProgress({ total, inserted, done: true });
  return { ok: true, total, inserted };
}

// Optional: dump each alphabetical shard out of the DB as appendable JSONL in
// the staging dir. Paginated by rowid (10k-row pages) and honoring write
// backpressure (await 'drain'), so even a huge skewed shard never balloons
// memory. Awaitable -- resolves only once every file has flushed to disk.
// (No publisher -- this is a local export only.)
async function exportShards() {
  if (!db) return { ok: false, reason: "db-disabled" };
  const shardRows = db.prepare("SELECT DISTINCT shardKey FROM songs").all();
  const pageStmt = db.prepare(
    "SELECT rowid AS rid, title, artist, bpm, year FROM songs WHERE shardKey = ? AND rowid > ? ORDER BY rowid LIMIT 10000"
  );
  let files = 0;
  for (const { shardKey } of shardRows) {
    const safe = String(shardKey).replace(/[^a-z0-9]/gi, "_") || "xx";
    const ws = fs.createWriteStream(path.join(stagingDir, safe + ".jsonl"), { encoding: "utf8" });
    let lastRid = 0, page;
    do {
      page = pageStmt.all(shardKey, lastRid);
      for (const r of page) {
        lastRid = r.rid;
        if (!ws.write(JSON.stringify({ title: r.title, artist: r.artist, bpm: r.bpm, year: r.year }) + "\n")) {
          await new Promise((res) => ws.once("drain", res)); // bounded memory
        }
      }
    } while (page.length === 10000);
    await new Promise((res, rej) => { ws.on("finish", res); ws.on("error", rej); ws.end(); });
    files++;
  }
  console.log("[music-db] exported " + files + " shard file(s) to " + stagingDir);
  return { ok: true, files };
}

function close() {
  try { if (db) db.close(); } catch (_) {}
  db = null;
}

module.exports = {
  init,
  getBpm,
  putMany,
  processMassiveSongDataset,
  exportShards,
  shardKeyFor,
  normField,
  close,
  isEnabled: () => !!db,
};
