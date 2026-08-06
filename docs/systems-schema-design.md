# Design Spec — Describing Software & Hardware Systems in ESIM

Status: **Proposed** (design only; no code changes yet)
Author: Nate McNeil
Scope: extend ESIM so an agent (or a person) can *describe* software/hardware systems
— their composition, dependencies, data flows, and hardware substrate — richly enough
to answer diagnostic questions like *"where is the bottleneck in this ETL pipeline?"*
by **ad-hoc traversal**, not a purpose-built diagnostic query.

---

## 1. Goal & non-goals

**Goal.** Make a system — a service, pipeline, datastore, host, device — a
first-class citizen of the graph, plugged into the *same* intent + calibration
machinery ESIM already runs on people, teams, and tools. Once the topology and
declared intent are in the graph, an autonomous agent can walk it to reason about
bottlenecks, blast radius, and root cause without any bespoke query.

**In scope**
- A `System` entity type — one new label, physically an `Agent` sub-label
  (`Entity:Agent:System`). This is the *only* new structural discriminator.
- Three new relationship types: `DEPENDS_ON`, `FLOWS_TO`, `RUNS_ON`.
- Conventions for reusing `Stock`, `Signal`, `Resource`, `Constraint`, `Discrepancy`
  to describe system *state* and *intent*.
- Reconciling the `org` plugin onto `System` as the single representation of a
  technical system (replacing its `Resource{tool}` convention). See §7.

**Out of scope (deliberately)**
- **No `system_type` / no `agent_type: "system"`.** The `:System` label is the
  discriminator; a system's *kind* (service/pipeline/datastore/host/device) and the
  *software-vs-hardware* distinction are read from structure and semantic search, not
  a governed enum. See §3.3 and §8 for the rationale and the later-upgrade path.
- No bottleneck/diagnostic Cypher query. Diagnosis is done by traversal + reasoning.
- No new *node* labels (no `Metric`, `Incident`, `Interface`). Reuse primitives.
- No time-series / observability storage. Neo4j is not a TSDB (see §7).

---

## 2. Design principles

1. **A system acts with intent, so it's an `Agent`.** The README's intent frame
   already applies to "a person, team, project, **tool**, or role." A pipeline
   exists *to do something for someone* — it has purpose edges, needs, resources,
   and constraints. Modeling it as an `Agent` sub-label means every existing
   traversal, the `:Entity` vector index, `get_context`, and every diagnostic work
   on systems for free.

2. **Reuse over new labels.** New node labels fragment the ontology and forfeit the
   free vector index + diagnostic reuse. The only genuinely missing pieces are the
   *connective edges* systems have that org entities don't (dependency, flow,
   deployment). So we add one label (`:System`) and three relationships — and no
   governed type prop; kind is read from structure (§3.3).

3. **A "bottleneck" is a calibration result, not a new concept.** ESIM already
   frames every symptom as declared-intent vs. observed-reality → `Discrepancy`.
   A bottleneck is the classic Theory-of-Constraints signature — work piling up
   before a stage (`Stock` accumulating) while the stage below it starves
   (`Stock` depleting) — expressed in primitives that already exist.

4. **ESIM is the map, not the monitor.** It holds topology, declared intent, and
   *summarized* state. Live metrics stay in Prometheus/Datadog/logs. See §7.

---

## 3. Schema additions

### 3.1 `System` entity type — the one new discriminator

`System` becomes a createable entity type that is physically an `Agent`, so it
inherits Agent semantics and the entity vector index. **The label is the whole
discriminator** — there is no `system_type` prop and no `agent_type: "system"`
value (see §3.3 for why, §8 for the later-upgrade path).

**`src/types.ts`** — add to `ENTITY_LABELS`:

```ts
export const ENTITY_LABELS = [
  "Agent",
  "System",   // ← new; physically an Agent sub-label (see LABEL_MAP)
  "Need",
  "Resource",
  "Constraint",
  "Output",
  "Role",
] as const;
```

Add a `SystemNode` interface. It mirrors `AgentNode` (a System *is* an Agent) and
adds nothing that governs kind — kind is structural:

```ts
export interface SystemNode extends BaseNode, EmbeddableNode {
  name: string;
  content?: string;            // free-text description ("Airflow DAG, batch, us-east")
  capacity?: number;           // inherited Agent notion (e.g. worker slots)
  is_root?: boolean;
}
```

**`src/queries.ts`** — add to `LABEL_MAP` (mirrors `Role: "Entity:Role"`):

```ts
const LABEL_MAP: Record<string, string> = {
  Agent: "Entity:Agent",
  System: "Entity:Agent:System",   // ← new
  Need: "Entity:Artifact:Need",
  // …unchanged…
};
```

Because the physical label set includes `:Agent`, existing Agent diagnostics
(`overloaded_agents`, `missing_purpose`, etc.) automatically include systems, and
`agent_type` stays clean — it keeps meaning "kind of intentional actor"
(person/team/org/ai), never getting overloaded with infrastructure kinds. Because
the label set includes `:Entity`, the `entity_embeddings` vector index covers
systems, so `search` finds them by natural language with no extra wiring. To scope
a query to systems only: `MATCH (n:System)`; to exclude them from org queries:
`MATCH (a:Agent) WHERE NOT a:System`.

**Extraction is skipped for free.** `shouldSkipExtraction` (`src/llm.ts`) returns
`true` for any node type absent from `REQUIRED_EXTRACTION_FIELDS`. Leaving `System`
out of that map means `create_entity System {…}` deterministically **skips the
intent-tuned LLM metadata pass** — correct, since system data isn't personal-intent
data — with no forced discriminator prop. This is the mechanical reason `System`
needs no `agent_type`/`system_type` to stay clean, unlike `Agent` (which must set
`agent_type` to skip extraction). No change to `llm.ts` is required.

### 3.2 New relationship types

**`src/types.ts`** — append to `RELATIONSHIP_TYPES`:

```ts
  // …existing…
  "DEPENDS_ON",
  "FLOWS_TO",
  "RUNS_ON",
```

Adding them here is sufficient: `create_relationship`, `delete_relationship`, the
`traverse` filter, and `batch_create_relationships` all gate on
`z.enum(RELATIONSHIP_TYPES)`, so the new types become usable across every tool.

| Rel | Direction (from → to) | Meaning | Suggested edge props |
|-----|----------------------|---------|----------------------|
| `DEPENDS_ON` | System → System \| Resource | A needs B to function; drives blast-radius & root-cause | `dependency_type`: `runtime`\|`buildtime`\|`data`\|`config`; `criticality`: `hard`\|`soft` |
| `FLOWS_TO` | System \| Output → System | Directed data/control movement; **where bottlenecks live** | `payload`: what moves; `mode`: `batch`\|`stream`\|`sync`\|`async`; `volume`: free text/number |
| `RUNS_ON` | System (software) → System (`host`/`device`) | Deployment substrate — the software/hardware bridge | `environment`: `prod`\|`staging`\|`dev`; `region` |

Edge props are optional and free-form (relationships accept a `properties` map);
the table is convention, not enforced schema — consistent with how ESIM treats
`PURPOSE`/`CONTAINS` props today.

**Why these three and no more:**
- `CONTAINS` (existing, with `order`) already models a pipeline's *internal*
  ordered stages. `FLOWS_TO` models flow *across independent systems* — the thing
  `CONTAINS` can't express and where cross-system bottlenecks appear.
- `DEPENDS_ON` is the dependency graph — distinct from flow (a service can depend
  on a config store it never streams data to).
- `RUNS_ON` is deployment, orthogonal to both.

### 3.3 Kind and software-vs-hardware come from structure, not a prop

ESIM's headline principle is that *structure lives on edges, not in properties*.
A system's kind is legible without any enum:

- **software vs. hardware** — hardware is whatever `RUNS_ON` points *to*; a node
  with an outbound `RUNS_ON` is software. That edge *is* the bridge.
- **pipeline vs. stage** — a pipeline has outbound `CONTAINS`; a stage has inbound
  `CONTAINS`.
- **datastore / endpoint** — a sink/source on `FLOWS_TO` with no `CONTAINS`.
- **"find the datastores / the caches"** — the node's `name`/`content` + the entity
  vector index (`search`) handles fuzzy kind lookup with no extra wiring.

The two distinctions structure *can't* give you — `host` vs. `device`, or `cache`
vs. `warehouse` (identical edge shapes) — are deferred deliberately; §8 covers the
zero-migration way to add a discriminator later *if* a concrete query demands it.

### 3.4 Reusing existing primitives (no new nodes)

| Systems concept | ESIM primitive | Convention |
|---|---|---|
| Ordered stages of a pipeline | `CONTAINS` + `order` | `pipeline -[:CONTAINS {order}]-> stage` |
| Declared throughput / SLA | `Need` or `Constraint(mechanics)` + `PURPOSE` edge | the target the system exists to hit |
| Stage capacity (workers, connections, CPU) | `Resource(resource_type: "capacity")` + `SERVES` | the denominator in `(N+R)/C = Output` |
| **Queue depth / lag / backlog** | `Stock` (`level`, `max`, `trend`) + `HAS_STOCK` | **the bottleneck signal** |
| A measurement / spike / error observation | `Signal` (`observation`, `system_interpretation`) + `SIGNALS` | point-in-time evidence |
| The bottleneck itself | `Discrepancy` (altitude `mechanics`/`approach`) | declared throughput vs. observed function |

Nothing here is new schema — it's a documented way of using nodes ESIM already has.

---

## 4. Worked example — an analytics ETL pipeline

Modeling the **Unified Analytics ETL** end to end with the additions above. Tool
calls are shown as `create_entity` / `create_relationship` / `create_signal`
(the MCP surface).

### 4.1 The system and its stages

```
create_entity System  { name: "Unified Analytics ETL", content: "batch ELT, hourly" }    → etl
create_entity System  { name: "Extract",   content: "pulls raw rows from source" }        → extract
create_entity System  { name: "Transform", content: "dbt models" }                        → transform
create_entity System  { name: "Load",      content: "writes to warehouse" }               → load

create_relationship etl -CONTAINS {order:1}-> extract
create_relationship etl -CONTAINS {order:2}-> transform
create_relationship etl -CONTAINS {order:3}-> load
```

> Kind is legible from structure: `etl` is a *pipeline* (it has outbound
> `CONTAINS`); `extract`/`transform`/`load` are *stages* (inbound `CONTAINS`). No
> `system_type` prop needed.

### 4.2 Flow, dependencies, and substrate

```
create_entity System { name: "App Postgres (source)", content: "OLTP source db" }         → pg
create_entity System { name: "Snowflake (warehouse)", content: "analytics warehouse" }    → wh
create_entity System { name: "Looker",                content: "BI / dashboards" }        → bi
create_entity System { name: "Airflow worker cluster",content: "k8s node pool (hw)" }     → cluster
create_entity Resource { name: "Transform worker pool", resource_type: "capacity" }       → pool

# data flow (bottlenecks live on this chain)
create_relationship pg        -FLOWS_TO {mode:"batch", payload:"raw rows"}-> extract
create_relationship extract   -FLOWS_TO {mode:"batch"}-> transform
create_relationship transform -FLOWS_TO {mode:"batch"}-> load
create_relationship load      -FLOWS_TO {mode:"batch"}-> wh
create_relationship wh        -FLOWS_TO {mode:"sync"}->  bi

# dependencies (distinct from flow)
create_relationship etl       -DEPENDS_ON {dependency_type:"data", criticality:"hard"}-> pg
create_relationship transform -DEPENDS_ON {dependency_type:"runtime"}-> pool

# deployment (software → hardware bridge; `cluster` is hardware because it is a RUNS_ON target)
create_relationship etl -RUNS_ON {environment:"prod", region:"us-east"}-> cluster

# capacity resource serving the constrained stage
create_relationship pool -SERVES-> transform
```

### 4.3 Declared intent and observed state

```
# declared throughput (intent)
create_entity Need { name: "Freshness SLA", content: "Warehouse current within 30 min" } → sla
create_relationship etl -PURPOSE {purpose_type:"transform"}-> sla

# observed state — the bottleneck signature
create_entity Stock { name: "Transform queue depth", level: 9500, max: 10000,
                      trend: "accumulating" }                                             → q
create_relationship q -HAS_STOCK-> transform

create_entity Stock { name: "Load input buffer", level: 40, max: 5000,
                      trend: "depleting" }                                                → lb
create_relationship lb -HAS_STOCK-> load

create_signal { observation: "Transform p95 runtime 45m, up from 12m last week",
                system_interpretation: "Transform is the constraining stage",
                confidence: "high" } SIGNALS transform
```

The graph now literally *shows* the bottleneck: the queue **before** Transform is
saturated and accumulating; the buffer **after** it is starved and depleting; a
capacity `Resource` serves Transform; a `Signal` explains why.

---

## 5. Answering "where's the bottleneck?" by traversal

No dedicated query. An agent resolves it with the standard tools:

1. **Resolve the system** — `search "Unified Analytics ETL"` → `etl` (works via the
   entity vector index, since System is `:Entity`).
2. **Get the ordered stages** — `traverse etl, relationship_types:["CONTAINS"], depth:1`
   → Extract, Transform, Load (with `order`).
3. **Inspect state per stage** — `traverse <stage>, relationship_types:["HAS_STOCK"]`
   and read `Stock.trend` / `level`÷`max`. The accumulating, near-max stock (Transform
   queue) is the constraint.
4. **Confirm the signature** — follow `FLOWS_TO` downstream; a depleting buffer at
   `Load` confirms starvation below the constraint.
5. **Explain it** — `traverse <stage>, relationship_types:["SIGNALS"]` (or
   `get_context`) surfaces the runtime-regression Signal and the capacity `Resource`.
6. **Optionally record the finding** — create a `Discrepancy` (declared 30-min SLA
   vs. observed 45-min transform) so the conclusion persists and calibrates the graph.

Blast-radius and root-cause use the same primitives from the other direction:
`traverse <failed system>, relationship_types:["DEPENDS_ON"], direction:"in"` finds
everything that would break; `direction:"out"` finds what to suspect upstream.

---

## 6. Compatibility & migration

The ESIM *core* change is additive and safe. The *org-plugin convention* change is
not — systems move from `Resource{tool}` to `System`, so existing org data must be
re-labeled or re-onboarded. That trade was accepted deliberately: a system that is
a first-class actor (diagnosable via the calibration engine) is worth more than
preserving the current node representation.

**ESIM core — additive, non-breaking:**
- New enum members (`System`, `DEPENDS_ON`, `FLOWS_TO`, `RUNS_ON`) + one
  `LABEL_MAP` entry. Existing nodes, edges, indexes, and queries are untouched.
- No re-index / no schema-setup change. `System` reuses `entity_embeddings` (it's
  `:Entity`) and `entity_id_unique`. (`schemaSetupQueries` stays as-is.)
- Server surface propagates automatically through the `z.enum` Zod validators; no
  per-tool edits. No `llm.ts` edit (extraction auto-skips, §3.1).
- Core change is ~1 interface + 2 enum edits + 1 `LABEL_MAP` line, plus tests.

**Org data — one-time migration (see §7 for the convention changes):**
- Existing `Resource{resource_type:"tool"}` system nodes → re-labeled to `System`
  (a `SET`/`REMOVE LABEL` Cypher pass), or simpler given the small graph, wiped and
  re-run through `/org:onboard` + `/org:tech`.
- Edges rewired per §7 (notably `Output -REQUIRES-> Resource(tool)` becomes
  `System -SERVES-> Output`, and `RELATED_TO "depends on"` becomes `DEPENDS_ON`).

---

## 7. Integration with the org plugin (the reconciliation)

`org:tech` and its sibling skills already model "a technical system," as
`Resource{resource_type:"tool"}`. This design makes `System` the single
representation, so the org plugin adopts it. Changes are convention/doc edits, not
code. The `Resource{tool}` convention appears in six places: `shared/mapping-
reference.md` (source of truth) and the `tech`, `product`, `onboard`, `lookup`
skills, plus the plugin `README.md`.

### 7.1 `shared/mapping-reference.md` (source of truth)

| Row | Before | After |
|-----|--------|-------|
| Technical system / app / service | `Resource` + `resource_type:"tool"` | **`System`** (no required prop; extraction auto-skips) |
| Hardware — host / server / cluster / device | *(not modeled)* | **`System`**; identified as hardware by being a `RUNS_ON` target |
| Products that are also apps | `Output -REQUIRES-> Resource(tool)` | `System -SERVES-> Output` (the running system *serves* the product) |
| Product depends on a system | `Output -REQUIRES-> Resource` | `System -SERVES-> Output` (same edge as above) |
| System depends on / integrates with another | `RELATED_TO {"depends on"/"integrates with"}` | **`DEPENDS_ON`** (hard dep; add `criticality`), **`FLOWS_TO`** (data exchange), **`RUNS_ON`** (→ host) |
| Team owns / governs a system | `OWNS`/`GOVERNS` → `Resource` | `OWNS`/`GOVERNS` → `System` (unchanged edge, new target label) |
| System documented by | `System -RELATED_TO-> Resource(knowledge)` | unchanged (docs stay `Resource{knowledge}`) |

Also update "Fields that must always be set": `System` needs none.

### 7.2 Skill edits

- **`tech/SKILL.md`** — dedup-gate against `System` (not `Resource{tool}`);
  `create_entity System {name, content}`; §2 dependencies use `DEPENDS_ON` /
  `FLOWS_TO` / `RUNS_ON` instead of stringly-typed `RELATED_TO "depends on"`. This
  is the skill you asked about, and it's the largest single edit.
- **`product/SKILL.md`** — "systems this product runs on" dedup-gates a `System`;
  the product-that's-also-an-app pattern becomes `System -SERVES-> Output`.
- **`onboard/SKILL.md`** — system stubs are `System`, not `Resource{tool}`.
- **`lookup/SKILL.md`** — "what does X depend on?" traverses `DEPENDS_ON`
  (and `REQUIRES` for products), dropping the `RELATED_TO`-string filtering hack.
- **`README.md`** (plugin) — refresh the model description.

`ingest/SKILL.md` needs no change (it stages Signals, label-agnostic).

### 7.3 A note the org plugin should keep

The plugin's "Where this diverges from ESIM's ideology" section already notes that
purpose-oriented diagnostics (`missing_purpose`, etc.) fire on org Agents as
expected noise. Systems are now Agents too, so the same note covers them — no new
caveat needed.

---

## 8. The one boundary worth holding: map, not monitor

ESIM should store **topology + declared intent + summarized state**, not raw
metrics. Neo4j is not a time-series DB, and duplicating observability into it would
be a worse Datadog. The intended division of labor:

- **ESIM holds:** components, `FLOWS_TO`/`DEPENDS_ON`/`RUNS_ON`, purpose/SLA, and
  *current* `Stock` trends + recent `Signal`s.
- **Prometheus/Datadog/logs hold:** raw time series.
- **The agent loop:** pull live metrics → write them as `Stock` updates + `Signal`s
  against the modeled topology → reason over the graph → record `Discrepancy`s.

This keeps ESIM doing the thing nothing else does — structured reasoning over
topology *and* intent — instead of half-reinventing monitoring.

---

## 9. Deferred: a kind discriminator, if structure proves insufficient

This design intentionally ships **no** `system_type` / `agent_type: "system"`.
Kind and software-vs-hardware are read from structure and semantic search (§3.3).
That covers reasoning use cases (bottlenecks, blast radius, root cause). It does
*not* cleanly separate the two distinctions with identical edge shapes — `host`
vs. `device`, or `cache` vs. `warehouse`.

**Add a discriminator only when a concrete query needs one** — e.g. an asset
inventory that must list hardware devices, or capacity planning that treats caches
differently from warehouses. When that day comes, the cheapest correct move is a
single optional prop on `SystemNode`:

```ts
system_type?: "service" | "pipeline" | "job" | "datastore"
            | "library" | "host" | "device";   // add later, if needed
```

This is **non-breaking and zero-migration**: existing `System` nodes simply lack
the prop, and nothing reads it until you choose to. Fold nothing into `agent_type`
— keep that enum meaning "kind of intentional actor." Prefer this over a governed
enum you have to teach and keep consistent before you have a query that reads it.

## 10. Open questions

1. **Should `FLOWS_TO` carry live volume?** Convention allows a `volume` prop, but
   per §7 that should be a *summarized* figure refreshed by the agent, not a metric
   stream.
2. **Do we want a `System` deep-dive skill** (like `org:tech`) to guide modeling a
   system end-to-end? Likely yes, as a follow-up.
