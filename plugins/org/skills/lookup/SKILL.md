---
name: lookup
description: Query and navigate the organization knowledge graph — who owns what, reporting chains, what a team produces, what a system depends on, who a product's customers are, what's on a roadmap. Read-only; cannot modify the graph.
allowed-tools: [mcp__esim__search, mcp__esim__get_node, mcp__esim__traverse, mcp__esim__get_context, mcp__esim__list, mcp__esim__stats]
---

# Org Lookup

You are answering questions about the org graph — read-only. This skill has no write tools, so it's safe for casual questions: nothing it does can create, change, or delete a node or edge.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines what each node label and relationship type means, which is what makes the traversal results below interpretable.

## Standard pattern: resolve → traverse

`traverse` and `get_node` both need a node `id`, so most questions are two steps:

1. **Resolve the anchor node's id.** Try `list {type:"<Label>", compact:true, limit:50}` and scan for an exact (or close) name match first — it's the more reliable check since `list` filters by label precisely. Fall back to `search {query, index:"entity"}` for a fuzzy/semantic match if the exact name isn't known or doesn't hit.
2. **Traverse from that id** with a `relationship_types` filter scoped to the question being asked (see the table below), and a `direction` (`incoming`/`outgoing`/`both`) that matches which side of the edge you need.

`get_context {query}` is the fallback for fuzzy or open-ended questions where there isn't a single clean anchor node ("catch me up on OMG", "what do we know about the payments area").

## Example questions → calls

| Question | Calls |
|---|---|
| "Who owns `<X>`?" | resolve `<X>` → `traverse {relationship_types:["OWNS","GOVERNS"], direction:"incoming"}` |
| "What does `<org/team>` produce?" | resolve → `traverse {relationship_types:["PRODUCES","CONTAINS"], direction:"outgoing", max_depth:2}` (CONTAINS reaches sub-teams, PRODUCES reaches their outputs) |
| "What's `<person>`'s reporting chain?" | resolve Person → `traverse {relationship_types:["FILLS"], direction:"outgoing"}` to their Role → repeatedly `traverse {relationship_types:["RELATED_TO"], direction:"outgoing"}` from that Role, following edges where `relationship_description == "reports to"`, until it stops |
| "What does `<product>` depend on?" | resolve → `traverse {relationship_types:["SERVES"], direction:"incoming"}`, filter results to `System` nodes (the systems that power it) |
| "What does `<system>` depend on / talk to / run on?" | resolve System → `traverse {relationship_types:["DEPENDS_ON","FLOWS_TO","RUNS_ON"], direction:"outgoing"}` (add `direction:"incoming"` on `DEPENDS_ON`/`FLOWS_TO` for "what depends on / feeds this") |
| "What runs on `<host>`?" | resolve host System → `traverse {relationship_types:["RUNS_ON"], direction:"incoming"}` |
| "Who are `<product>`'s customers?" | resolve → `traverse {relationship_types:["SERVES"], direction:"outgoing"}`, filter results to `Agent` nodes |
| "What's on `<product>`'s roadmap?" | resolve → `traverse {relationship_types:["CONTAINS"], direction:"outgoing"}`, filter results to `Output` nodes, sort by the edge's `order` |
| "Who's on `<team>`?" | resolve team → `traverse {relationship_types:["SCOPED_TO"], direction:"incoming"}` to Roles → for each Role, `traverse {relationship_types:["FILLS"], direction:"incoming"}` to the Person |
| "Who does `<person>` report to?" / "What does `<person>` do?" | resolve → `get_node {id}` (shows their `FILLS` role and all other edges directly) |
| "What team owns `<system>`?" | resolve → `traverse {relationship_types:["OWNS","GOVERNS"], direction:"incoming"}` |
| "Catch me up on `<X>`" / open-ended | `get_context {query:"<X>"}` (or `{entity_id}` if already resolved), then drill into anything interesting with `get_node` |
| "How big is the graph so far?" | `stats` |
| "List all the people / systems / products captured" | people: `list {type:"Agent", compact:true, limit:100}` then filter `agent_type` client-side (and exclude `System` nodes, which are also `:Agent`); systems: `list {type:"System", compact:true, limit:100}` directly; products: `list {type:"Output", compact:true, limit:100}` |

## A note on noise

If you (or the user) run `run_diagnostic` separately against this graph, ignore purpose-oriented findings (`missing_purpose`, `entities_without_purpose`, `roles_without_needs`, etc.) for anything created by this plugin's skills — those are expected on org data, not defects. This skill doesn't expose `run_diagnostic` itself for that reason.
