// Migrate technical systems from Resource{resource_type:"tool"} to the System label.
//
//   node: Entity:Artifact:Resource {resource_type:"tool"}  →  Entity:Agent:System
//   edge: (Output)-[:REQUIRES]->(tool)                     →  (System)-[:SERVES]->(Output)
//   edge: (tool)-[:RELATED_TO {"depends on"}]->(x)         →  (System)-[:DEPENDS_ON {criticality:"hard"}]->(x)
//   edge: (tool)-[:RELATED_TO {"integrates with"}]->(x)    →  (System)-[:FLOWS_TO]->(x)
//
// Descriptive RELATED_TO edges (other relationship_description values) are left
// untouched. All steps run in a single transaction — any failure rolls back.
// Run a full backup first (scripts/backup.ts). See docs/systems-schema-design.md §6.

import { loadEnv } from "../src/env.ts";
import { runQuery, runInTransaction, closeDriver } from "../src/db.ts";

await loadEnv();

const count = async (cypher: string): Promise<number> => {
  const r = await runQuery<{ cnt: number }>({ cypher, params: {} });
  return (r[0]?.cnt as number) ?? 0;
};

// ─── Before ───────────────────────────────────────────────────
const before = {
  tools: await count(`MATCH (n:Resource {resource_type:'tool'}) RETURN count(n) AS cnt`),
  systems: await count(`MATCH (n:System) RETURN count(n) AS cnt`),
  requires: await count(`MATCH (:Output)-[r:REQUIRES]->(:Resource {resource_type:'tool'}) RETURN count(r) AS cnt`),
  dependsOn: await count(`MATCH (:Resource {resource_type:'tool'})-[r:RELATED_TO]->() WHERE r.relationship_description='depends on' RETURN count(r) AS cnt`),
  integrates: await count(`MATCH (:Resource {resource_type:'tool'})-[r:RELATED_TO]->() WHERE r.relationship_description='integrates with' RETURN count(r) AS cnt`),
};
console.log("Before:", before);

// ─── Migrate (atomic) ─────────────────────────────────────────
await runInTransaction([
  // 1. Relabel the nodes and drop the now-meaningless resource_type.
  {
    cypher: `MATCH (n:Resource {resource_type:'tool'})
REMOVE n:Artifact, n:Resource
SET n:Agent, n:System
REMOVE n.resource_type`,
    params: {},
  },
  // 2. Flip product→system REQUIRES into the canonical system→product SERVES.
  {
    cypher: `MATCH (o:Output)-[r:REQUIRES]->(s:System)
MERGE (s)-[:SERVES]->(o)
DELETE r`,
    params: {},
  },
  // 3. "depends on" RELATED_TO → typed DEPENDS_ON.
  {
    cypher: `MATCH (s:System)-[r:RELATED_TO]->(x)
WHERE r.relationship_description = 'depends on'
MERGE (s)-[d:DEPENDS_ON]->(x)
SET d.criticality = 'hard'
DELETE r`,
    params: {},
  },
  // 4. "integrates with" RELATED_TO → typed FLOWS_TO.
  {
    cypher: `MATCH (s:System)-[r:RELATED_TO]->(x)
WHERE r.relationship_description = 'integrates with'
MERGE (s)-[:FLOWS_TO]->(x)
DELETE r`,
    params: {},
  },
]);

// ─── After ────────────────────────────────────────────────────
const after = {
  toolsRemaining: await count(`MATCH (n:Resource {resource_type:'tool'}) RETURN count(n) AS cnt`),
  systems: await count(`MATCH (n:System) RETURN count(n) AS cnt`),
  systemsStillResource: await count(`MATCH (n:System) WHERE n:Resource OR n:Artifact RETURN count(n) AS cnt`),
  requiresRemaining: await count(`MATCH (:Output)-[r:REQUIRES]->(:System) RETURN count(r) AS cnt`),
  servesFromSystems: await count(`MATCH (:System)-[r:SERVES]->(:Output) RETURN count(r) AS cnt`),
  dependsOn: await count(`MATCH (:System)-[r:DEPENDS_ON]->() RETURN count(r) AS cnt`),
  flowsTo: await count(`MATCH (:System)-[r:FLOWS_TO]->() RETURN count(r) AS cnt`),
};
console.log("After: ", after);

const ok =
  after.toolsRemaining === 0 &&
  after.systemsStillResource === 0 &&
  after.systems === before.tools + before.systems &&
  after.requiresRemaining === 0;
console.log(ok ? "\n✓ Migration verified." : "\n✗ Verification FAILED — inspect the graph.");

await closeDriver();
