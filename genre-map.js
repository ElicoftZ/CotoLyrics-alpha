/* ═══════════════════════════════════════════════════════════════════════
 *  GENRE MAP  (tag → canonical-genre classifier)
 *
 *  Genre providers hand us tag strings: iTunes gives one clean primaryGenreName
 *  ("R&B/Soul", "Electronic", "Hip-Hop/Rap"); the optional Last.fm path gives a
 *  noisy ranked folksonomy ("melodic death metal", "chillhop", "seen live", "00s").
 *  This module collapses either into ONE of the 50 canonical genres in Genre.txt,
 *  each of which the renderer maps to a letter-by-letter animation primitive.
 *
 *  Strategy (per the approved plan): a deterministic ALIAS MAP runs first —
 *  fast, offline, zero deps. An ordered rule list (most-specific genres first,
 *  generic last) is tested as substrings against each normalized tag, in the
 *  tag's own popularity rank order; the first tag that matches any rule wins.
 *  Truly novel subgenres that miss every rule fall to classifyUnmatched(), the
 *  SEAM where an on-device DeBERTa-v3-XSmall zero-shot classifier slots in
 *  later (it returns null today, so we fall back to the default genre).
 *
 *  Lives main-side: the renderer can't require() under contextIsolation, so
 *  main.js classifies and ships { genre, animation } across the IPC bridge.
 * ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// Canonical 50 (Genre.txt is the source of truth; encoded here so the module is
// self-contained and unit-testable in plain Node). `animation` is the Genre.txt
// label; the renderer keys its motion-primitive table on `genre`.
const GENRES = [
  { n: 1, genre: "Pop", animation: "Bouncy" },
  { n: 2, genre: "Hip-Hop / Rap", animation: "Punchy" },
  { n: 3, genre: "Rock", animation: "Kinetic" },
  { n: 4, genre: "Electronic / EDM", animation: "Glitchy" },
  { n: 5, genre: "R&B", animation: "Smooth" },
  { n: 6, genre: "Country", animation: "Static" },
  { n: 7, genre: "Jazz", animation: "Swing" },
  { n: 8, genre: "Classical", animation: "Elegant" },
  { n: 9, genre: "Reggae", animation: "Swaying" },
  { n: 10, genre: "Metal", animation: "Chaotic" },
  { n: 11, genre: "Lo-Fi", animation: "Blur-Drifting" },
  { n: 12, genre: "Synthwave", animation: "Glow-Pulse" },
  { n: 13, genre: "Indie / Folk", animation: "Minimal" },
  { n: 14, genre: "Latin / Reggaeton", animation: "Rhythmic" },
  { n: 15, genre: "K-Pop / J-Pop", animation: "Flashy" },
  { n: 16, genre: "Punk", animation: "Jittery" },
  { n: 17, genre: "Blues", animation: "Soulful" },
  { n: 18, genre: "Soul / Funk", animation: "Groovy" },
  { n: 19, genre: "Ambient", animation: "Blur-Fading" },
  { n: 20, genre: "Disco", animation: "Sparkling" },
  { n: 21, genre: "Gospel", animation: "Rising" },
  { n: 22, genre: "Ska", animation: "Elastic" },
  { n: 23, genre: "Industrial", animation: "Mechanical" },
  { n: 24, genre: "Hyperpop", animation: "Spastic" },
  { n: 25, genre: "Orchestral Film", animation: "Cinematic" },
  { n: 26, genre: "Trap", animation: "Bass-Punchy" },
  { n: 27, genre: "Dubstep", animation: "Warp-Stretching" },
  { n: 28, genre: "Phonk", animation: "Drift-Glitchy" },
  { n: 29, genre: "Shoegaze", animation: "Motion-Blur" },
  { n: 30, genre: "Vaporwave", animation: "Dreamy-Glow" },
  { n: 31, genre: "Afrobeats", animation: "Bounce-Groovy" },
  { n: 32, genre: "Grime", animation: "Hard-Snapping" },
  { n: 33, genre: "Techno", animation: "Strobe-Pacing" },
  { n: 34, genre: "House", animation: "Fluid-Swaying" },
  { n: 35, genre: "Bluegrass", animation: "Rapid-Reveal" },
  { n: 36, genre: "Chiptune / 8-Bit", animation: "Pixel-Stepping" },
  { n: 37, genre: "Post-Rock", animation: "Swelling" },
  { n: 38, genre: "Acid Jazz", animation: "Fluid-Slide" },
  { n: 39, genre: "Grunge", animation: "Distorted-Jitter" },
  { n: 40, genre: "Mathematical Rock", animation: "Syncopated-Stop" },
  { n: 41, genre: "Emo", animation: "Slow-Fading" },
  { n: 42, genre: "Flamenco", animation: "Sharp-Clapping" },
  { n: 43, genre: "Bossa Nova", animation: "Gentle-Rolling" },
  { n: 44, genre: "Dark Ambient", animation: "Shadow-Blur" },
  { n: 45, genre: "Future Bass", animation: "Morph-Popping" },
  { n: 46, genre: "New Wave", animation: "Angular-Slide" },
  { n: 47, genre: "Celtic", animation: "Whimsical-Fading" },
  { n: 48, genre: "Cyberpunk", animation: "Matrix-Flicker" },
  { n: 49, genre: "Opera", animation: "Sweeping-Scale" },
  { n: 50, genre: "Ska Punk", animation: "Jump-Bouncy" },
];

const ANIM_BY_GENRE = new Map(GENRES.map((g) => [g.genre, g.animation]));
const DEFAULT_GENRE = "Pop";

// Fold a raw tag into a stable match space: lowercase, strip accents, unify all
// separators (hyphen/underscore/slash) to spaces, drop stray punctuation but
// KEEP & (for "r&b"), collapse whitespace. "Lo-Fi" -> "lo fi",
// "Hip-Hop / Rap" -> "hip hop rap", "R&B" -> "r&b".
function normalizeTag(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/[‐-―\-_/]+/g, " ")
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Non-genre noise: moods, eras, listening contexts, meta tags. Dropped before
// matching so the next ranked tag gets a chance. Exact-match (post-normalize) or
// a decade/year shape.
const STOPLIST = new Set([
  "seen live", "favorite", "favorites", "favourite", "favourites", "spotify",
  "beautiful", "awesome", "love", "loved", "amazing", "good", "cool", "great",
  "best", "epic", "masterpiece", "catchy", "fun", "vibes", "vibe", "mood",
  "sad", "happy", "party", "summer", "winter", "driving", "workout", "gym",
  "study", "studying", "relax", "relaxing", "sleep", "focus", "chill",
  "instrumental", "male vocalists", "female vocalists", "male vocalist",
  "female vocalist", "vocal", "vocalist", "oldies", "old", "new", "classic",
  "underground", "mainstream", "guitar", "piano", "covers", "cover", "remix",
  "live", "albums i own", "heard on pandora", "favorite songs", "my music",
]);

function isNoise(nt) {
  if (!nt) return true;
  if (STOPLIST.has(nt)) return true;
  if (/^(?:19|20)\d{2}$/.test(nt)) return true; // a bare year, e.g. "1999"
  if (/^\d{1,4}s$/.test(nt)) return true; // a decade, e.g. "00s" / "1980s"
  return false;
}

// Ordered alias rules — MOST SPECIFIC genres FIRST so compound tags resolve to
// the precise genre before a generic substring can claim them ("post rock"
// before "rock", "dark ambient" before "ambient", "ska punk" before both "ska"
// and "punk", "acid jazz" before "jazz", "dubstep" before "dub"/"reggae").
// Patterns are written already-normalized and matched as substrings.
const RULES = [
  { genre: "Ska Punk", patterns: ["ska punk", "skacore", "ska core"] },
  { genre: "Mathematical Rock", patterns: ["math rock", "mathrock", "mathcore", "math pop"] },
  { genre: "Post-Rock", patterns: ["post rock", "postrock", "post metal"] },
  { genre: "Acid Jazz", patterns: ["acid jazz", "nu jazz", "jazz funk", "jazz fusion"] },
  { genre: "Dark Ambient", patterns: ["dark ambient", "ritual ambient", "dungeon synth", "drone ambient"] },
  { genre: "Future Bass", patterns: ["future bass", "kawaii bass", "melodic dubstep", "future funk"] },
  { genre: "Dubstep", patterns: ["dubstep", "brostep", "riddim"] },
  { genre: "Hyperpop", patterns: ["hyperpop", "hyper pop", "glitchcore", "pc music", "bubblegum bass", "digicore"] },
  { genre: "Vaporwave", patterns: ["vaporwave", "vapor", "mallsoft", "slushwave"] },
  { genre: "Cyberpunk", patterns: ["cyberpunk", "cyber punk", "darksynth", "cyber"] },
  { genre: "Synthwave", patterns: ["synthwave", "retrowave", "outrun", "retro wave", "chillwave", "synth pop", "synthpop"] },
  { genre: "Phonk", patterns: ["phonk", "drift phonk"] },
  { genre: "Grime", patterns: ["grime", "uk drill", "drill"] },
  { genre: "Trap", patterns: ["trap", "cloud rap", "phonk trap"] },
  { genre: "Shoegaze", patterns: ["shoegaze", "shoegazing", "nugaze", "blackgaze", "dream pop", "dreampop"] },
  { genre: "Grunge", patterns: ["grunge", "post grunge"] },
  { genre: "Emo", patterns: ["emo", "emocore", "screamo", "midwest emo", "emo rap"] },
  { genre: "New Wave", patterns: ["new wave", "post punk", "postpunk", "darkwave", "coldwave", "minimal wave", "no wave"] },
  { genre: "Punk", patterns: ["punk", "hardcore punk", "pop punk", "skate punk", "punk rock", "crust", "oi"] },
  { genre: "Metal", patterns: ["metal", "thrash", "metalcore", "deathcore", "djent", "doom", "grindcore", "sludge", "black metal", "death metal", "power metal", "nu metal"] },
  { genre: "Industrial", patterns: ["industrial", "ebm", "aggrotech", "power noise", "noise", "rhythmic noise"] },
  { genre: "Chiptune / 8-Bit", patterns: ["chiptune", "chip tune", "8 bit", "8bit", "bitpop", "video game", "vgm", "nintendocore"] },
  { genre: "Lo-Fi", patterns: ["lo fi", "lofi", "chillhop", "chill hop", "jazzhop", "jazz hop", "downtempo", "trip hop", "triphop", "boom bap lofi"] },
  { genre: "Ambient", patterns: ["ambient", "drone", "new age", "atmospheric", "soundscape"] },
  { genre: "House", patterns: ["house", "deep house", "tech house", "progressive house", "electro house", "acid house", "future house", "garage house"] },
  { genre: "Techno", patterns: ["techno", "minimal techno", "detroit techno", "acid techno", "hardtechno"] },
  { genre: "Disco", patterns: ["disco", "nu disco", "euro disco", "boogie", "italo disco"] },
  { genre: "Afrobeats", patterns: ["afrobeat", "afrobeats", "afropop", "afro pop", "amapiano", "afro house", "highlife", "afroswing", "afro"] },
  // Latin BEFORE Reggae: "reggaeton" contains the substring "reggae", so the
  // Reggae rule would otherwise steal it.
  { genre: "Latin / Reggaeton", patterns: ["reggaeton", "latin", "salsa", "bachata", "cumbia", "merengue", "dembow", "perreo", "banda", "ranchera", "latin trap", "latin pop"] },
  { genre: "Reggae", patterns: ["reggae", "dancehall", "roots reggae", "rocksteady", "ragga", "dub"] },
  { genre: "Bluegrass", patterns: ["bluegrass", "newgrass", "old time", "appalachian"] },
  { genre: "Country", patterns: ["country", "outlaw country", "honky tonk", "americana", "alt country", "nashville"] },
  { genre: "Celtic", patterns: ["celtic", "irish", "gaelic", "scottish", "folk metal"] },
  { genre: "Flamenco", patterns: ["flamenco", "spanish guitar", "rumba flamenca"] },
  { genre: "Bossa Nova", patterns: ["bossa nova", "bossa", "mpb", "samba"] },
  { genre: "K-Pop / J-Pop", patterns: ["k pop", "kpop", "j pop", "jpop", "mandopop", "c pop", "cpop", "city pop", "anime", "j rock"] },
  { genre: "Opera", patterns: ["opera", "operatic", "aria", "bel canto"] },
  { genre: "Orchestral Film", patterns: ["orchestral", "soundtrack", "film score", "score", "cinematic", "epic music", "trailer music", "ost"] },
  { genre: "Classical", patterns: ["classical", "baroque", "romantic era", "symphony", "concerto", "chamber music", "renaissance"] },
  { genre: "Gospel", patterns: ["gospel", "christian", "worship", "spiritual", "ccm", "praise"] },
  { genre: "Acid Jazz", patterns: ["acid jazz"] },
  { genre: "Jazz", patterns: ["jazz", "bebop", "swing", "big band", "smooth jazz", "cool jazz", "hard bop", "dixieland"] },
  { genre: "Blues", patterns: ["blues", "delta blues", "chicago blues", "blues rock"] },
  { genre: "R&B", patterns: ["r&b", "rnb", "r and b", "rhythm and blues", "contemporary r&b"] },
  { genre: "Soul / Funk", patterns: ["soul", "funk", "motown", "neo soul", "funk rock", "g funk", "northern soul"] },
  { genre: "Future Bass", patterns: ["future bass"] },
  { genre: "Electronic / EDM", patterns: ["electronic", "electronica", "edm", "electro", "idm", "drum and bass", "drum n bass", "dnb", "d&b", "jungle", "trance", "psytrance", "breakbeat", "glitch", "dance", "big room", "synth"] },
  { genre: "Hip-Hop / Rap", patterns: ["hip hop", "hiphop", "rap", "boom bap", "gangsta rap", "conscious", "underground hip hop"] },
  { genre: "Indie / Folk", patterns: ["folk", "indie", "singer songwriter", "acoustic", "folk rock", "freak folk", "indie pop", "indie rock"] },
  { genre: "Rock", patterns: ["rock", "classic rock", "hard rock", "alt rock", "alternative", "rockabilly", "garage rock", "psychedelic"] },
  { genre: "Pop", patterns: ["pop", "dance pop", "electropop", "power pop", "art pop", "teen pop", "pop rock", "synthpop"] },
];

function matchTag(nt) {
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (nt.includes(p)) return rule.genre;
    }
  }
  return null;
}

// Map a RANKED tag list (most-popular first) to a canonical genre. First tag
// (after noise removal) that matches any alias rule wins; else the DeBERTa seam;
// else the default. Always returns { genre, animation, source, matched }.
function classifyTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (const raw of list) {
    const nt = normalizeTag(raw);
    if (isNoise(nt)) continue;
    const genre = matchTag(nt);
    if (genre) {
      return { genre, animation: ANIM_BY_GENRE.get(genre), source: "alias", matched: raw };
    }
  }
  // SEAM: on-device DeBERTa-v3-XSmall zero-shot fallback (not yet implemented).
  const ml = classifyUnmatched(list);
  if (ml && ANIM_BY_GENRE.has(ml)) {
    return { genre: ml, animation: ANIM_BY_GENRE.get(ml), source: "deberta", matched: null };
  }
  return { genre: DEFAULT_GENRE, animation: ANIM_BY_GENRE.get(DEFAULT_GENRE), source: "fallback", matched: null };
}

/* ── DeBERTa-v3-XSmall SEAM ───────────────────────────────────────────────
 * Later: load a quantized onnxruntime-node model + tokenizer ONCE, run zero-shot
 * NLI ("this music is {label}") over the 50 canonical labels for tags the alias
 * map missed, and return the argmax canonical genre. Returns null today so the
 * caller falls back to DEFAULT_GENRE. Keep this signature stable. */
function classifyUnmatched(_tags) {
  return null;
}

module.exports = {
  GENRES,
  DEFAULT_GENRE,
  normalizeTag,
  isNoise,
  classifyTags,
  classifyUnmatched,
};
