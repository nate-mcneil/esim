// Re-embed all nodes whose embedding dimensions don't match the configured model

import { runQuery, closeDriver } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { getEmbedding, getLlmConfig } from "../src/llm.ts";

await loadEnv();

const { embeddingDimensions } = getLlmConfig();
console.log(`Target dimensions: ${embeddingDimensions}`);

// Find all nodes with embeddings that need updating.
//
// Embed `content` when present, else fall back to `name` — the same choice
// update_node makes when picking text to embed. Filtering on `content IS NOT
// NULL` (as this did originally) silently skipped every node embedded from its
// name alone: on the 2026-08-06 4096→1024 migration that left 14 nodes (13
// Roles and a Session) holding stale-dimension vectors inside the new index,
// invisible to vector search and reported by nothing, because the run still
// ended "306 re-embedded, 0 failed".
const stale = await runQuery<{ id: string; label: string; text: string; dims: number }>({
  cypher: `
    MATCH (n)
    WHERE n.embedding IS NOT NULL
      AND size(n.embedding) <> $dims
      AND coalesce(n.content, n.name) IS NOT NULL
    RETURN n.id AS id, head(labels(n)) AS label,
           coalesce(n.content, n.name) AS text, size(n.embedding) AS dims
  `,
  params: { dims: embeddingDimensions },
});

console.log(`Found ${stale.length} nodes to re-embed (currently wrong dimensions)\n`);

let success = 0;
let failed = 0;

for (const node of stale) {
  try {
    const embedding = await getEmbedding(node.text);
    await runQuery({
      cypher: `MATCH (n {id: $id}) SET n.embedding = $embedding`,
      params: { id: node.id, embedding },
    });
    success++;
    console.log(`  [${success}/${stale.length}] ${node.label}: ${node.id.slice(0, 8)}… (${node.dims} → ${embedding.length})`);
  } catch (e) {
    failed++;
    console.error(`  FAILED: ${node.id} — ${(e as Error).message}`);
  }
}

console.log(`\nDone. ${success} re-embedded, ${failed} failed.`);

// Verify rather than trust the counters above. A node that is unreachable by
// this script (no content AND no name) or that failed mid-run still holds a
// wrong-dimension vector, which the index will not serve and no error reports.
const remaining = await runQuery<{ d: number; c: number }>({
  cypher: `
    MATCH (n) WHERE n.embedding IS NOT NULL AND size(n.embedding) <> $dims
    RETURN size(n.embedding) AS d, count(*) AS c ORDER BY d
  `,
  params: { dims: embeddingDimensions },
});

if (remaining.length === 0) {
  console.log(`Verified: every embedded node is at ${embeddingDimensions} dimensions.`);
} else {
  const total = remaining.reduce((sum, r) => sum + Number(r.c), 0);
  console.error(
    `\n⚠️  ${total} node(s) still hold wrong-dimension embeddings: ` +
      remaining.map((r) => `${r.c} at ${r.d}`).join(", ")
  );
  console.error(
    `These are excluded from vector search until fixed. Nodes with neither ` +
      `content nor name cannot be re-embedded by this script; clear their ` +
      `embedding or give them text.`
  );
}

await closeDriver();
