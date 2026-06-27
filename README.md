# CotoLyrics

A passive, Cotodama-style desktop **lyric speaker**. It quietly watches whatever
music is playing on your PC, pulls the time-synced lyrics, and renders them as
**word-by-word kinetic typography** in Three.js — with the motion intensity locked
to the song's tempo.

No browser extension, no manual song entry, no login. Press play in your music
app and CotoLyrics does the rest.

![CotoLyrics rendering live synced lyrics as kinetic typography](docs/screenshot.png)

> *Live capture — "HAI YOROKONDE (English Ver)" by Kocchi no Kento, mid-line word reveal.*

- **Auto-detects now-playing music** via Windows **SMTC** (System Media Transport
  Controls) — works with Spotify, Apple Music, and any browser/app that reports
  media info to Windows.
- **Synced lyrics** from [LRCLIB](https://lrclib.net) (with a NetEase fallback).
- **Beat-aware animation:** the tempo is resolved per track and locked to one of
  three motion profiles (calm → groovy → intense).
- **Live audio analysis** of system loopback drives the beat/energy reactions.
- **Genre-aware letter animation** — genre detected keyless via iTunes (optional Last.fm),
  optionally sharpened by an **on-device AI** model.
- **Apple Music–style lyrics mode** (optional) — a clean white scrolling karaoke view
  with smooth spring-scroll, depth-of-field blur, and a soft glow on the line you're reading.

---

## What's new in 0.40.0

- **On-device AI genre detection.** A bundled **DeBERTa-v3-XSmall** zero-shot model
  classifies the track's genre tags and combines with the iTunes/Last.fm result for a
  higher-accuracy pick. Runs **fully offline** — the model ships inside the app, nothing
  is fetched at runtime. Toggle it on under **Settings → On-device AI**.
- **Apple Music lyrics polish.** The optional scrolling lyrics view now has a
  GPU-smooth spring-scroll, a depth-of-field blur (lines blur toward the top/bottom,
  sharpen at center), and a soft reading glow on the centered line.
- **Installer + portable builds.** `npm run build` now produces both a Windows
  **installer** (`CotoLyrics-0.40.0-setup.exe`) and a **portable** single-exe.

---

## Requirements

- **Windows 10/11** — detection relies on Windows SMTC, so this is Windows-only.
- **[Node.js](https://nodejs.org) 18 or newer** (includes `npm`).
- A music app that reports to Windows "now playing" (Spotify desktop, Apple Music,
  Edge/Chrome playing YouTube, etc.).

## Install & run

```bash
git clone https://github.com/ElicoftZ/CotoLyrics-alpha.git
cd CotoLyrics-alpha
npm install
npm start
```

That's it. A white window titled **CotoLyrics** opens and shows
*"Listening…"* until you start playing music.

## How to use

1. Launch the app with `npm start`.
2. **Play a song** in Spotify / Apple Music / your browser.
3. CotoLyrics detects the track, fetches its synced lyrics, and animates them
   line by line, word by word, in time with the vocal.
4. Switch tracks freely — it re-detects and re-syncs automatically.

If a song has **no synced lyrics** available, the screen stays on the instrumental
visualizer instead of showing text.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `[` | Nudge lyrics **earlier** by 25 ms (if they're running late) |
| `]` | Nudge lyrics **later** by 25 ms (if they're running early) |
| `R` | Re-fetch lyrics for the current track |

The lyric offset is shown briefly in the status bar each time you adjust it.

### Settings (⚙ bottom-right)

| Toggle | What it does |
|--------|--------------|
| **Apple Music Lyrics** | Switch from the Three.js kinetic canvas to a white, vertically-scrolling karaoke view (depth-of-field blur + reading glow). |
| **On-device AI** | Enable the bundled DeBERTa-v3-XSmall model to refine genre detection (combined with the iTunes/Last.fm tags). Off = tags only. Runs locally, offline. |
| **Upload font…** | Use your own `.ttf`/`.otf` for the lyrics typography. |

Both toggles are remembered between launches.

## Motion tiers (BPM → animation)

The detected tempo picks the animation profile for the whole track:

| Tempo | Profile | Feel |
|-------|---------|------|
| **< 100 BPM** | Calm | Gentle fluid drift, slow fades |
| **100–140 BPM** | Groovy | Rhythmic scaling, smooth camera sweeps |
| **> 140 BPM** | Intense | Aggressive entrances, shaking, chaotic vibration |

## Configuration

All knobs live at the top of [`main.js`](main.js) (backend tempo lookup) and inside
[`index.html`](index.html) (renderer). You don't need any of these to use the app —
they're for tuning.

### Pin a song's BPM (instant, offline)

Add an entry to `BPM_DICTIONARY` in [`main.js`](main.js) so a track locks its tempo
instantly with zero network calls:

```js
const BPM_DICTIONARY = {
  "your song title|artist name": 128,
};
```

Keys are lowercase `title|artist`; the app sanitizes incoming metadata (strips
`(Remix)`, `- Remastered`, etc.) before matching.

For songs not in your dictionary, the app estimates tempo live from the system audio
(the `dspBpm` onset estimator) and learns it back into the local cache, so the next
play is an instant offline hit. No API key or network lookup is involved.

### Genre detection & per-letter animation

Each track's genre drives a letter-by-letter appear/disappear animation. Genre is
detected **keyless by default** via Apple's iTunes Search API (`primaryGenreName`), so
it works out of the box with no setup. Optionally, set a free
[Last.fm](https://www.last.fm/api/account/create) API key for richer subgenre tags:

```bash
# .env (gitignored — never commit). OPTIONAL — leave empty to use iTunes only.
LASTFM_API_KEY=your_api_key_here
```

When a Last.fm key is present it is tried first (more granular subgenres); otherwise the
app falls back to the keyless iTunes lookup.

#### On-device AI refinement (optional)

Turn on **Settings → On-device AI** to add a bundled **DeBERTa-v3-XSmall** zero-shot
classifier. It reads the track's genre **tags** (not the lyrics — short input keeps it
fast) and maps them onto one of the 50 canonical genres, then **combines** with the
alias-matched tag genre using a confidence-weighted prior. When the tag lookup is
confident the AI mostly reinforces it; when the tags are weak or unmatched, the AI
decides. This is the on-device fill-in for the original `genre-map.js` classifier seam.

Everything runs **locally and offline** — the quantized model, tokenizer, and ONNX
runtime are bundled under [`models/`](models/) and `onnxruntime-web` and served to a
Web Worker over the `app://` scheme. Nothing is downloaded at runtime.

### Hand-authored lyric timing (optional)

For perfect, vocal-matched timing on a specific track, add an entry to
`LOCAL_LYRICS` in [`index.html`](index.html) — each word gets its own absolute
timestamp (seconds):

```js
const LOCAL_LYRICS = {
  "your song title|artist name": {
    lines: [
      { words: [{ text: "First", time: 0.0 }, { text: "word", time: 0.65 }] },
    ],
  },
};
```

When present, this overrides the online lyric fetch for that track.

## Building a standalone app

```bash
npm run build           # installer + portable (dist/)
# or
npm run dist:portable   # portable single .exe only
```

`npm run build` produces both Windows targets in `dist/`:

| File | Type |
|------|------|
| `CotoLyrics-0.40.0-setup.exe` | Installer (pick folder, desktop + Start-menu shortcuts) |
| `CotoLyrics-0.40.0-portable.exe` | Portable — run anywhere, no install |

> The build bundles the on-device AI model + ONNX runtime, so the artifacts are
> ~225 MB. They run fully offline.

## How it works

- **`main.js`** — Electron main process. Serves the renderer over a custom `app://`
  scheme, spawns the SMTC bridge, runs the BPM waterfall (dictionary → SQLite cache →
  live estimate), resolves the genre (iTunes/Last.fm), and grants system-audio loopback.
- **`smtc-bridge.ps1`** — reads Windows "now playing" via WinRT and streams it to
  the app as JSON.
- **`preload.js`** — the secure IPC bridge between main and renderer.
- **`index.html`** — the Three.js renderer: glyph layout, the word-level timeline
  reveal engine, the BPM-locked motion profiles, the live audio DSP, and the optional
  Apple Music scrolling-lyrics mode (spring-scroll + depth-of-field blur + reading glow).
- **`genre-map.js`** — collapses provider tags into one of the 50 canonical genres.
- **`ai-genre-worker.js`** — the on-device DeBERTa-v3-XSmall zero-shot genre worker.
- **`mood-engine.js`** — maps lyric/audio mood to motion parameters.

## Troubleshooting

- **Stuck on "Listening…"** — make sure music is actually playing and your player
  shows up in the Windows volume/media flyout. Browser tabs must be actively
  playing audio to register with SMTC.
- **Lyrics out of sync** — nudge with `[` / `]`. Different players report their
  playback position with different lag.
- **No lyrics appear** — that track may not have synced lyrics on LRCLIB; the
  instrumental visualizer runs instead.

## License

[GNU GPL v3.0 or later](LICENSE) — see the [`LICENSE`](LICENSE) file for the full text.
