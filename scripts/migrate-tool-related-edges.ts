// Follow-on to migrate-tools-to-system.ts: convert the descriptive RELATED_TO
// edges on System nodes that clearly express a typed system relationship, where
// the typed edge is both type-correct and preserves the original meaning.
//
//   System -RELATED_TO{"builds on"}-> Resource(PromoStandards)  → DEPENDS_ON {data, hard}   ×2
//   Claude Code -RELATED_TO{"used to create tickets in"}-> JIRA → FLOWS_TO {sync, "tickets"} ×1
//
// Left as RELATED_TO (decision/adoption/governance notes, or endpoint type-mismatch):
//   auth-app->Auth0 "deferred…", Framework->Claude Cowork "first approved platform under",
//   UAP->OneSource "first consuming product…", UAP->DC "replaces DC's legacy analytics",
//   Discover->DC "pulls paid placement data from" (Output endpoint → FLOWS_TO doesn't fit).
//
// Atomic transaction — rolls back on any failure. Back up first (scripts/backup.ts).

import { loadEnv } from "../src/env.ts";
import { runQuery, runInTransaction, closeDriver } from "../src/db.ts";

await loadEnv();

const count = async (cypher: string): Promise<number> => {
  const r = await runQuery<{ cnt: number }>({ cypher, params: {} });
  return (r[0]?.cnt as number) ?? 0;
};

const before = {
  buildsOn: await count(`MATCH (:System)-[r:RELATED_TO]->(:Resource {name:'PromoStandards'}) WHERE r.relationship_description='builds on' RETURN count(r) AS cnt`),
  tickets: await count(`MATCH (:System {name:'Claude Code'})-[r:RELATED_TO]->(:System {name:'JIRA'}) WHERE r.relationship_description='used to create tickets in' RETURN count(r) AS cnt`),
};
console.log("Before:", before);

await runInTransaction([
  // "builds on" an industry data standard → typed data dependency.
  {
    cypher: `MATCH (s:System)-[r:RELATED_TO]->(x:Resource {name:'PromoStandards'})
WHERE r.relationship_description = 'builds on'
MERGE (s)-[d:DEPENDS_ON]->(x)
SET d.dependency_type = 'data', d.criticality = 'hard'
DELETE r`,
    params: {},
  },
  // "used to create tickets in" → data/command flow, preserving the payload detail.
  {
    cypher: `MATCH (s:System {name:'Claude Code'})-[r:RELATED_TO]->(j:System {name:'JIRA'})
WHERE r.relationship_description = 'used to create tickets in'
MERGE (s)-[f:FLOWS_TO]->(j)
SET f.mode = 'sync', f.payload = 'tickets'
DELETE r`,
    params: {},
  },
]);

const after = {
  buildsOnRemaining: await count(`MATCH (:System)-[r:RELATED_TO]->(:Resource {name:'PromoStandards'}) WHERE r.relationship_description='builds on' RETURN count(r) AS cnt`),
  ticketsRemaining: await count(`MATCH (:System {name:'Claude Code'})-[r:RELATED_TO]->(:System {name:'JIRA'}) WHERE r.relationship_description='used to create tickets in' RETURN count(r) AS cnt`),
  dependsOnData: await count(`MATCH (:System)-[r:DEPENDS_ON {dependency_type:'data'}]->(:Resource {name:'PromoStandards'}) RETURN count(r) AS cnt`),
  flowsToTickets: await count(`MATCH (:System {name:'Claude Code'})-[r:FLOWS_TO]->(:System {name:'JIRA'}) RETURN count(r) AS cnt`),
};
console.log("After: ", after);

const ok =
  after.buildsOnRemaining === 0 &&
  after.ticketsRemaining === 0 &&
  after.dependsOnData === before.buildsOn &&
  after.flowsToTickets === before.tickets;
console.log(ok ? "\n✓ Edge conversion verified." : "\n✗ Verification FAILED — inspect the graph.");

await closeDriver();
