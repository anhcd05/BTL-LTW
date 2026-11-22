import { createHash } from 'node:crypto';
import { hash32 } from './rng';

export const E5_MODEL = 'Xenova/multilingual-e5-small';
/** Pinned Hugging Face revision (commit of the Xenova repo, 2025-07-22). */
export const E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
/** q8 → onnx/model_quantized.onnx. Override with RECO_MODEL_DTYPE (e.g. fp32 → onnx/model.onnx). */
export const E5_DTYPE = process.env.RECO_MODEL_DTYPE || 'q8';
export const MAX_TOKENS = 256;
export const BATCH_SIZE = 16;
export const LYRIC_LINES = 4;

export function e5ModelId(): string {
  return `${E5_MODEL}@${E5_REVISION.slice(0, 12)}:${E5_DTYPE}`;
}

export type EmbedInput = { title: string; description: string; lyrics: string[] };

/**
 * Passage text: `passage: ${title}. ${description}. ${first lyric lines}`. Genre names are deliberately
 * NOT included: genre is already a structured feature (genre_overlap / survey_match), and putting it in
 * the text would make content similarity a second copy of the genre signal.
 */
export function passageText(t: EmbedInput): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lyrics = t.lyrics.map(clean).filter(Boolean).slice(0, LYRIC_LINES).join(' / ');
  return `passage: ${clean(t.title)}. ${clean(t.description)}. ${lyrics}`;
}

/** content_hash = sha256(model id + "\n" + text) — changes when either the text or the model changes. */
export function contentHash(text: string, modelId: string): string {
  return createHash('sha256').update(`${modelId}\n${text}`, 'utf8').digest('hex');
}

export type Embedder = { modelId: string; dims: number; kind: 'e5' | 'hash'; embed(texts: string[]): Promise<Float32Array[]> };

/**
 * Fallback ONLY for offline evaluation when the e5 weights are unavailable: signed feature hashing
 * of word unigrams/bigrams, L2-normalised. Reports label it explicitly; never written to the DB.
 */
export function hashEmbedder(dims = 256): Embedder {
  const embedOne = (text: string): Float32Array => {
    const v = new Float32Array(dims);
    const words = text
      .replace(/^passage:\s*/, '')
      .toLocaleLowerCase('vi-VN')
      .split(/[^\p{L}\p{N}-]+/u)
      .filter(Boolean)
      .slice(0, MAX_TOKENS);
    const grams = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
    for (const g of grams) {
      const h = hash32(g);
      v[h % dims] += h & 0x80000000 ? -1 : 1;
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i += 1) v[i] /= n;
    return v;
  };
  return { modelId: `hash-bow-${dims}`, dims, kind: 'hash', embed: async (texts) => texts.map(embedOne) };
}
