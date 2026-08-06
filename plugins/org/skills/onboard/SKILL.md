---
name: onboard
description: Bootstrap the basic skeleton of an organization's knowledge graph — its structure, org-chart, and lightweight product/tech stubs. Use this first, on any organization not yet represented in the graph, before going deeper with product/person/tech.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__batch_update_nodes, mcp__esim__stats, mcp__esim__traverse]
---

# Org Onboard

You are bootstrapping the initial graph for an organization — coverage, not depth. Your job is to get the skeleton in place quickly: the org's structure, its people, and lightweight stubs for its primary products and technical systems. Depth on any one of those comes later, from the `product`, `person`, and `tech` skills in this plugin.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines every node/relationship mapping and the dedup gate used below. Don't restate it; follow it.

## What this skill is not

It is not a purpose-discovery session. Don't ask about constraint stacks, needs, or purpose declarations — that's a different practice (`skills/purpose-discovery` at the repo root), for a different kind of graph. This skill only builds structural facts: who reports to whom, what teams exist, what the org makes, what it runs on.

It is not the place to go deep on any single product, person, or system. If the user starts giving you rich detail on one specific product while you're still trying to get the skeleton down, capture the minimum (name + who owns it) and tell them to follow up with `/org:product` for the rest — don't let one deep tangent stall the broad pass.

## Flow

### 1. Org structure

Ask for the organization's name and its immediate structure — subsidiaries, divisions, major teams. You don't need the full depth of every team; get the top two or three levels.

1. Dedup-gate the top-level org: `create_entity Agent {name, properties:{agent_type:"org", is_root:true}}`.
2. For each subsidiary/division/team the user names, dedup-gate and create as `Agent{agent_type:"org"}` (subsidiaries/divisions) or `Agent{agent_type:"team"}` (departments/teams), then wire `CONTAINS` from parent to child via `batch_create_relationships`.
3. Confirm the tree back to the user in a compact list before moving on.

### 2. People / org-chart

Ask for the key people the user wants captured and their reporting lines — this doesn't need to be exhaustive, just the people who matter for navigating the org.

For each person:
1. Dedup-gate their `Agent{agent_type:"person"}` node.
2. Create their `Role` (name pattern: `"<Title>, <Team/Org>"` so two people with the same title on different teams don't collide) and wire `Person -FILLS-> Role` and `Role -SCOPED_TO-> <their team/org Agent>`.
3. If a reporting line is known, wire it as `Role -RELATED_TO-> <manager's Role> {relationship_description:"reports to"}` — resolve or create the manager's Role/Agent/Person first if they're not already captured.

Batch the edges for each person with `batch_create_relationships` rather than one call per edge.

### 3. Primary products (lightweight)

Ask what the org's primary products/offerings are. For each:
1. Dedup-gate an `Output{is_primitive:true or false}` stub — name and a one-line `content` description are enough for now.
2. Wire the producing team via `PRODUCES` and/or `OWNS` (from the team `Agent` or its `Role`).

Do **not** ask about customers or roadmap here — that's `/org:product`'s job. This pass is a stub, not a deep-dive.

### 4. Primary technical systems (lightweight)

Ask what the org's primary technical systems are (the ones people would actually need to know about — not an exhaustive CMDB). For each:
1. Dedup-gate a `System` stub (`create_entity System {name, content}` — no required props).
2. Wire the owning team via `OWNS`.

Do **not** ask about dependencies/integrations here — that's `/org:tech`'s job.

### 5. Confirm and hand off

Run `stats` and report the resulting node/edge counts back to the user. Point them at:
- `/org:product` to go deep on any product just stubbed (or a new one).
- `/org:person` to go deep on any person just stubbed (or a new one).
- `/org:tech` to go deep on any system just stubbed (or a new one).
- `/org:diagnose` to model a system's runtime operation (stages, flows, capacity, state) and diagnose bottlenecks / blast radius / root cause.
- `/org:lookup` to start querying what's there.
- `/org:ingest` if they have a document, meeting transcript, or Slack export to process in bulk instead of conversationally.

## Idempotency

This skill should be safe to re-run. Every create in every step above goes through the dedup gate first — running `onboard` a second time against the same org should enrich existing nodes (if new details are given) rather than duplicate them, and `stats` counts should not grow from re-running with the same inputs.
