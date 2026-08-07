// Retrieval eval: how far down the results does the correct node sit?
//
// Run: deno run --allow-net --allow-env --allow-read --allow-sys scripts/eval-retrieval.ts
//
// Exists because embedding changes are easy to ship and hard to judge by eye.
// Swapping models, changing truncation, or adding a query prefix all move
// ranking in ways a couple of spot-check searches will not reveal — the change
// that motivated this harness improved two queries dramatically while making a
// third noticeably worse, which eyeballing would have missed entirely.
//
// Compares the configured query path (see formatQueryForEmbedding) against raw
// unprefixed queries, so the value of the prefix is visible rather than assumed.
//
// CAVEATS, read before trusting a number here:
//  - The cases below are hand-written against THIS graph, and both the queries
//    and the "correct" answers are judgment calls by their author.
//  - Two cases were added precisely because they were observed failing, which
//    biases any before/after comparison in favour of the fix.
//  - n is small. Treat a shift of one or two ranks as noise; look for misses
//    (>K) turning into hits, or vice versa.

import { runQuery, closeDriver } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { formatQueryForEmbedding, getEmbedding, getLlmConfig } from "../src/llm.ts";

await loadEnv();
const config = getLlmConfig();

const ID = {
  gas: "6c0ba12f-ff90-4c7d-9f78-66822c5cfe38",
  spike: "c03782e1-017e-4f45-95de-d16fccee4512",
  adr: "990f1500-6d5d-47cd-af85-b901614f4e8b",
  keycloak: "5f98d3ba-867f-4205-95ef-71537da96312",
  printavoApp: "354c855d-11e4-49ba-924a-4abf3de0a1ce",
  redis: "2a1fc085-55f3-4b96-b00e-4ce6cadfe866",
  userService: "b7c7a620-f853-4786-88d5-0c74fee18c09",
  authApp: "4af65dc9-c9b2-425c-8c6e-7fc84e0e9a2f",
  ownership: "c0214561-a2bc-46a2-b475-390bf7ffd9a6",
  apiGateway: "ec89771c-dbe3-40ec-8c64-b96789caf5e2",
  honeybadger: "9e11e3b5-e782-4fe5-809a-637445c306f4",
  stripe: "dc0c5835-8d8f-45ba-b648-ebe3e563fa60",
  prin: "aa130b80-5b77-43e2-befe-10476f68cfb7",
  quickbooks: "1099335c-56e4-4bd2-be19-0f471556387d",
  auth0: "3a2acaf1-0867-4f67-bbf7-dc925489f81e",
  s3: "02855406-0889-4fee-8116-a480bd7e6994",
};

/** `ok` lists every node id that would be a defensible top hit. */
const CASES: { q: string; ok: string[] }[] = [
  { q: "GAS AppType Inktavo Auth0 Organization Mission Control provisioning", ok: [ID.gas] },
  { q: "Which service holds canonical account identity across products?", ok: [ID.gas] },
  { q: "How much effort to put Printavo on Auth0?", ok: [ID.spike] },
  { q: "Auth0 Printavo authentication spike effort estimate", ok: [ID.spike] },
  { q: "What identity platform did Inktavo choose, and why?", ok: [ID.adr, ID.keycloak] },
  { q: "Where are Printavo browser sessions stored?", ok: [ID.printavoApp, ID.redis] },
  { q: "Which OMG service signs the JWTs the API gateway trusts?", ok: [ID.userService, ID.apiGateway] },
  { q: "What handles OIDC callbacks and logout for OrderMyGear apps?", ok: [ID.authApp] },
  { q: "Which team owns the Airflow and Looker data stack?", ok: [ID.ownership] },
  { q: "What error tracking does Printavo use?", ok: [ID.honeybadger] },
  { q: "Which payment processor handles Printavo subscriptions?", ok: [ID.stripe] },
  { q: "Where is Printavo's operational runbook documentation?", ok: [ID.prin] },
  { q: "What accounting system does Printavo sync orders to?", ok: [ID.quickbooks] },
  { q: "Which repo manages Auth0 tenants as infrastructure as code?", ok: [ID.auth0] },
  { q: "Where does Printavo store uploaded artwork and proofs?", ok: [ID.s3] },
  { q: "How does Printavo isolate one print shop's data from another?", ok: [ID.printavoApp] },
  { q: "What is the external API edge in front of OMG services?", ok: [ID.apiGateway] },
];

const K = 20;

async function rankOf(text: string, ok: string[]): Promise<number | null> {
  const embedding = await getEmbedding(text);
  const rows = await runQuery<{ id: string }>({
    cypher: `CALL db.index.vector.queryNodes('entity_embeddings', $k, $embedding)
             YIELD node, score RETURN node.id AS id ORDER BY score DESC`,
    params: { k: K, embedding },
  });
  const idx = rows.findIndex((r) => ok.includes(r.id));
  return idx === -1 ? null : idx + 1;
}

const configured = formatQueryForEmbedding("probe") !== "probe";
console.log(`model: ${config.embeddingModel}  |  k=${K}  |  ${CASES.length} queries`);
console.log(`query prefix: ${configured ? "ON" : "off"} (see formatQueryForEmbedding)\n`);
console.log("query".padEnd(52) + "  raw  configured");
console.log("─".repeat(72));

const rawRanks: (number | null)[] = [];
const cfgRanks: (number | null)[] = [];
const fmt = (x: number | null) => (x === null ? `>${K}`.padStart(4) : String(x).padStart(4));

for (const c of CASES) {
  const raw = await rankOf(c.q, c.ok);
  const cfg = await rankOf(formatQueryForEmbedding(c.q), c.ok);
  rawRanks.push(raw);
  cfgRanks.push(cfg);
  const flag = (cfg ?? Infinity) < (raw ?? Infinity) ? "  +" : (cfg ?? Infinity) > (raw ?? Infinity) ? "  -" : "";
  console.log(c.q.slice(0, 50).padEnd(52) + fmt(raw) + "  " + fmt(cfg) + flag);
}

// Explicit accumulator type: reduce would otherwise infer `number | null`
// from the array's element type and reject the arithmetic.
const mrr = (rs: (number | null)[]) =>
  rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / rs.length;
const hits = (rs: (number | null)[], n: number) => rs.filter((r) => r !== null && r <= n).length;
const miss = (rs: (number | null)[]) => rs.filter((r) => r === null).length;

console.log("─".repeat(72));
console.log(`MRR@${K}`.padEnd(52) + mrr(rawRanks).toFixed(3).padStart(6) + mrr(cfgRanks).toFixed(3).padStart(6));
console.log("top-1".padEnd(52) + String(hits(rawRanks, 1)).padStart(6) + String(hits(cfgRanks, 1)).padStart(6));
console.log(`missed (>${K})`.padEnd(52) + String(miss(rawRanks)).padStart(6) + String(miss(cfgRanks)).padStart(6));

let better = 0, worse = 0;
for (let i = 0; i < CASES.length; i++) {
  const r = rawRanks[i] ?? Infinity, c = cfgRanks[i] ?? Infinity;
  if (c < r) better++; else if (c > r) worse++;
}
console.log(`\nconfigured vs raw: better ${better}, worse ${worse}, tied ${CASES.length - better - worse}`);
if (worse > 0) {
  console.log("Note: regressions are expected on some well-formed questions; judge on the aggregate.");
}

await closeDriver();
