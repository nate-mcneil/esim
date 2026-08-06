// Unit tests for server-layer helpers
// Run: deno test src/server_test.ts --allow-env

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { safeErrorMessage } from "./server.ts";

// ─── safeErrorMessage ─────────────────────────────────────────

const LLM_FAILURE = "LLM API request failed";
const CONFIG_FAILURE = "Server configuration error — check environment variables";

Deno.test("safeErrorMessage — collapses genuine LLM/transport failures", () => {
  for (const msg of [
    "fetch failed",
    "openai returned 500",
    "openrouter timeout",
    "embedding generation failed",
    "OpenAI API returned 429",
    "API rate limit exceeded",
  ]) {
    assertEquals(safeErrorMessage(new Error(msg)), LLM_FAILURE, msg);
  }
});

Deno.test("safeErrorMessage — collapses missing-configuration errors", () => {
  for (const msg of [
    "Missing Neo4j credentials. Set NEO4J_DB_CONNECTION_URI...",
    "Missing OPENAI_API_KEY",
    "Missing NEO4J_DB_CONNECTION_URI",
  ]) {
    assertEquals(safeErrorMessage(new Error(msg)), CONFIG_FAILURE, msg);
  }
});

Deno.test("safeErrorMessage — 'api' inside a longer word is no longer an LLM failure", () => {
  // The whole point of the word boundary. Under the old bare-substring match
  // every one of these was reported as "LLM API request failed", pointing
  // debugging at the model provider for errors that had nothing to do with it.
  for (const msg of [
    "Node at capacity",
    "rapid retry detected",
    "capital letters required in identifier",
    "therapist entity not found",
  ]) {
    assertEquals(safeErrorMessage(new Error(msg)), msg, msg);
  }
});

Deno.test("safeErrorMessage — operational errors pass through intact", () => {
  const msg = "No node found with id: abc-123";
  assertEquals(safeErrorMessage(new Error(msg)), msg);
});

Deno.test("safeErrorMessage — vocabulary errors reach the caller undamaged", () => {
  // These messages are the only way a caller learns that `outcome` exists,
  // so they must not be collapsed into a generic string.
  const msg =
    'Invalid Signal disposition "refuted". Allowed: additive, redundant, ' +
    "contradictory, unrelated. If none of these is precise enough, put the " +
    "exact word in `outcome` (free text) and set `disposition` to the closest " +
    "listed value — that keeps the signal visible to processing_summary " +
    "without losing your meaning.";
  assertEquals(safeErrorMessage(new Error(msg)), msg);
});

Deno.test("safeErrorMessage — no DEBUG prefix leaks to clients", () => {
  // Regression guard: a `return \`DEBUG: ${msg}\`` short-circuit once sat above
  // the sanitizing branches, making them unreachable and prefixing every
  // message sent to MCP clients.
  const result = safeErrorMessage(new Error("Missing OPENAI_API_KEY"));
  assertEquals(result.startsWith("DEBUG:"), false);
  assertEquals(result, CONFIG_FAILURE);
});

Deno.test("safeErrorMessage — handles errors with no message", () => {
  assertEquals(safeErrorMessage(new Error()), "Unknown error");
  assertEquals(safeErrorMessage({}), "Unknown error");
});
