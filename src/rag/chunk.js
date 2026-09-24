// Pure text chunking for RAG: no network, safe to test with plain strings.

// A sentence ends at . ! or ? (plus any closing quotes/brackets), or at end of text.
const SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;

function splitSentences(text) {
  return (text.match(SENTENCE_PATTERN) ?? []).map((s) => s.trim()).filter(Boolean);
}

// Fallback for a single "sentence" longer than maxChars: split on words, and
// split any single word that is itself too long.
function hardSplit(sentence, maxChars) {
  const pieces = [];
  let current = "";

  for (const word of sentence.split(" ")) {
    if (word.length > maxChars) {
      if (current) pieces.push(current);
      for (let i = 0; i < word.length; i += maxChars) {
        pieces.push(word.slice(i, i + maxChars));
      }
      current = "";
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      pieces.push(current);
      current = word;
    }
  }

  if (current) pieces.push(current);
  return pieces;
}

// The last ~overlapChars of a chunk, starting on a word boundary.
function overlapTail(chunk, overlapChars) {
  if (overlapChars <= 0) return "";
  if (chunk.length <= overlapChars) return chunk;

  const tail = chunk.slice(-overlapChars);
  if (chunk[chunk.length - overlapChars - 1] === " ") return tail;

  const firstSpace = tail.indexOf(" ");
  return firstSpace === -1 ? "" : tail.slice(firstSpace + 1);
}

/**
 * Split text on sentence boundaries into chunks of at most maxChars, carrying
 * roughly overlapChars of the previous chunk forward so context that spans a
 * chunk boundary isn't lost.
 */
export function chunkText(text, { maxChars = 800, overlapChars = 100 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer.");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be a non-negative integer smaller than maxChars.");
  }

  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const pieces = splitSentences(clean).flatMap((sentence) =>
    sentence.length > maxChars ? hardSplit(sentence, maxChars) : [sentence],
  );

  const chunks = [];
  let current = "";

  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    const overlap = overlapTail(current, overlapChars);
    // Drop the overlap rather than exceed maxChars.
    current = overlap && overlap.length + 1 + piece.length <= maxChars ? `${overlap} ${piece}` : piece;
  }

  if (current) chunks.push(current);
  return chunks;
}
