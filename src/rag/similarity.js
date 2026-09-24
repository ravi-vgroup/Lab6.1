// Pure vector math for retrieval: works on any vectors, no embedding call needed.

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // A zero vector has no direction; treat it as unrelated to everything.
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Return the k entries ({ id, vector, text, ... }) most similar to queryVector,
 * highest first, each annotated with its cosine similarity as `score`.
 */
export function topKMatches(queryVector, entries, k = 3) {
  return entries
    .map((entry) => ({ ...entry, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, k));
}
