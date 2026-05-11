import { createHash } from "node:crypto";

// ── Local Embedding Generator ────────────────────────────────────────
// Zero-dependency local embedding using character n-gram hashing with
// random projection. This produces consistent 768-dimensional vectors
// from text without requiring any external API or model download.
//
// Algorithm:
//  1. Tokenize text into character-level n-grams (3-grams and 4-grams)
//  2. Hash each n-gram to produce a deterministic feature index
//  3. Build a sparse TF vector from the hashed features
//  4. Apply a deterministic random projection to reduce to 768 dims
//  5. L2-normalize the output vector
//
// This captures character-level patterns (subword similarity, morphology)
// which gives reasonable semantic similarity for short-to-medium text.
// Not as good as neural embeddings but works fully offline and is fast.

const EMBEDDING_DIM = 768;
const HASH_SPACE = 4096; // Intermediate feature space before projection
const NGRAM_SIZES = [3, 4]; // Character n-gram sizes

// Deterministic projection matrix: maps HASH_SPACE → EMBEDDING_DIM
// Generated once from a fixed seed to ensure consistent embeddings.
let projectionMatrix: Float32Array[] | null = null;

function getProjectionMatrix(): Float32Array[] {
  if (projectionMatrix) return projectionMatrix;

  projectionMatrix = [];
  const seed = createHash("sha256").update("astra-local-embed-v1").digest();

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const row = new Float32Array(HASH_SPACE);
    for (let j = 0; j < HASH_SPACE; j++) {
      // Deterministic pseudo-random: hash(seed + i + j)
      const h = createHash("md5")
        .update(Buffer.concat([seed, Buffer.from(`${i}:${j}`)]))
        .digest();
      // Convert first 4 bytes to float in [-1, 1]
      const val = (h.readUInt32LE(0) / 0xffffffff) * 2 - 1;
      // Scale by 1/sqrt(HASH_SPACE) for Johnson-Lindenstrauss
      row[j] = val / Math.sqrt(HASH_SPACE);
    }
    projectionMatrix.push(row);
  }

  return projectionMatrix;
}

// Extract character n-grams from text
function extractNgrams(text: string): string[] {
  const normalized = text.toLowerCase().trim();
  const ngrams: string[] = [];

  // Add word-level unigrams for better keyword matching
  const words = normalized.split(/\s+/).filter((w) => w.length > 2);
  ngrams.push(...words);

  // Character n-grams
  for (const n of NGRAM_SIZES) {
    for (let i = 0; i <= normalized.length - n; i++) {
      ngrams.push(normalized.slice(i, i + n));
    }
  }

  return ngrams;
}

// Hash an n-gram to a feature index
function hashNgram(ngram: string): number {
  const h = createHash("md5").update(ngram).digest();
  return h.readUInt32LE(0) % HASH_SPACE;
}

// Build sparse TF vector from n-grams
function buildFeatureVector(ngrams: string[]): Float32Array {
  const vec = new Float32Array(HASH_SPACE);

  for (const ngram of ngrams) {
    const idx = hashNgram(ngram);
    vec[idx] += 1;
  }

  // Apply sublinear TF (log(1 + count)) to dampen frequent features
  for (let i = 0; i < HASH_SPACE; i++) {
    if (vec[i] > 0) {
      vec[i] = Math.log1p(vec[i]);
    }
  }

  return vec;
}

// Project feature vector to embedding dimension
function project(features: Float32Array): number[] {
  const matrix = getProjectionMatrix();
  const output = new Array<number>(EMBEDDING_DIM);

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    let sum = 0;
    const row = matrix[i]!;
    for (let j = 0; j < HASH_SPACE; j++) {
      sum += row[j]! * features[j]!;
    }
    output[i] = sum;
  }

  return output;
}

// L2 normalize
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);

  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ── Public API ──────────────────────────────────────────────────────

export function generateLocalEmbedding(text: string): number[] {
  const ngrams = extractNgrams(text);
  const features = buildFeatureVector(ngrams);
  const projected = project(features);
  return l2Normalize(projected);
}

export function generateLocalEmbeddings(texts: string[]): number[][] {
  return texts.map(generateLocalEmbedding);
}
