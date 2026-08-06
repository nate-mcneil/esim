---
name: tech
description: Deep-dive walkthrough for one technical system — ownership, dependencies/integrations, products it serves, and linked documentation. Use after /org:onboard has stubbed a system (or for any new one), to build it out fully.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__batch_update_nodes, mcp__esim__stats, mcp__esim__traverse]
---

# Org Tech

You are building out a full profile of **one technical system** in the org graph: who owns it, what it depends on or integrates with, what products it serves, and where its documentation lives.

For a system's *runtime behavior* — internal pipeline stages, data flows, capacity, live state, and diagnosis of bottlenecks/blast-radius/root-cause — use [`/org:diagnose`](../diagnose/SKILL.md) instead. This skill covers org-relations; `diagnose` covers operation. Both work on the same `System` node.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines every node/relationship mapping and the dedup gate used below.

## Find-or-create the system

Run the dedup gate against `System` nodes first. If `/org:onboard` already stubbed this system, **enrich that node, don't create a second one.** `get_node` on the match to see its existing edges before asking questions already answered.

If genuinely new: `create_entity System {name, content}`. (No required props — `System` has no LLM-extraction prompt, so the create is already deterministic.)

## Walkthrough

Skip any section without an answer yet — this is meant to be revisited.

### 1. Owning team

Ask which team owns/operates this system. Dedup-gate the team `Agent`, then wire `Team -OWNS-> System`. If there's a separate team with governance/decision authority over it distinct from who operates it day-to-day, wire that as `Team -GOVERNS-> System` instead of (or in addition to) `OWNS`.

### 2. Dependencies, data flows, and substrate

Ask what other systems this one depends on, exchanges data with, or runs on. For each other system, dedup-gate a `System` node (don't build out its full profile here — just link to it, or note it as a candidate for its own `/org:tech` pass later), then wire the edge that states the real relationship:

- `System -DEPENDS_ON-> OtherSystem {dependency_type, criticality:"hard"|"soft"}` — this system breaks (`hard`) or degrades (`soft`) without the other. `dependency_type` is `runtime`/`buildtime`/`data`/`config`.
- `System -FLOWS_TO-> OtherSystem {mode, payload}` — data moves from this system to the other (`mode`: `batch`/`stream`/`sync`/`async`). Use one edge per direction; "integrates with" is usually a `FLOWS_TO` each way.
- `System -RUNS_ON-> Host {environment, region}` — the hardware/cluster/host this software runs on. The host is itself a `System` node (dedup-gate it); being a `RUNS_ON` *target* is what marks it as hardware.

Be precise about direction and edge choice: `DEPENDS_ON` is a *need* (breaks without it); `FLOWS_TO` is *data movement* (independent of dependency); `RUNS_ON` is *deployment*. Don't collapse them into a vague "related to."

### 3. Products served

Ask what product(s) this system powers. Dedup-gate each `Output` (don't build out the product's full profile here — that's `/org:product`'s job), then wire `System -SERVES-> Product`.

### 4. Documentation

Ask where this system's documentation, runbooks, or key domain knowledge live. Dedup-gate a `Resource{resource_type:"knowledge"}` node (name it after the doc/runbook, `content` holds the link or a summary), and wire `System -RELATED_TO-> Doc {relationship_description:"documented by"}` (or `System -REQUIRES-> Doc` if the doc is itself something the system's operation depends on, e.g. a required runbook — usually `RELATED_TO` is the right call here).

## Confirm

After each section, echo back a compact summary of what was created/updated. At the end, `get_node` on the system to show its full resulting profile.
