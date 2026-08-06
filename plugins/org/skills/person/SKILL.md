---
name: person
description: Deep-dive walkthrough for one person — role(s), reporting line, direct ownership/contributions, and skills/expertise. Use after /org:onboard has stubbed a person (or for anyone new), to build out their profile fully.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__batch_update_nodes, mcp__esim__stats, mcp__esim__traverse]
---

# Org Person

You are building out a full profile of **one person** in the org graph: their role(s), reporting line, what they directly own or contribute to, and their skills/expertise.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines every node/relationship mapping and the dedup gate used below.

## Find-or-create the person

Run the dedup gate against `Agent{agent_type:"person"}` nodes first. If `/org:onboard` already stubbed this person, **enrich that node, don't create a second one.** `get_node` on the match to see their existing `FILLS`/role/reporting edges before asking questions already answered.

If genuinely new: `create_entity Agent {name, content, properties:{agent_type:"person"}}`.

## Walkthrough

Skip any section without an answer yet — this is meant to be revisited.

### 1. Role(s)

A person can hold more than one role (e.g. an IC role plus an interim lead role). For each role:
1. Dedup-gate a `Role` node, named `"<Title>, <Team/Org>"`.
2. Wire `Person -FILLS-> Role`.
3. Wire `Role -SCOPED_TO-> <their team/org Agent>` (dedup-gate the team/org if it's not already captured).

### 2. Reporting line

Ask who this person reports to. Resolve or create the manager's `Person` + `Role` (don't build out the manager's full profile here — that's a separate `/org:person` pass if needed, just link to their Role). Wire:

`<this person's Role> -RELATED_TO-> <manager's Role> {relationship_description:"reports to"}`

Reporting lines live at the Role level, not directly between people — if this person changes roles later, the old role keeps its historical reporting edge and the new role gets its own, rather than rewriting a person-to-person fact.

### 3. Direct ownership / contributions

Ask what this person personally owns or is directly responsible for, distinct from what their team as a whole owns — e.g. they're the accountable owner of a specific system, or the primary contact for a specific product. Wire `Person -OWNS-> <Output or Resource>` (dedup-gate the target first; don't create a duplicate of something `/org:product` or `/org:tech` already built out).

### 4. Skills / expertise

Ask what skills or domain expertise this person is known for. For each, dedup-gate a `Resource{resource_type:"skill"}` node and wire `Person -OWNS-> Skill`. Keep this list to things that are actually useful to know when navigating the org ("who should I talk to about X") — not a resume.

## Confirm

After each section, echo back a compact summary of what was created/updated. At the end, `get_node` on the person to show their full resulting profile.
