import "dotenv/config";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 128;
// Voyage accounts without a payment method are limited to 3 requests/minute,
// so wait out a 429 instead of failing the search.
const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(body, apiKey) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status !== 429 || attempt === MAX_ATTEMPTS) {
      return response;
    }

    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delay = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_RETRY_MS * attempt;
    console.error(`Voyage rate limit hit; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`);
    await sleep(delay);
  }
}

/**
 * Embed texts with Voyage AI, returning one vector per input in input order.
 * inputType lets Voyage optimise for "document" (indexed chunks) vs "query"
 * (the incoming question); both land in the same vector space.
 */
export async function embedTexts(texts, { inputType = "document" } = {}) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not set (add it to .env).");
  }
  const model = process.env.VOYAGE_MODEL || "voyage-3.5";

  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const response = await postWithRetry({ input: batch, model, input_type: inputType }, apiKey);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage embeddings request failed (${response.status}): ${body}`);
    }

    const { data } = await response.json();
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`Voyage returned ${data?.length ?? 0} embeddings for ${batch.length} inputs.`);
    }

    data.sort((x, y) => x.index - y.index);
    for (const item of data) {
      vectors.push(item.embedding);
    }
  }

  return vectors;
}
