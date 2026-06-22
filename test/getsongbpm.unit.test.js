"use strict";
/* Deterministic unit tests for the GetSongBPM payload parser (no network, no
 * Electron). Shapes below were captured from the REAL API during probing:
 *   HIT  -> { search: [ { tempo: "112", ... } ] }   (tempo is a STRING)
 *   MISS -> { search: { error: "no result" } }       (search is an OBJECT)
 *   BAD  -> { error: "..." }                          (top-level error)
 * The parser must pull the int on a hit and yield NaN (never throw) otherwise.
 * Run: node test/getsongbpm.unit.test.js   (exit 1 on any failure)
 */
const { extractTempoFromPayload } = require("../getsongbpm.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Number.isNaN(want) ? Number.isNaN(got) : got === want;
  if (ok) { pass++; }
  else { fail++; console.error(`  FAIL: ${name} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Real hit shape (trimmed NGGYU payload as returned by the live API).
const NGGYU = { search: [{ id: "qZPp7", title: "Never Gonna Give You Up", tempo: "112", time_sig: "4/4", key_of: "A#m", artist: { name: "Rick Astley" } }] };

check("real hit (string tempo)", extractTempoFromPayload(NGGYU), 112);
check("hit via .bpm fallback", extractTempoFromPayload({ search: [{ bpm: 140 }] }), 140);
check("array data[0].tempo", extractTempoFromPayload([{ tempo: "128" }]), 128);
check("top-level .tempo", extractTempoFromPayload({ tempo: "95" }), 95);
check("top-level .song_bpm", extractTempoFromPayload({ song_bpm: "150" }), 150);
check("tempo string with junk -> parseInt", extractTempoFromPayload({ search: [{ tempo: "174 bpm" }] }), 174);

// Misses / errors must be NaN, never throw.
check("miss object {search:{error}}", extractTempoFromPayload({ search: { error: "no result" } }), NaN);
check("top-level error", extractTempoFromPayload({ error: "invalid api key" }), NaN);
check("empty object", extractTempoFromPayload({}), NaN);
check("empty search array", extractTempoFromPayload({ search: [] }), NaN);
check("null", extractTempoFromPayload(null), NaN);
check("undefined", extractTempoFromPayload(undefined), NaN);
check("empty array", extractTempoFromPayload([]), NaN);
check("tempo '0' rejected (must be >0)", extractTempoFromPayload({ search: [{ tempo: "0" }] }), NaN);
check("negative tempo rejected", extractTempoFromPayload({ search: [{ tempo: "-120" }] }), NaN);
check("non-numeric tempo", extractTempoFromPayload({ search: [{ tempo: "fast" }] }), NaN);

console.log(`\ngetsongbpm parser: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
