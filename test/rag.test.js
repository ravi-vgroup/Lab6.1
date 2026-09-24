import test from "node:test";
import assert from "node:assert/strict";

import { chunkText } from "../src/rag/chunk.js";
import { cosineSimilarity, topKMatches } from "../src/rag/similarity.js";
import { buildPolicyIndex, htmlToText, searchIndex } from "../src/rag/policyIndex.js";

// ============================================================
// chunkText — pure, no network
// ============================================================

const SENTENCES = [
  "Orders can be returned within 30 days of delivery.",
  "Items must be unused and in their original packaging.",
  "Refunds are issued to the original payment method within 5 business days.",
  "Shipping costs are non-refundable unless the item arrived damaged.",
  "Sale items and gift cards cannot be returned.",
  "To start a return, contact support with your order number.",
];
const LONG_DOCUMENT = Array.from({ length: 10 }, () => SENTENCES.join(" ")).join(" ");

test("long document splits into multiple chunks, none exceeding maxChars", () => {
  const maxChars = 300;
  const chunks = chunkText(LONG_DOCUMENT, { maxChars, overlapChars: 60 });

  assert.ok(LONG_DOCUMENT.length > maxChars * 5);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= maxChars, `chunk of ${chunk.length} chars exceeds ${maxChars}`);
  }
});

test("text shorter than maxChars stays as one chunk", () => {
  const text = SENTENCES.slice(0, 2).join(" ");
  assert.deepEqual(chunkText(text, { maxChars: 500, overlapChars: 50 }), [text]);
});

test("chunks break on sentence boundaries", () => {
  const chunks = chunkText(LONG_DOCUMENT, { maxChars: 300, overlapChars: 0 });
  for (const chunk of chunks) {
    assert.match(chunk, /[.!?]$/, `chunk does not end on a sentence: "${chunk.slice(-40)}"`);
  }
});

test("each chunk carries the tail of the previous chunk forward", () => {
  const chunks = chunkText(LONG_DOCUMENT, { maxChars: 300, overlapChars: 60 });
  for (let i = 1; i < chunks.length; i++) {
    const previousWords = chunks[i - 1].split(" ");
    const tail = previousWords.slice(-3).join(" ");
    assert.ok(chunks[i].includes(tail), `chunk ${i} does not start with the tail of chunk ${i - 1}`);
  }
});

test("a single sentence longer than maxChars is still split within the limit", () => {
  const runOn = "word ".repeat(200).trim();
  const chunks = chunkText(runOn, { maxChars: 100, overlapChars: 10 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test("empty text gives no chunks and invalid options throw", () => {
  assert.deepEqual(chunkText("   ", { maxChars: 100, overlapChars: 10 }), []);
  assert.throws(() => chunkText("x", { maxChars: 0 }), /maxChars/);
  assert.throws(() => chunkText("x", { maxChars: 100, overlapChars: 100 }), /overlapChars/);
});

// ============================================================
// cosineSimilarity / topKMatches — synthetic vectors, no embedding call
// ============================================================

test("orthogonal vectors score zero similarity", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([0, 3], [5, 0]), 0);
});

test("same direction scores 1 regardless of magnitude, opposite scores -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 2], [-1, -2]) + 1) < 1e-12);
});

test("zero vector scores 0 and mismatched lengths throw", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length mismatch/);
});

test("exact match ranks first, near match second, unrelated last", () => {
  const query = [1, 1, 0];
  const entries = [
    { id: "unrelated", vector: [0, 0, 1], text: "unrelated" },
    { id: "near", vector: [1, 0.8, 0.1], text: "near" },
    { id: "exact", vector: [3, 3, 0], text: "exact direction" },
  ];

  const ranked = topKMatches(query, entries, 3);
  assert.deepEqual(ranked.map((entry) => entry.id), ["exact", "near", "unrelated"]);
  assert.ok(Math.abs(ranked[0].score - 1) < 1e-12);
  assert.ok(ranked[1].score > ranked[2].score);
  assert.equal(ranked[2].score, 0);
  assert.equal(ranked[0].text, "exact direction");
});

test("topKMatches returns only k entries and does not mutate the input", () => {
  const entries = [
    { id: "a", vector: [1, 0], text: "a" },
    { id: "b", vector: [0, 1], text: "b" },
    { id: "c", vector: [1, 1], text: "c" },
  ];
  const ranked = topKMatches([1, 0], entries, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "a");
  assert.equal(entries[0].score, undefined);
});

// ============================================================
// Index + search wiring — fake embedder, no network
// ============================================================

// Maps text to a 3-d "topic" vector: [returns, shipping, privacy].
function fakeEmbed(texts) {
  return Promise.resolve(
    texts.map((text) => {
      const t = text.toLowerCase();
      return [/return|refund/.test(t) ? 1 : 0, /ship|deliver/.test(t) ? 1 : 0, /privacy|data/.test(t) ? 1 : 0];
    }),
  );
}

const DOCUMENTS = [
  { id: "policy:REFUND_POLICY", title: "Refund policy", text: "Refunds are issued within 5 days of a return." },
  { id: "policy:PRIVACY_POLICY", title: "Privacy policy", text: "We protect your personal data." },
];

test("buildPolicyIndex embeds each chunk once and keeps its text", async () => {
  let calls = 0;
  const entries = await buildPolicyIndex(DOCUMENTS, {
    embed: (texts, opts) => {
      calls++;
      assert.equal(opts.inputType, "document");
      return fakeEmbed(texts);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(entries.map((e) => e.id), ["policy:REFUND_POLICY#0", "policy:PRIVACY_POLICY#0"]);
  assert.ok(entries.every((e) => Array.isArray(e.vector) && e.text));
});

test("searchIndex returns the matching passage for a relevant question", async () => {
  const entries = await buildPolicyIndex(DOCUMENTS, { embed: fakeEmbed });
  const result = await searchIndex("How do refunds work?", entries, { embed: fakeEmbed, minScore: 0.5 });
  assert.equal(result.found, true);
  assert.equal(result.matches[0].source, "Refund policy");
  assert.ok(result.matches.every((m) => m.score >= 0.5));
});

test("searchIndex refuses to answer when nothing clears the threshold", async () => {
  const entries = await buildPolicyIndex(DOCUMENTS, { embed: fakeEmbed });
  const result = await searchIndex("How long does shipping take?", entries, { embed: fakeEmbed, minScore: 0.5 });
  assert.equal(result.found, false);
  assert.equal(result.matches, undefined);
  assert.match(result.message, /Do not guess/);
});

test("htmlToText strips tags and decodes entities", () => {
  assert.equal(htmlToText("<h2>Returns</h2><p>30 days &amp; free&nbsp;shipping</p>"), "Returns. 30 days & free shipping.");
});
