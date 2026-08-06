---
name: diagnose
description: Model a technical system's operational structure — pipeline stages, data flows, capacity, and live state — then diagnose it by traversal: bottlenecks, blast radius, root cause. The runtime counterpart to /org:tech (which covers org-relations). Use when you need to get to the bottom of a performance or reliability issue, or design a change, on a system already in the graph.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__traverse, mcp__esim__get_context, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__capture, mcp__esim__create_signal, mcp__esim__stats]
---

# Org Diagnose

You are building the **operational** view of one technical system — its internal composition, how data moves through it, where its capacity is, and its current state — and then using that graph to answer diagnostic questions: *where's the bottleneck, what breaks if this fails, what's the root cause.*

This is the runtime counterpart to [`/org:tech`](../tech/SKILL.md). `tech` captures a system's *org-relations* (who owns it, what products it powers, where docs live); `diagnose` captures how the system *works and behaves*. They operate on the same `System` node — run `tech` for the relational profile, `diagnose` when you need to reason about performance or reliability.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines the `System` node, the `DEPENDS_ON`/`FLOWS_TO`/`RUNS_ON` edges, and the dedup gate used below.

## What makes this skill different

It is the one skill in this plugin that engages ESIM's **calibration primitives** — `Stock`, `Signal`, `Discrepancy`. The other org skills deliberately skip them (see "Where this diverges from ESIM's ideology" in the mapping reference); here they're the point, because diagnosis *is* comparing declared intent against observed state.

**Boundary — map, not monitor.** ESIM holds the *topology* and a *summarized snapshot* of state, not raw time-series. Don't try to stream metrics into it. The loop is: pull current numbers from your real observability stack (Prometheus/Datadog/logs) → write them here as `Stock` levels/trends and `Signal`s → reason over the graph. Refresh the snapshot when you diagnose; don't accumulate a metric history.

## Find-or-create the system

Run the dedup gate against `System` nodes. If `/org:onboard` or `/org:tech` already created it, **enrich that node** — `get_node` on it first to see what structure already exists so you don't rebuild it. If genuinely new: `create_entity System {name, content}`.

---

## Part A — Model the operational structure

Skip anything already modeled. Build only as deep as the question needs — you don't have to model every stage of every system, just the part you're diagnosing.

### 1. Decompose into stages

If the system is a pipeline or multi-step process, create each stage as its own `System` node and wire ordered composition:

```
create_entity System {name:"Extract", content:"…"}      → extract
create_entity System {name:"Transform", content:"…"}    → transform
create_entity System {name:"Load", content:"…"}         → load
batch_create_relationships:
  etl -CONTAINS {order:1}-> extract
  etl -CONTAINS {order:2}-> transform
  etl -CONTAINS {order:3}-> load
```

The `order` is what makes the sequence legible later. A stage with inbound `CONTAINS` is a stage; the parent with outbound `CONTAINS` is the pipeline — no type prop needed.

### 2. Wire the data flow

`FLOWS_TO` is where bottlenecks live — directed data movement, including across system boundaries (source db → pipeline → warehouse → BI). Wire the chain, setting `mode` (`batch`/`stream`/`sync`/`async`):

```
pg -FLOWS_TO {mode:"batch", payload:"raw rows"}-> extract
extract -FLOWS_TO {mode:"batch"}-> transform
transform -FLOWS_TO {mode:"batch"}-> load
load -FLOWS_TO {mode:"batch"}-> warehouse
```

Dedup-gate each external system (`pg`, `warehouse`) as its own `System` — link, don't fully build it out here.

### 3. Capacity and substrate (as relevant)

- **Capacity** — the resource a stage can saturate (worker pool, connection limit, CPU). `create_entity Resource {name, resource_type:"capacity"}` then wire `Resource -SERVES-> stage`. This is the denominator a bottleneck saturates.
- **Substrate** — the hardware a system runs on: `System -RUNS_ON-> host` (the host is itself a `System`; being a `RUNS_ON` target is what marks it as hardware).
- **Dependencies** — anything the system breaks without: `System -DEPENDS_ON-> other {criticality:"hard"|"soft"}`.

---

## Part B — Capture current state

State is what you diagnose against. Model it only for the stages in question.

### Stock — the accumulation signal

A `Stock` is the running level of something that can pile up or drain: queue depth, backlog, lag, buffer fill. It's a non-entity node, so create it via `capture`, then set its numbers with `update_node`, then wire it:

```
capture {content:"Transform queue depth", hints:{node_type:"Stock", name:"Transform queue depth"}}   → q
update_node {id:q, properties:{level:9500, max:10000, trend:"accumulating"}}
create_relationship q -HAS_STOCK-> transform
```

`trend` is one of `accumulating` | `depleting` | `stable` | `never_established`. The **bottleneck signature** is a stock `accumulating` (and near `max`) *upstream* of a stage while the buffer *downstream* is `depleting` — work piling up before the constraint, starving after it.

### Signal — the explanatory observation

Point-in-time evidence (a latency spike, an error-rate jump, a runtime regression) attaches to the stage it's about:

```
create_signal {
  observation:"Transform p95 runtime 45m, up from 12m last week",
  signals_entity_id: transform,
  properties:{confidence:"high", perceived_impact:"high", how_observed:"reported"}
}
```

Signals explain *why* a stock is moving; a depleting/accumulating stock with no connected signal is an open question, not a finding.

---

## Part C — Diagnose by traversal

There is no purpose-built diagnostic query — you walk the graph you just built.

### Bottleneck ("where is this pipeline constrained?")

1. Resolve the system → `traverse {relationship_types:["CONTAINS"], direction:"outgoing"}` for the ordered stages.
2. For each stage → `traverse {relationship_types:["HAS_STOCK"]}`; read `level ÷ max` and `trend`. The accumulating, near-max stock is the constraint.
3. Confirm the signature → follow `FLOWS_TO` downstream; a `depleting` buffer below the suspect stage confirms starvation.
4. Check saturation → `traverse {relationship_types:["SERVES"], direction:"incoming"}` to the capacity `Resource`; a saturated capacity at the same stage is the mechanism.
5. Explain it → `traverse {relationship_types:["SIGNALS"], direction:"incoming"}` on the stage for the evidence.

### Blast radius ("what breaks if this fails?")

Resolve the system → `traverse {relationship_types:["DEPENDS_ON"], direction:"incoming", max_depth:3}` — everything that depends on it, transitively. Follow `FLOWS_TO` incoming for what stops receiving data.

### Root cause ("why is this failing?")

Resolve the failing system → `traverse {relationship_types:["DEPENDS_ON","FLOWS_TO","RUNS_ON"], direction:"outgoing"}` — what it needs, feeds from, and runs on — then check each for its own accumulating stocks and recent signals. Walk outward until the evidence stops pointing further upstream.

### Record the finding (optional)

Persist a conclusion so it calibrates the graph rather than evaporating. A `Discrepancy` is the gap between declared intent and observed state (e.g. declared 30-min freshness SLA vs. observed 45-min transform):

```
capture {content:"Transform stage misses freshness SLA — 45m vs 30m target",
         hints:{node_type:"Discrepancy", name:"Transform SLA miss"}}          → d
update_node {id:d, properties:{altitude:"mechanics"}}
create_relationship d -AFFECTS-> transform
```

## Confirm

Echo back a compact summary of what you modeled (stages, flows, stocks, signals) and what you concluded (the ranked bottleneck / blast radius / root cause), with the node names and the evidence each conclusion rests on. End with `get_node` on the system so the resulting operational profile is visible.
