import { shopifyGraphQL } from "../shopify.js";
import { chunkText } from "./chunk.js";
import { embedTexts } from "./embed.js";
import { topKMatches } from "./similarity.js";

const CHUNK_OPTIONS = { maxChars: 800, overlapChars: 120 };
const TOP_K = 3;
// Below this cosine score a chunk is treated as unrelated to the question.
const DEFAULT_MIN_SCORE = 0.45;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    // Block-level boundaries become sentence breaks so headings don't merge into the next line.
    .replace(/<\/(p|div|h[1-6]|li|tr|section)>|<br\s*\/?>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
      if (code[0] === "#") {
        const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return String.fromCodePoint(value);
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .replace(/([!?:])\s*\.\s/g, "$1 ")
    .trim();
}

/** Fetch the store's policy pages and product descriptions as { id, title, text } documents. */
export async function loadStoreDocuments() {
  const data = await shopifyGraphQL(`
    {
      shop { shopPolicies { type title body } }
      products(first: 100) { nodes { id title description } }
    }
  `);

  const policies = data.shop.shopPolicies
    .map((policy) => ({ id: `policy:${policy.type}`, title: policy.title, text: htmlToText(policy.body) }))
    .filter((doc) => doc.text);

  const products = data.products.nodes
    .filter((product) => product.description.trim())
    .map((product) => ({
      id: `product:${product.id.split("/").pop()}`,
      title: `Product: ${product.title}`,
      text: `${product.title}. ${product.description}`,
    }));

  return [...policies, ...products];
}

/** Chunk every document and embed each chunk once: returns [{ id, vector, text, title }]. */
export async function buildPolicyIndex(documents, { embed = embedTexts, chunkOptions = CHUNK_OPTIONS } = {}) {
  const chunks = documents.flatMap((doc) =>
    chunkText(doc.text, chunkOptions).map((text, i) => ({ id: `${doc.id}#${i}`, title: doc.title, text })),
  );
  if (chunks.length === 0) return [];

  const vectors = await embed(
    chunks.map((chunk) => chunk.text),
    { inputType: "document" },
  );
  return chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }));
}

/**
 * Embed the question with the same embed function and return the top matching
 * chunks that clear minScore. `found: false` means nothing relevant was indexed.
 */
export async function searchIndex(question, entries, { embed = embedTexts, k = TOP_K, minScore = DEFAULT_MIN_SCORE } = {}) {
  if (entries.length === 0) {
    return { found: false, message: "No store policy or product content is indexed." };
  }

  const [queryVector] = await embed([question], { inputType: "query" });
  const matches = topKMatches(queryVector, entries, k);
  const relevant = matches.filter((match) => match.score >= minScore);

  if (relevant.length === 0) {
    return {
      found: false,
      bestScore: Number((matches[0]?.score ?? 0).toFixed(3)),
      message: "No store policy content matched this question closely enough. Do not guess an answer.",
    };
  }

  return {
    found: true,
    matches: relevant.map(({ id, title, text, score }) => ({ id, source: title, score: Number(score.toFixed(3)), text })),
  };
}

// ---------------------------------------------------------------------------
// Live index, built once at startup.
// ---------------------------------------------------------------------------

let indexPromise = null;

export function startPolicyIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const documents = await loadStoreDocuments();
      const entries = await buildPolicyIndex(documents);
      console.error(`Policy index ready: ${entries.length} chunks from ${documents.length} documents.`);
      return entries;
    })();

    indexPromise.catch((error) => {
      console.error(`Policy index failed to build: ${error.message}`);
      // Allow the next search to retry instead of failing forever.
      indexPromise = null;
    });
  }
  return indexPromise;
}

export async function searchStorePolicies(question) {
  const entries = await startPolicyIndex();
  const minScore = Number(process.env.RAG_MIN_SCORE) || DEFAULT_MIN_SCORE;
  return searchIndex(question, entries, { minScore });
}
