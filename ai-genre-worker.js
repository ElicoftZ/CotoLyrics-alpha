/* ═══════════════════════════════════════════════════════════════════════
 *  AI GENRE WORKER  (on-device lyrics → genre, DeBERTa-v3-XSmall zero-shot)
 *
 *  A module Web Worker that the renderer spins up ONLY when the "On-device AI"
 *  Settings toggle is ON. It zero-shot-classifies a track's iTunes/Last.fm GENRE
 *  TAGS against the 50 canonical genres and posts back a {genre: probability} map;
 *  the renderer COMBINES that with the alias-matched tag genre to pick the final
 *  animation. (Tags, not lyrics: the premise is a few words, so the 50 passes are
 *  fast — and it's the original genre-map seam, resolving tags the alias map missed.)
 *
 *  Model: Xenova/nli-deberta-v3-xsmall — a DeBERTa-v3-XSmall NLI checkpoint
 *  exported to ONNX for transformers.js. Genre is framed as natural-language
 *  inference: premise = the tag string, hypothesis = "This song is {genre} music.";
 *  the entailment probability per label is the genre score.
 *
 *  FULLY ON-DEVICE / OFFLINE — nothing is fetched at runtime. All three pieces
 *  ship inside the app and are served over the app:// scheme:
 *    • library    node_modules/@huggingface/transformers/dist/transformers.min.js
 *    • runtime    node_modules/onnxruntime-web/dist/  (ORT WASM, via wasmPaths)
 *    • model      models/Xenova/nli-deberta-v3-xsmall/ (quantized ONNX + tokenizer)
 *  (All are listed in package.json build.files so electron-builder bundles them.)
 * ═══════════════════════════════════════════════════════════════════════ */
import { pipeline, env } from "/node_modules/@huggingface/transformers/dist/transformers.min.js";

// Hard-offline: load the model only from the bundled models/ folder, and the ORT
// WASM only from the bundled onnxruntime-web dist — never the HF Hub or a CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/"; // -> app://bundle/models/<id>/...
env.backends.onnx.wasm.wasmPaths = "/node_modules/onnxruntime-web/dist/";
env.backends.onnx.wasm.numThreads = 1; // single-thread: no SharedArrayBuffer / cross-origin isolation needed

const MODEL_ID = "Xenova/nli-deberta-v3-xsmall"; // DeBERTa-v3-XSmall NLI (ONNX)
const HYPOTHESIS = "This song is {} music.";
const MAX_CHARS = 200; // tag strings are short; a small cap keeps each NLI pass fast

let pipePromise = null; // lazy, built once on the first classify
function getClassifier() {
  if (!pipePromise) {
    post({ type: "status", state: "loading" });
    pipePromise = pipeline("zero-shot-classification", MODEL_ID, { dtype: "q8" })
      .then((p) => { post({ type: "status", state: "ready" }); return p; })
      .catch((e) => { pipePromise = null; throw e; }); // allow a retry on a later message
  }
  return pipePromise;
}

function post(msg) { self.postMessage(msg); }

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "classify") return;
  const { key, text, labels } = msg;
  try {
    const premise = String(text || "").slice(0, MAX_CHARS).trim();
    if (!premise || !Array.isArray(labels) || !labels.length) {
      post({ type: "result", key, scores: null, error: "empty input" });
      return;
    }
    const classify = await getClassifier();
    // multi_label: independent per-genre probability (sigmoid), so the renderer
    // can add a tag-confidence prior to one label without renormalizing.
    const out = await classify(premise, labels, { hypothesis_template: HYPOTHESIS, multi_label: true });
    const scores = {};
    for (let i = 0; i < out.labels.length; i++) scores[out.labels[i]] = out.scores[i];
    post({ type: "result", key, scores });
  } catch (e) {
    post({ type: "result", key, scores: null, error: String((e && e.message) || e) });
  }
};
