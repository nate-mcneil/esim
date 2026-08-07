// Unit tests for embedding input handling
// Run: deno test src/llm_test.ts --allow-env

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_EMBEDDING_MAX_CHARS, truncateForEmbedding } from "./llm.ts";

// ─── truncateForEmbedding ─────────────────────────────────────

Deno.test("truncateForEmbedding — leaves text at or under the limit untouched", () => {
  assertEquals(truncateForEmbedding("short", 100), "short");
  const exact = "x".repeat(100);
  assertEquals(truncateForEmbedding(exact, 100), exact);
});

Deno.test("truncateForEmbedding — never returns more than the limit", () => {
  // The whole point: the runner crashes above its ceiling, so overshooting by
  // even a little defeats the cap.
  for (const len of [101, 500, 12_000]) {
    const out = truncateForEmbedding("word ".repeat(len), 100);
    assertEquals(out.length <= 100, true, `len=${len} produced ${out.length}`);
  }
});

Deno.test("truncateForEmbedding — cuts at a paragraph break when one is near the limit", () => {
  const head = "a".repeat(85);
  const text = `${head}\n\n${"b".repeat(500)}`;
  // Break sits at index 85, above 0.8 * 100, so it should be preferred.
  assertEquals(truncateForEmbedding(text, 100), head);
});

Deno.test("truncateForEmbedding — ignores a paragraph break that would waste the budget", () => {
  // Break at index 10 is far below the limit; taking it would throw away most
  // of the content, so the word-boundary path should win instead.
  const text = `${"a".repeat(10)}\n\n${"cc ".repeat(200)}`;
  const out = truncateForEmbedding(text, 100);
  assertEquals(out.length > 10, true, "should not collapse to the early break");
  assertEquals(out.length <= 100, true);
});

Deno.test("truncateForEmbedding — does not cut mid-word", () => {
  const out = truncateForEmbedding("alpha beta gamma delta epsilon", 14);
  // 14 chars would land inside "gamma"; expect a clean word boundary.
  assertEquals(out, "alpha beta");
  assertEquals(out.endsWith(" "), false, "should not leave trailing whitespace");
});

Deno.test("truncateForEmbedding — handles text with no whitespace at all", () => {
  // A single enormous token has no boundary to cut on; capping still applies.
  const out = truncateForEmbedding("x".repeat(500), 100);
  assertEquals(out.length, 100);
});

Deno.test("truncateForEmbedding — is idempotent", () => {
  // getEmbeddings' fallback path re-truncates already-truncated text, so a
  // second pass must not shrink it further.
  const text = "word ".repeat(5000);
  const once = truncateForEmbedding(text, 1000);
  assertEquals(truncateForEmbedding(once, 1000), once);
});

Deno.test("truncateForEmbedding — default cap is well below the observed crash point", () => {
  // The qwen3-embedding:8b runner died above roughly 9,000 chars of prose, and
  // the threshold drifted with memory pressure. A default that hugs it is not
  // safe, so assert real headroom rather than the exact number.
  assertEquals(DEFAULT_EMBEDDING_MAX_CHARS <= 7000, true);
  assertEquals(DEFAULT_EMBEDDING_MAX_CHARS > 0, true);
});

Deno.test("truncateForEmbedding — LLM_EMBEDDING_MAX_CHARS overrides the default", () => {
  const original = Deno.env.get("LLM_EMBEDDING_MAX_CHARS");
  try {
    Deno.env.set("LLM_EMBEDDING_MAX_CHARS", "50");
    assertEquals(truncateForEmbedding("word ".repeat(100)).length <= 50, true);

    // Garbage values must fall back to the default, not to zero or NaN, which
    // would silently embed empty strings for every node.
    for (const bad of ["0", "-10", "abc", ""]) {
      Deno.env.set("LLM_EMBEDDING_MAX_CHARS", bad);
      const out = truncateForEmbedding("word ".repeat(4000));
      assertEquals(out.length > 0, true, `bad value ${JSON.stringify(bad)} produced empty input`);
      assertEquals(out.length <= DEFAULT_EMBEDDING_MAX_CHARS, true);
    }
  } finally {
    if (original === undefined) Deno.env.delete("LLM_EMBEDDING_MAX_CHARS");
    else Deno.env.set("LLM_EMBEDDING_MAX_CHARS", original);
  }
});
