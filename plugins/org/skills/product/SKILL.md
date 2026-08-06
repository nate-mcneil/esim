---
name: product
description: Deep-dive walkthrough for one product — info, owning teams, technical dependencies, customers, and roadmap. Use after /org:onboard has stubbed a product (or for any new product), to build it out fully.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__batch_update_nodes, mcp__esim__stats, mcp__esim__traverse]
---

# Org Product

You are building out a full profile of **one product** in the org graph: what it is, who builds/owns it, what it depends on technically, who its customers are, and what's on its roadmap.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines every node/relationship mapping and the dedup gate used below.

## Find-or-create the product

Run the dedup gate against `Output` nodes first. If `/org:onboard` (or an earlier `/org:product` session) already stubbed this product, you'll find it — **enrich that node, don't create a second one.** `get_node` on the match to see what's already there before asking the user questions they've already answered.

If it's genuinely new: `create_entity Output {name, content, properties:{is_primitive: true|false}}`. Ask the user whether it's a standalone offering (`is_primitive:true`) or a bundle/composite of other products (`is_primitive:false`).

## Walkthrough

Work through these in order, but skip any section the user doesn't have an answer for yet — partial is fine, this skill is meant to be revisited as more is learned.

### 1. Product info

Update `content` with a clear description if the stub's was thin. This is the one-paragraph "what is this and who is it for" that everything else hangs off of.

### 2. Owning team(s)

Ask which team(s) build and/or are accountable for this product. Dedup-gate each team `Agent`, then wire:
- `Team -PRODUCES-> Product` (they build it)
- `Team -OWNS-> Product` (they're accountable for it) — often the same team, but not always; a platform team can own something a different team primarily builds

### 3. Technical dependencies

Ask what technical systems this product runs on or depends on. For each, dedup-gate a `System` node (don't build out that system's own profile here — that's `/org:tech`'s job, just link to it), then wire `System -SERVES-> Product` (the system *serves/powers* the product). A product's technical dependencies are thus the systems that `SERVES` it — found by traversing `SERVES` incoming from the product.

If the product *is* also a running app/service in its own right (not just dependent on separate systems), remember the convention: the customer-facing `Output` and the underlying running `System` are two nodes, linked `System -SERVES-> Output` — one is "what customers get," the other "what engineers operate."

### 4. Customers

Ask who the customers are — could be named accounts, customer segments, or "everyone" for a broadly-available product. For each, dedup-gate an `Agent{agent_type:"org"}` node representing the customer.

**Important:** customer Agents are **not** `CONTAINS`'d under the internal org tree — they're external entities. Wire them only via `Product -SERVES-> Customer`. Don't accidentally nest a customer under your own org's `CONTAINS` hierarchy; that would misrepresent them as an internal division.

### 5. Roadmap

Ask what's planned next for this product. Each roadmap item is its own `Output{is_primitive:false}` node, wired `Product -CONTAINS-> RoadmapItem {order: <sequence number>}`. Since `Output` has no native status field, state the status plainly in `content` — e.g. "Planned Q3 2026", "In progress, targeting 2026-09", "Shipped 2026-05-01".

Use `order` to keep the roadmap sequence meaningful (1 = next/soonest) even as items get added out of order.

## Confirm

After each section, echo back a compact summary of what was created/updated (node names, edge types) so the user can catch anything wrong before it compounds. At the end, `get_node` on the product to show its full resulting profile.
