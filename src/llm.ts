// ESIM — Embedding generation and metadata extraction via any OpenAI-compatible API

import type { ExtractedMetadata, NodeLabel } from "./types.ts";

// ─── Configuration ───────────────────────────────────────────

export function getLlmConfig() {
  return {
    baseUrl: Deno.env.get("LLM_BASE_URL") || "https://api.openai.com/v1",
    apiKey: Deno.env.get("LLM_API_KEY"),
    embeddingModel: Deno.env.get("LLM_EMBEDDING_MODEL") || "text-embedding-3-small",
    embeddingDimensions: parseInt(Deno.env.get("LLM_EMBEDDING_DIMENSIONS") || "1536", 10),
    completionModel: Deno.env.get("LLM_COMPLETION_MODEL") || "gpt-4o-mini",
  };
}

function getApiKey(): string {
  const key = getLlmConfig().apiKey;
  if (!key) throw new Error("Missing LLM_API_KEY");
  return key;
}

// ─── Embedding input limits ──────────────────────────────────

/**
 * Characters of input sent to the embedding model, beyond which text is cut.
 *
 * Long inputs are a real operational failure, not a theoretical one. On
 * 2026-08-06 a local qwen3-embedding:8b runner CRASHED (the server returned
 * `EOF` from the model process, not a clean 4xx) on node content above roughly
 * 9,000 characters of prose, which blocked every write that regenerates an
 * embedding. The threshold drifted between runs with memory pressure, so a cap
 * hugging it is not safe; this default sits well below.
 *
 * The true constraint is TOKENS (~2,300 for that runner), and characters are a
 * proxy: ~3.5-4 chars/token for English prose, less for text dense in
 * punctuation, URLs and snake_case identifiers. 6,000 chars is ~1,700 tokens
 * even on pessimistic tokenization.
 *
 * Override with LLM_EMBEDDING_MAX_CHARS when the configured model has a
 * different practical ceiling (hosted APIs are generally far more generous;
 * OpenAI's text-embedding-3-small accepts ~8,191 tokens and rejects overlong
 * input cleanly rather than dying).
 */
export const DEFAULT_EMBEDDING_MAX_CHARS = 6000;

function embeddingMaxChars(): number {
  const raw = Deno.env.get("LLM_EMBEDDING_MAX_CHARS");
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBEDDING_MAX_CHARS;
}

// ─── Query-side instruction prefix ───────────────────────────

/**
 * Instruction prepended to SEARCH QUERIES (never to stored documents) for
 * instruction-tuned embedding models.
 *
 * Qwen3-Embedding is trained with an asymmetric convention: queries carry a
 * task instruction, documents go in raw. esim sent both raw, and measurement
 * on this graph (17 queries, k=20, qwen3-embedding:8b) showed the cost is
 * concentrated in keyword-style queries rather than spread evenly:
 *
 *   MRR@20     0.808 -> 0.915        top-1  13/17 -> 15/17     missed 1 -> 0
 *   "GAS AppType Inktavo Auth0 Organization Mission Control"   rank  9 -> 1
 *   "Auth0 Printavo authentication spike effort estimate"      rank >20 -> 1
 *   "Which team owns the Airflow and Looker data stack?"       rank  8 -> 19
 *
 * Read that honestly: 14 of 17 queries were unchanged, and one well-formed
 * natural-language question got WORSE. The win is real but narrow, showing up
 * where the query reads as keywords rather than a question. Two different
 * instruction wordings scored 0.915 vs 0.916, so the benefit comes from having
 * an instruction at all, not from this particular sentence.
 */
export const DEFAULT_QUERY_INSTRUCTION =
  "Given a search query, retrieve relevant documents that answer the query";

/** Models whose training expects the query-side instruction convention. */
const INSTRUCTION_TUNED_EMBEDDING_MODELS = /qwen3-embedding/i;

/**
 * The instruction to use, or null to send queries raw.
 *
 * Gated on the model because this is not a universal improvement: sent to
 * OpenAI's text-embedding-3-small the prefix is just noise occupying the input.
 * LLM_QUERY_INSTRUCTION overrides — set it to force a custom instruction, or to
 * the empty string to disable entirely on a model that would otherwise get one.
 */
function queryInstruction(): string | null {
  const explicit = Deno.env.get("LLM_QUERY_INSTRUCTION");
  if (explicit !== undefined) return explicit.trim() === "" ? null : explicit;
  return INSTRUCTION_TUNED_EMBEDDING_MODELS.test(getLlmConfig().embeddingModel)
    ? DEFAULT_QUERY_INSTRUCTION
    : null;
}

/**
 * Wraps a search query in the model's expected instruction format.
 *
 * Exported for tests and for the retrieval eval harness; call sites should
 * generally use getQueryEmbedding instead.
 */
export function formatQueryForEmbedding(query: string): string {
  const instruction = queryInstruction();
  return instruction ? `Instruct: ${instruction}\nQuery: ${query}` : query;
}

/**
 * Embeds a SEARCH QUERY. Use this for anything a user is searching WITH; use
 * getEmbedding for content being stored.
 *
 * Keeping the two paths distinct is the whole point: prefixing stored content
 * would break the asymmetry the model expects AND require re-embedding the
 * entire graph. Query-side only means this change costs nothing at rest.
 */
export async function getQueryEmbedding(query: string): Promise<number[]> {
  return await getEmbedding(formatQueryForEmbedding(query));
}

/**
 * Cuts text to a length the embedding model can handle.
 *
 * TRADEOFF, deliberate: the tail of an over-long document does not contribute
 * to its vector, so a node whose distinguishing detail sits only in its last
 * paragraph becomes harder to retrieve. That is accepted because the
 * alternative on a crashing runner is no embedding at all. If tail content
 * starts mattering, the upgrade is chunk-and-mean-pool rather than a bigger
 * cap, since raising the cap just walks back toward the crash.
 *
 * Cuts at a paragraph break when one is reasonably near the limit, else a word
 * boundary, so the input does not end mid-token.
 */
export function truncateForEmbedding(
  text: string,
  maxChars: number = embeddingMaxChars(),
): string {
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  // Prefer a paragraph break, but only if it keeps most of the budget.
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph > maxChars * 0.8) return slice.slice(0, paragraph);
  // Otherwise fall back to the last whitespace so we never cut mid-word.
  const space = slice.search(/\s\S*$/);
  return space > 0 ? slice.slice(0, space) : slice;
}

// ─── Embedding Cache ────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_SIZE = 200;

interface CacheEntry {
  embedding: number[];
  cachedAt: number;
}

const embeddingCache = new Map<string, CacheEntry>();

function getCachedEmbedding(text: string): number[] | null {
  const entry = embeddingCache.get(text);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    embeddingCache.delete(text);
    return null;
  }
  return entry.embedding;
}

function setCachedEmbedding(text: string, embedding: number[]): void {
  if (embeddingCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey !== undefined) embeddingCache.delete(oldestKey);
  }
  embeddingCache.set(text, { embedding, cachedAt: Date.now() });
}

// ─── Embeddings ───────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
  // Truncate BEFORE the cache lookup so the key matches what was actually
  // embedded. Two long texts sharing a prefix collapse to one entry, which is
  // correct: with only the prefix sent, their vectors would be identical.
  const input = truncateForEmbedding(text);

  const cached = getCachedEmbedding(input);
  if (cached) return cached;

  const config = getLlmConfig();
  const res = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Embedding request failed (${res.status}): ${body}`);
    throw new Error(`Embedding request failed (${res.status})`);
  }

  const data = await res.json();
  const embedding = data.data[0].embedding;
  setCachedEmbedding(input, embedding);
  return embedding;
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await getEmbedding(texts[0])];

  // Same truncation as the single path, applied up front. A batch is only as
  // safe as its longest member: one over-long entry kills the whole request,
  // and on a crashing runner it takes the fallback retries down with it.
  const inputs = texts.map((t) => truncateForEmbedding(t));

  // Check cache, only send uncached to API
  const results: (number[] | null)[] = inputs.map((t) => getCachedEmbedding(t));
  const uncachedIndices = results
    .map((r, i) => (r === null ? i : -1))
    .filter((i) => i >= 0);

  if (uncachedIndices.length === 0) return results as number[][];

  const uncachedTexts = uncachedIndices.map((i) => inputs[i]);
  const config = getLlmConfig();

  try {
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: uncachedTexts,
      }),
    });

    if (!res.ok) {
      // Fallback: individual calls
      const fallback = await Promise.all(uncachedTexts.map((t) => getEmbedding(t)));
      for (let j = 0; j < uncachedIndices.length; j++) {
        results[uncachedIndices[j]] = fallback[j];
      }
      return results as number[][];
    }

    const data = await res.json();
    const sorted = data.data.sort(
      (a: { index: number }, b: { index: number }) => a.index - b.index
    );

    for (let j = 0; j < uncachedIndices.length; j++) {
      const embedding = sorted[j].embedding;
      results[uncachedIndices[j]] = embedding;
      setCachedEmbedding(uncachedTexts[j], embedding);
    }
    return results as number[][];
  } catch {
    // Fallback: individual calls
    const fallback = await Promise.all(uncachedTexts.map((t) => getEmbedding(t)));
    for (let j = 0; j < uncachedIndices.length; j++) {
      results[uncachedIndices[j]] = fallback[j];
    }
    return results as number[][];
  }
}

// ─── Metadata Extraction ─────────────────────────────────────

const EXTRACTION_PROMPTS: Partial<Record<NodeLabel, string>> = {
  Agent: `Extract metadata from this agent description. Return JSON:
{
  "agent_type": "person" | "team" | "org" | "ai",
  "is_root": true if this appears to be a root entity whose purpose doesn't cascade from above
}`,

  Need: `Extract metadata from this need description. Return JSON:
{
  "lifecycle_state": "open" | "under_review" | "resolved" | "deferred" | "accepted",
  "origin": brief provenance string if detectable
}`,

  Resource: `Extract metadata from this resource description. Return JSON:
{
  "resource_type": "skill" | "knowledge" | "tool" | "budget" | "capacity"
}`,

  Constraint: `Extract metadata from this constraint description. Return JSON:
{
  "constraint_type": "priority" | "understanding" | "approach" | "mechanics",
  "rigidity": "fixed" | "firm" | "flexible",
  "validation_state": "assumption" | "conviction" | "learning" (for the understanding layer only, omit otherwise),
  "origin_source": "intentional" | "emergent" | "inherited" (if detectable)
}`,

  Output: `Extract metadata from this output description. Return JSON:
{
  "is_primitive": true if this appears to be a foundational insight that anchors a branch
}`,

  Signal: `Extract metadata from this signal. Return JSON:
{
  "how_observed": "direct_observation" | "reported" | "inferred" | "environmental",
  "confidence": "high" | "medium" | "low",
  "altitude": "purpose" | "priority" | "understanding" | "approach" | "mechanics"
}`,

  Session: `Extract metadata from this session description. Return JSON:
{
  "session_type": "discovery" | "calibration" | "review" | "planning",
  "trigger_type": "cadence" | "signal"
}`,

  Discrepancy: `Extract metadata from this discrepancy description. Return JSON:
{
  "altitude": "purpose" | "priority" | "understanding" | "approach" | "mechanics"
}`,
};

// Fields that extractMetadata would produce per type. If caller provides these,
// skip the LLM call — the merge order (...extracted, ...properties) means
// explicit properties override extraction anyway.
const REQUIRED_EXTRACTION_FIELDS: Partial<Record<NodeLabel, string[]>> = {
  Agent: ["agent_type"],
  Need: ["lifecycle_state"],
  Resource: ["resource_type"],
  Constraint: ["constraint_type", "rigidity"],
  Output: ["is_primitive"],
  Signal: ["how_observed", "confidence"],
  Session: ["session_type", "trigger_type"],
  Discrepancy: ["altitude"],
};

export function shouldSkipExtraction(
  nodeType: NodeLabel,
  properties?: Record<string, unknown>
): boolean {
  if (!properties) return false;
  const required = REQUIRED_EXTRACTION_FIELDS[nodeType];
  if (!required) return true; // No extraction prompt (Role, Stock)
  return required.every((field) => field in properties && properties[field] !== undefined);
}

export async function extractMetadata(
  text: string,
  nodeType: NodeLabel
): Promise<ExtractedMetadata> {
  const systemPrompt = EXTRACTION_PROMPTS[nodeType];
  if (!systemPrompt) return {};

  try {
    const config = getLlmConfig();
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.completionModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error(`Metadata extraction failed (${res.status})`);
      return {};
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return {};

    const parsed = JSON.parse(content);

    // Validate: only accept string/boolean/number values, drop anything unexpected
    const safe: ExtractedMetadata = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
        safe[k] = v;
      }
    }
    return safe;
  } catch (err) {
    console.error("Metadata extraction error:", err);
    return {};
  }
}
