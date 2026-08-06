// Unit tests for Phase 1 query builders
// Run: deno test src/queries_test.ts

import { assertEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  captureQuery,
  createEntityQuery,
  deleteNodeQuery,
  deleteRelationshipQuery,
  diagnosticQueries,
  listQuery,
  statsQueries,
  schemaSetupQueries,
  activeSessionsForEntitiesQuery,
  openNeedsForEntitiesQuery,
  unprocessedSignalsForEntitiesQuery,
  attentionItemsQuery,
  structuralNeighborsQuery,
  batchCreateRelationshipsQuery,
  buildProcessingSummary,
  sanitizeSignalVocabulary,
  validateSignalVocabulary,
  KNOWN_SIGNAL_DISPOSITIONS,
  KNOWN_SIGNAL_STATUSES,
  processingSummaryQuery,
} from "./queries.ts";
import { ENTITY_LABELS, RELATIONSHIP_TYPES } from "./types.ts";

// ─── schemaSetupQueries ──────────────────────────────────────

Deno.test("schemaSetupQueries — default dimensions is 1536", () => {
  const queries = schemaSetupQueries();
  for (const q of queries) {
    if (q.cypher.includes("VECTOR INDEX")) {
      assertStringIncludes(q.cypher, "1536");
    }
  }
});

Deno.test("schemaSetupQueries — custom dimensions propagates to all vector indexes", () => {
  const queries = schemaSetupQueries(768);
  const vectorQueries = queries.filter((q) => q.cypher.includes("VECTOR INDEX"));
  assertEquals(vectorQueries.length, 4);
  for (const q of vectorQueries) {
    assertStringIncludes(q.cypher, "768");
    assertEquals(q.cypher.includes("1536"), false, "Should not contain default 1536");
  }
});

// ─── captureQuery ────────────────────────────────────────────

Deno.test("captureQuery — entity type routes through LABEL_MAP", () => {
  const q = captureQuery("Agent", { name: "Test Agent" }, false);
  assertStringIncludes(q.cypher, "Entity:Agent");
  assertStringIncludes(q.cypher, "CREATE");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.name, "Test Agent");
  assertEquals(typeof props.id, "string");
  assertEquals(typeof props.created_at, "string");
});

Deno.test("captureQuery — Need gets Entity:Artifact:Need label", () => {
  const q = captureQuery("Need", { name: "Test Need", content: "something" }, false);
  assertStringIncludes(q.cypher, "Entity:Artifact:Need");
});

Deno.test("captureQuery — System gets Entity:Agent:System label", () => {
  const q = captureQuery("System", { name: "Unified Analytics ETL" }, false);
  assertStringIncludes(q.cypher, "Entity:Agent:System");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.name, "Unified Analytics ETL");
  assertEquals(typeof props.id, "string");
  assertEquals(typeof props.created_at, "string");
});

Deno.test("captureQuery — Signal type creates Signal node", () => {
  const q = captureQuery("Signal", { observation: "test" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Signal");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "unprocessed");
});

Deno.test("captureQuery — unclassified sets needs_classification status", () => {
  const q = captureQuery("Signal", { observation: "test" }, true);
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "needs_classification");
});

Deno.test("captureQuery — Session gets default active status", () => {
  const q = captureQuery("Session", { name: "Test Session" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Session");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "active");
});

Deno.test("captureQuery — Discrepancy gets default surfaced state", () => {
  const q = captureQuery("Discrepancy", { content: "gap found" }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Discrepancy");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.lifecycle_state, "surfaced");
});

Deno.test("captureQuery — Stock creates Stock node", () => {
  const q = captureQuery("Stock", { name: "Trust", level: 5 }, false);
  assertStringIncludes(q.cypher, "CREATE (n:Stock");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.level, 5);
});

Deno.test("captureQuery — unknown type throws", () => {
  assertThrows(
    () => captureQuery("Bogus", {}, false),
    Error,
    "Unknown node type"
  );
});

Deno.test("captureQuery — all node types get id and created_at", () => {
  for (const type of ["Agent", "Signal", "Session", "Discrepancy", "Stock"]) {
    const q = captureQuery(type, { name: "test" }, false);
    const props = q.params.props as Record<string, unknown>;
    assertEquals(typeof props.id, "string", `${type} missing id`);
    assertEquals(typeof props.created_at, "string", `${type} missing created_at`);
  }
});

Deno.test("captureQuery — explicit props not overwritten", () => {
  const q = captureQuery("Signal", { observation: "x", status: "under_review" }, false);
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.status, "under_review");
});

// ─── deleteNodeQuery ─────────────────────────────────────────

Deno.test("deleteNodeQuery — uses DETACH DELETE", () => {
  const q = deleteNodeQuery("test-id");
  assertStringIncludes(q.cypher, "DETACH DELETE");
  assertEquals(q.params.nodeId, "test-id");
});

// ─── deleteRelationshipQuery ────────────────────────────────

Deno.test("deleteRelationshipQuery — matches directed edge by type and deletes it, not the nodes", () => {
  const q = deleteRelationshipQuery("from-id", "to-id", "RELATED_TO");
  assertStringIncludes(q.cypher, "(from {id: $fromId})-[r:RELATED_TO]->(to {id: $toId})");
  assertStringIncludes(q.cypher, "DELETE r");
  assertEquals(q.cypher.includes("DETACH"), false, "should not delete the nodes themselves");
  assertEquals(q.params.fromId, "from-id");
  assertEquals(q.params.toId, "to-id");
});

// ─── listQuery ───────────────────────────────────────────────

Deno.test("listQuery — no filters returns basic match", () => {
  const q = listQuery({});
  assertStringIncludes(q.cypher, "MATCH (n)");
  assertStringIncludes(q.cypher, "ORDER BY n.created_at DESC");
  assertStringIncludes(q.cypher, "toInteger($limit)");
  assertEquals(q.params.limit, 20);
});

Deno.test("listQuery — type filter uses label in MATCH", () => {
  const q = listQuery({ type: "Signal" });
  assertStringIncludes(q.cypher, "MATCH (n:Signal)");
});

Deno.test("listQuery — days filter adds since param", () => {
  const q = listQuery({ days: 7 });
  assertStringIncludes(q.cypher, "n.created_at >= $since");
  assertEquals(typeof q.params.since, "string");
});

Deno.test("listQuery — status filter adds WHERE clause", () => {
  const q = listQuery({ status: "unprocessed" });
  assertStringIncludes(q.cypher, "n.status = $status");
  assertEquals(q.params.status, "unprocessed");
});

Deno.test("listQuery — limit is floored to integer", () => {
  const q = listQuery({ limit: 5.7 });
  assertEquals(q.params.limit, 5);
});

Deno.test("listQuery — all filters combined", () => {
  const q = listQuery({ days: 3, type: "Agent", status: "active", limit: 10 });
  assertStringIncludes(q.cypher, "MATCH (n:Agent)");
  assertStringIncludes(q.cypher, "n.created_at >= $since");
  assertStringIncludes(q.cypher, "n.status = $status");
  assertEquals(q.params.limit, 10);
});

// ─── statsQueries ────────────────────────────────────────────

Deno.test("statsQueries — returns all 5 expected queries", () => {
  const q = statsQueries();
  const keys = Object.keys(q);
  assertEquals(keys.length, 5);
  assertEquals(keys.includes("node_counts"), true);
  assertEquals(keys.includes("edge_counts"), true);
  assertEquals(keys.includes("recent_7_days"), true);
  assertEquals(keys.includes("unprocessed_signals"), true);
  assertEquals(keys.includes("open_needs"), true);
});

Deno.test("statsQueries — node_counts excludes Entity and Artifact labels", () => {
  const q = statsQueries();
  assertStringIncludes(q.node_counts.cypher, "label <> 'Entity'");
  assertStringIncludes(q.node_counts.cypher, "label <> 'Artifact'");
});

Deno.test("statsQueries — recent_7_days has since param", () => {
  const q = statsQueries();
  assertEquals(typeof q.recent_7_days.params.since, "string");
});

Deno.test("statsQueries — unprocessed includes needs_classification", () => {
  const q = statsQueries();
  assertStringIncludes(q.unprocessed_signals.cypher, "needs_classification");
});

// ─── Context query builders ──────────────────────────────────

const testIds = ["id-1", "id-2"];

Deno.test("activeSessionsForEntitiesQuery — filters active sessions", () => {
  const q = activeSessionsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "status: 'active'");
  assertStringIncludes(q.cypher, "$entityIds");
  assertEquals(q.params.entityIds, testIds);
});

Deno.test("openNeedsForEntitiesQuery — filters open lifecycle state", () => {
  const q = openNeedsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "lifecycle_state = 'open'");
  assertEquals(q.params.entityIds, testIds);
});

Deno.test("unprocessedSignalsForEntitiesQuery — includes both unprocessed statuses", () => {
  const q = unprocessedSignalsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "unprocessed");
  assertStringIncludes(q.cypher, "needs_classification");
});

Deno.test("unprocessedSignalsForEntitiesQuery — truncates text fields with v1/v2 compat", () => {
  const q = unprocessedSignalsForEntitiesQuery(testIds);
  assertStringIncludes(q.cypher, "COALESCE(s.observation, s.concrete_data)");
  assertStringIncludes(q.cypher, "COALESCE(s.context, s.interpretation)");
});

Deno.test("attentionItemsQuery — checks depleting stocks and stale signals", () => {
  const q = attentionItemsQuery(testIds);
  assertStringIncludes(q.cypher, "trend = 'depleting'");
  assertStringIncludes(q.cypher, "$staleThreshold");
  assertEquals(typeof q.params.staleThreshold, "string");
});

Deno.test("structuralNeighborsQuery — 2-hop traversal with projected fields", () => {
  const q = structuralNeighborsQuery(testIds);
  assertStringIncludes(q.cypher, "*1..2");
  assertStringIncludes(q.cypher, "LIMIT 30");
  // Verify projection excludes embedding
  assertStringIncludes(q.cypher, ".id, .name,");
  assertEquals(q.cypher.includes(".embedding"), false);
});

// ─── diagnosticQueries ──────────────────────────────────────

Deno.test("diagnosticQueries — returns all 15 expected diagnostics", () => {
  const q = diagnosticQueries();
  const keys = Object.keys(q);
  assertEquals(keys.length, 15);
  // Original 8
  assertEquals(keys.includes("unattached_needs"), true);
  assertEquals(keys.includes("missing_purpose"), true);
  assertEquals(keys.includes("overloaded_agents"), true);
  assertEquals(keys.includes("phantom_sessions"), true);
  assertEquals(keys.includes("entities_without_purpose"), true);
  assertEquals(keys.includes("unprocessed_signals"), true);
  assertEquals(keys.includes("ego_drift_check"), true);
  assertEquals(keys.includes("constraint_role_analysis"), true);
  // New 7
  assertEquals(keys.includes("needs_without_resources"), true);
  assertEquals(keys.includes("incomplete_purpose_edges"), true);
  assertEquals(keys.includes("hollow_middle"), true);
  assertEquals(keys.includes("roles_without_needs"), true);
  assertEquals(keys.includes("relationships_without_purpose"), true);
  assertEquals(keys.includes("depleting_stocks_without_signals"), true);
  assertEquals(keys.includes("content_children_coherence"), true);
});

Deno.test("diagnosticQueries — improved diagnostics include content_preview", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.unattached_needs.cypher, "content_preview");
  assertStringIncludes(q.missing_purpose.cypher, "content_preview");
  assertStringIncludes(q.entities_without_purpose.cypher, "content_preview");
  assertStringIncludes(q.unprocessed_signals.cypher, "content_preview");
});

Deno.test("diagnosticQueries — content_preview uses substring(0, 150)", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.unattached_needs.cypher, "substring(n.content, 0, 150)");
  assertStringIncludes(q.needs_without_resources.cypher, "substring(n.content, 0, 150)");
});

Deno.test("diagnosticQueries — missing_purpose excludes Constraint nodes", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.missing_purpose.cypher, "NOT e:Constraint");
});

Deno.test("diagnosticQueries — entities_without_purpose excludes Constraint nodes", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.entities_without_purpose.cypher, "NOT e:Constraint");
});

Deno.test("diagnosticQueries — unattached_needs checks SCOPED_TO in both directions", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.unattached_needs.cypher, "SCOPED_TO");
});

Deno.test("diagnosticQueries — hollow_middle checks understanding and approach constraints", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.hollow_middle.cypher, "understanding");
  assertStringIncludes(q.hollow_middle.cypher, "approach");
  assertStringIncludes(q.hollow_middle.cypher, "SERVES");
});

Deno.test("diagnosticQueries — incomplete_purpose_edges checks purpose_type", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.incomplete_purpose_edges.cypher, "purpose_type IS NULL");
});

Deno.test("diagnosticQueries — depleting_stocks checks for missing signals", () => {
  const q = diagnosticQueries();
  assertStringIncludes(q.depleting_stocks_without_signals.cypher, "depleting");
  assertStringIncludes(q.depleting_stocks_without_signals.cypher, "SIGNALS");
});

// ─── listQuery compact mode ───────────────────────────────────

Deno.test("listQuery — compact mode uses field projection", () => {
  const q = listQuery({ compact: true });
  assertStringIncludes(q.cypher, "n{.id, .name, .status, .created_at");
  assertStringIncludes(q.cypher, "left(n.content, 200)");
});

Deno.test("listQuery — non-compact mode returns full node", () => {
  const q = listQuery({ compact: false });
  assertStringIncludes(q.cypher, "RETURN n, labels(n)");
});

// ─── batchCreateRelationshipsQuery ────────────────────────────

Deno.test("batchCreateRelationshipsQuery — generates one query per relationship", () => {
  const queries = batchCreateRelationshipsQuery([
    { from_id: "a", to_id: "b", relationship_type: "SERVES" },
    { from_id: "c", to_id: "d", relationship_type: "CONTAINS", properties: { order: 1 } },
  ]);
  assertEquals(queries.length, 2);
  assertStringIncludes(queries[0].cypher, "SERVES");
  assertStringIncludes(queries[1].cypher, "CONTAINS");
  assertStringIncludes(queries[1].cypher, "$relProps");
});

Deno.test("batchCreateRelationshipsQuery — rejects invalid relationship type", () => {
  assertThrows(
    () => batchCreateRelationshipsQuery([{ from_id: "a", to_id: "b", relationship_type: "DROP DATABASE" }]),
    Error,
    "Invalid relationship type"
  );
});

Deno.test("batchCreateRelationshipsQuery — empty array returns empty", () => {
  const queries = batchCreateRelationshipsQuery([]);
  assertEquals(queries.length, 0);
});

// ─── processingSummaryQuery ───────────────────────────────────

Deno.test("processingSummaryQuery — scoped to session uses PRODUCED_IN", () => {
  const q = processingSummaryQuery("session-123");
  assertStringIncludes(q.cypher, "PRODUCED_IN");
  assertStringIncludes(q.cypher, "$sessionId");
  assertEquals(q.params.sessionId, "session-123");
});

Deno.test("processingSummaryQuery — unscoped matches all signals", () => {
  const q = processingSummaryQuery();
  assertStringIncludes(q.cypher, "MATCH (s:Signal)");
  assertEquals(q.cypher.includes("PRODUCED_IN"), false);
  // No session binding when unscoped. The query still carries the known-vocabulary
  // params used for drift detection, so this asserts the absence of sessionId
  // rather than an empty param set.
  assertEquals(q.params.sessionId, undefined);
});

Deno.test("processingSummaryQuery — returns all disposition counts", () => {
  const q = processingSummaryQuery();
  assertStringIncludes(q.cypher, "additive");
  assertStringIncludes(q.cypher, "redundant");
  assertStringIncludes(q.cypher, "contradictory");
  assertStringIncludes(q.cypher, "unrelated");
});

Deno.test("processingSummaryQuery — collects values outside the known vocabulary", () => {
  const q = processingSummaryQuery();
  assertStringIncludes(q.cypher, "unknown_statuses");
  assertStringIncludes(q.cypher, "unknown_dispositions");
  assertStringIncludes(q.cypher, "NOT s.status IN $knownStatuses");
  assertStringIncludes(q.cypher, "NOT s.disposition IN $knownDispositions");
});

Deno.test("processingSummaryQuery — passes known vocabulary as params", () => {
  const q = processingSummaryQuery();
  assertEquals(q.params.knownStatuses, KNOWN_SIGNAL_STATUSES);
  assertEquals(q.params.knownDispositions, KNOWN_SIGNAL_DISPOSITIONS);
  // Session scoping must not clobber the vocabulary params.
  const scoped = processingSummaryQuery("session-123");
  assertEquals(scoped.params.sessionId, "session-123");
  assertEquals(scoped.params.knownStatuses, KNOWN_SIGNAL_STATUSES);
});

Deno.test("processingSummaryQuery — known vocabulary covers every bucket it counts", () => {
  const q = processingSummaryQuery();
  // Each bucketed literal must also be in the known list, or a value would be
  // counted in by_status/by_disposition AND reported as unrecognized.
  const statuses: readonly string[] = KNOWN_SIGNAL_STATUSES;
  const dispositions: readonly string[] = KNOWN_SIGNAL_DISPOSITIONS;
  for (const status of ["resolved_into_update", "dismissed", "under_review", "unprocessed"]) {
    assertStringIncludes(q.cypher, status);
    assertEquals(statuses.includes(status), true);
  }
  for (const d of ["additive", "redundant", "contradictory", "unrelated"]) {
    assertEquals(dispositions.includes(d), true);
  }
});

Deno.test("processingSummaryQuery — counts signals with no status at all", () => {
  const q = processingSummaryQuery();
  assertStringIncludes(q.cypher, "s.status IS NULL THEN 1 END) AS no_status");
});

// ─── buildProcessingSummary ───────────────────────────────────

Deno.test("buildProcessingSummary — omits unrecognized when vocabulary is clean", () => {
  const summary = buildProcessingSummary({
    total: 3,
    resolved: 2,
    unprocessed: 1,
    additive: 3,
    unknown_statuses: [],
    unknown_dispositions: [],
  });
  assertEquals("unrecognized" in summary, false);
  assertEquals(summary.reconciliation.balanced, true);
});

Deno.test("buildProcessingSummary — names drifted values and keeps the books balanced", () => {
  // Fixture mirrors the real graph state on 2026-08-06: 28 signals where four
  // dispositions were written outside the enum. Before this change those four
  // vanished from by_disposition with no trace (24 counted against 28 total).
  const summary = buildProcessingSummary({
    total: 28,
    resolved: 26,
    unprocessed: 2,
    additive: 24,
    unknown_statuses: [],
    unknown_dispositions: [
      "refuted",
      "confirmed_separate_initiative",
      "needs_review",
      "unresolved",
    ],
  });

  assertEquals(summary.unrecognized, {
    disposition: {
      refuted: 1,
      confirmed_separate_initiative: 1,
      needs_review: 1,
      unresolved: 1,
    },
  });
  // 24 bucketed + 4 unrecognized = 28. The gap is now visible, not lost.
  assertEquals(summary.reconciliation.disposition_counted, 28);
  assertEquals(summary.reconciliation.status_counted, 28);
  assertEquals(summary.reconciliation.balanced, true);
});

Deno.test("buildProcessingSummary — repeated drifted values are tallied, not deduped", () => {
  const summary = buildProcessingSummary({
    total: 4,
    resolved: 1,
    additive: 1,
    unknown_statuses: ["processed", "processed", "archived"],
    unknown_dispositions: ["refuted", "refuted", "refuted"],
  });
  assertEquals(summary.unrecognized?.status, { processed: 2, archived: 1 });
  assertEquals(summary.unrecognized?.disposition, { refuted: 3 });
  assertEquals(summary.reconciliation.status_counted, 4);
});

Deno.test("buildProcessingSummary — flags imbalance rather than hiding it", () => {
  // A row where the buckets genuinely do not add up to the total: 10 signals
  // but only 5 accounted for. `balanced` must go false.
  const summary = buildProcessingSummary({
    total: 10,
    resolved: 5,
    additive: 5,
    unknown_statuses: [],
    unknown_dispositions: [],
  });
  assertEquals(summary.reconciliation.status_counted, 5);
  assertEquals(summary.reconciliation.balanced, false);
});

Deno.test("buildProcessingSummary — missing counts default to zero, not NaN", () => {
  const summary = buildProcessingSummary({ total: 0 });
  assertEquals(summary.total_signals, 0);
  assertEquals(summary.by_status.resolved_into_update, 0);
  assertEquals(summary.by_disposition.no_disposition, 0);
  assertEquals(summary.reconciliation.balanced, true);
});

// ─── Signal vocabulary enforcement ────────────────────────────

Deno.test("validateSignalVocabulary — accepts every value the summary buckets", () => {
  for (const status of KNOWN_SIGNAL_STATUSES) {
    validateSignalVocabulary({ status });
  }
  for (const disposition of KNOWN_SIGNAL_DISPOSITIONS) {
    validateSignalVocabulary({ disposition });
  }
});

Deno.test("validateSignalVocabulary — no-ops on absent, undefined, or empty props", () => {
  validateSignalVocabulary(undefined);
  validateSignalVocabulary({});
  validateSignalVocabulary({ status: undefined, disposition: undefined });
  // Unrelated keys are none of its business.
  validateSignalVocabulary({ observation: "x", confidence: "high" });
});

Deno.test("validateSignalVocabulary — rejects the exact values that drifted in practice", () => {
  // Every one of these was written to the real graph and silently dropped.
  for (const status of ["processed", "resolved"]) {
    assertThrows(
      () => validateSignalVocabulary({ status }),
      Error,
      `Invalid Signal status "${status}"`,
    );
  }
  for (const disposition of ["refuted", "confirmed_separate_initiative", "needs_review", "unresolved"]) {
    assertThrows(
      () => validateSignalVocabulary({ disposition }),
      Error,
      `Invalid Signal disposition "${disposition}"`,
    );
  }
});

Deno.test("validateSignalVocabulary — error names the legal values and points at outcome", () => {
  assertThrows(
    () => validateSignalVocabulary({ disposition: "refuted" }),
    Error,
    // Naming the escape hatch is the part that prevents the next invented field.
    "`outcome`",
  );
  assertThrows(
    () => validateSignalVocabulary({ status: "processed" }),
    Error,
    "resolved_into_update",
  );
});

Deno.test("validateSignalVocabulary — rejects non-string values", () => {
  assertThrows(() => validateSignalVocabulary({ status: 1 }), Error, "Invalid Signal status");
  assertThrows(() => validateSignalVocabulary({ disposition: true }), Error, "Invalid Signal disposition");
});

Deno.test("validateSignalVocabulary — null is treated as absent, not invalid", () => {
  // Distinct from an invalid value: an explicit null means "no disposition",
  // which processing_summary already counts in its own bucket.
  validateSignalVocabulary({ status: null, disposition: null });
});

Deno.test("sanitizeSignalVocabulary — preserves an invented value in outcome instead of losing it", () => {
  const out = sanitizeSignalVocabulary({
    observation: "x",
    status: "totally-made-up",
  });
  assertEquals("status" in out, false);
  assertEquals(out.outcome, "totally-made-up");
  assertEquals(out.observation, "x");
});

Deno.test("sanitizeSignalVocabulary — never clobbers an outcome the caller already set", () => {
  const out = sanitizeSignalVocabulary({
    disposition: "invented",
    outcome: "authored by a human",
  });
  assertEquals(out.outcome, "authored by a human");
  assertEquals("disposition" in out, false);
});

Deno.test("sanitizeSignalVocabulary — leaves valid values untouched and does not mutate input", () => {
  const input = { status: "unprocessed", disposition: "additive", observation: "x" };
  const out = sanitizeSignalVocabulary(input);
  assertEquals(out, input);
  assertEquals(input.status, "unprocessed", "input must not be mutated");
});

Deno.test("buildProcessingSummary — passes through session scoping", () => {
  const scoped = buildProcessingSummary({ total: 1, resolved: 1, additive: 1 }, "session-123");
  assertEquals((scoped as { session_id?: string }).session_id, "session-123");
  const unscoped = buildProcessingSummary({ total: 1, resolved: 1, additive: 1 });
  assertEquals("session_id" in unscoped, false);
});

// ─── System entity + system relationships ─────────────────────

Deno.test("createEntityQuery — System routes to Entity:Agent:System label", () => {
  const q = createEntityQuery("System", { name: "Snowflake" });
  assertStringIncludes(q.cypher, "Entity:Agent:System");
  assertStringIncludes(q.cypher, "CREATE");
  const props = q.params.props as Record<string, unknown>;
  assertEquals(props.name, "Snowflake");
  assertEquals(typeof props.id, "string");
  assertEquals(typeof props.created_at, "string");
  assertEquals(typeof props.updated_at, "string");
});

Deno.test("ENTITY_LABELS — includes System", () => {
  assertEquals(ENTITY_LABELS.includes("System"), true);
});

Deno.test("RELATIONSHIP_TYPES — includes the three system edges", () => {
  assertEquals(RELATIONSHIP_TYPES.includes("DEPENDS_ON"), true);
  assertEquals(RELATIONSHIP_TYPES.includes("FLOWS_TO"), true);
  assertEquals(RELATIONSHIP_TYPES.includes("RUNS_ON"), true);
  assertEquals(RELATIONSHIP_TYPES.length, 26);
});

Deno.test("batchCreateRelationshipsQuery — accepts system edge types with props", () => {
  const queries = batchCreateRelationshipsQuery([
    { from_id: "etl", to_id: "pg", relationship_type: "DEPENDS_ON", properties: { criticality: "hard" } },
    { from_id: "extract", to_id: "transform", relationship_type: "FLOWS_TO", properties: { mode: "batch" } },
    { from_id: "etl", to_id: "cluster", relationship_type: "RUNS_ON", properties: { environment: "prod" } },
  ]);
  assertEquals(queries.length, 3);
  assertStringIncludes(queries[0].cypher, "DEPENDS_ON");
  assertStringIncludes(queries[1].cypher, "FLOWS_TO");
  assertStringIncludes(queries[2].cypher, "RUNS_ON");
  assertStringIncludes(queries[0].cypher, "$relProps");
});
