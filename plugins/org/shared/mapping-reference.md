# Org Graph — Mapping Reference

This is the single source of truth for how the `org` plugin's skills (`onboard`, `product`, `person`, `tech`, `ingest`) map real-world organization concepts onto ESIM's fixed graph schema. Every write-capable skill in this plugin links here instead of restating these tables — if you're editing the mapping, edit it once, here.

ESIM's schema (see [`src/types.ts`](../../../src/types.ts)) is built around a "structured-intent" purpose model — this plugin bends that schema pragmatically toward org/product/people/tech modeling. Most of that is reuse of existing primitives; the one place this plugin's needs drove a core ESIM addition is the **`System`** label and its `DEPENDS_ON`/`FLOWS_TO`/`RUNS_ON` edges, which technical-system modeling uses (see [`docs/systems-schema-design.md`](../../../docs/systems-schema-design.md)). See "Where this diverges from ESIM's ideology" below for what the pragmatic bends mean in practice.

## Node mapping

| Concept | ESIM label | Required props (skip LLM extraction) |
|---|---|---|
| Top-level organization | `Agent` | `agent_type:"org"`, `is_root:true` |
| Subsidiary / business unit / division | `Agent` | `agent_type:"org"` |
| Team / department | `Agent` | `agent_type:"team"` |
| Person | `Agent` | `agent_type:"person"` |
| Bot / service acting autonomously | `Agent` | `agent_type:"ai"` |
| A person's job/seat | `Role` | *(none — Role has no extraction prompt)* |
| Customer (external org or account) | `Agent` | `agent_type:"org"` — **not** `CONTAINS`'d under the internal org tree |
| Customer-facing product | `Output` | `is_primitive:true` (standalone) or `false` (composite/bundled) |
| Roadmap item (planned future product work) | `Output` | `is_primitive:false`; status noted in `content` — there's no native status field, so state it plainly, e.g. "Planned Q3 2026", "In progress", "Shipped 2026-05-01" |
| Technical system / app / service / pipeline | `System` | *(none — a System has no required prop; LLM extraction auto-skips)* |
| Hardware — host / server / cluster / device | `System` | *(none — identified as hardware by being the target of a `RUNS_ON` edge)* |
| Documentation / domain knowledge | `Resource` | `resource_type:"knowledge"` |
| A skill/competency a person or team has | `Resource` | `resource_type:"skill"` |
| Budget / headcount / capacity pool | `Resource` | `resource_type:"budget"` or `"capacity"` |

**Products that are also apps.** The customer-facing offering (what customers buy/use) is an `Output`; the running system/codebase behind it is a separate `System`, linked `System -SERVES-> Output`. Keep these as two nodes even when they share a name — one represents "what customers get," the other "what engineers operate." (The running system *serves* the product; a product's technical dependencies are therefore the systems that `SERVES` it — traverse `SERVES` incoming from the product.)

## Relationship mapping

| Real-world relationship | Edge | Direction | Props |
|---|---|---|---|
| Org/team contains a sub-unit | `CONTAINS` | parent → child | `order?` |
| Product's roadmap item | `CONTAINS` | Product(Output) → roadmap item(Output) | `order` (sequence in the roadmap) |
| Person holds a role | `FILLS` | Person(Agent) → Role | — |
| Role belongs to a team/org | `SCOPED_TO` | Role → Agent(team/org) | — |
| Reporting line | `RELATED_TO` | report's Role → manager's Role | `relationship_description:"reports to"` |
| Team/role/person owns a system, product, or skill | `OWNS` | Agent/Role → Resource/Output/System | — |
| Team/role has decision authority over something | `GOVERNS` | Agent/Role → Resource/Output/Agent/System | — |
| Product produced by a team/org | `PRODUCES` | Agent/Role → Output | — |
| System serves / powers a team or product | `SERVES` | System → Agent/Output | — |
| Product serves a customer | `SERVES` | Output → Agent(customer) | — |
| System depends on another system | `DEPENDS_ON` | System → System/Resource | `dependency_type:"runtime"\|"buildtime"\|"data"\|"config"`, `criticality:"hard"\|"soft"` |
| Data flows between systems | `FLOWS_TO` | System → System | `mode:"batch"\|"stream"\|"sync"\|"async"`, `payload?` |
| Software system runs on hardware | `RUNS_ON` | System → System(host/device) | `environment?`, `region?` |
| Anything else the 26 types don't cleanly cover | `RELATED_TO` | as appropriate | always set `relationship_description` to a short verb phrase |

**Dependency vs. flow vs. integration.** `DEPENDS_ON` means this system breaks (or degrades, if `criticality:"soft"`) without the other — a *directional need*. `FLOWS_TO` is *data movement*, independent of dependency (A can flow to B without depending on it). "Integrates with" is usually a `FLOWS_TO` (often one edge in each direction) or a soft `DEPENDS_ON` — pick the one that states the real relationship, not the vague "integrates."

Prefer a native edge when one cleanly fits (`OWNS`, `PRODUCES`, `GOVERNS`, `CONTAINS`, `SERVES`, `FILLS`, `SCOPED_TO`, `DEPENDS_ON`, `FLOWS_TO`, `RUNS_ON`). Fall back to `RELATED_TO` only when nothing else fits, and always fill `relationship_description` — an undescribed `RELATED_TO` edge is close to useless for later lookup.

A role's `PURPOSE` edge and any `Need` nodes are **optional** — omit them unless the user explicitly states a role's reason-to-exist or an unmet need. Don't interrogate for them; that's a different skill's job (`purpose-discovery`), not this plugin's.

## Dedup gate — run before every `create_entity` call

Only `id` is unique in ESIM's database — there is no uniqueness constraint on `name`. Nothing stops two `Agent{name:"OMG"}` nodes from existing side by side. Dedup is entirely this plugin's responsibility, so every write-capable skill follows this procedure before creating any node:

1. **Canonicalize the name first.** Consistent capitalization; full person names (not nicknames as the primary name — nicknames/aliases go in `content`); proper product/system names (not acronyms as the primary name unless that acronym *is* the name everyone uses).
2. **Authoritative exact check:** `list {type:"<Label>", compact:true, limit:50}` (raise `limit` as the graph grows) and scan the results for a case-insensitive exact name match. This is the reliable check — `list` filters by label but not by name, so the scan happens client-side; `search` cannot do exact-name matching at all (it's semantic/vector-only).
3. **Fuzzy safety net:** `search {query:"<name> — <one-line description>", index:"entity", limit:5}`. If a result scores high and is plainly the same real-world thing under a different name or alias, treat it as existing.
4. **Decide:**
   - No match → `create_entity` with the required classification props from the table above (this also skips ESIM's LLM metadata-extraction pass, which is tuned to the intent model, not org data).
   - Match, with new information → `update_node {id, properties}` to enrich `content` or add fields (merges, never destroys existing fields). Do **not** create a second node.
   - Ambiguous → ask the user one disambiguating question before acting. Err toward *not* creating a duplicate — for org/people/product/system identities (unlike open-ended personal-purpose discovery), a false duplicate is the expensive mistake, not a false "this already exists."
5. **Before adding a relationship**, `get_node` on the intended `from_id` and check its existing relationships to confirm the edge doesn't already exist.
6. **Cross-skill rule:** `product`, `person`, and `tech` must run this same gate before creating their subject's own node. If `onboard` already created a lightweight stub for it, **enrich that node** via `update_node` plus additional relationships — never create a second node for something `onboard` already stubbed out.

**Never leave orphans.** Every new Person gets a `FILLS`→Role in the same turn; every new Role gets `SCOPED_TO`; every new product/system node gets at least one connecting edge (`OWNS`, `SERVES`, `REQUIRES`, or `PRODUCES`) before the turn ends.

## Where this diverges from ESIM's ideology

ESIM's core model (see `skills/purpose-discovery/SKILL.md`) makes some demands that don't apply to neutral org/product/tech mapping. This plugin deliberately diverges in a few places — worth stating plainly so it reads as intentional, not sloppy:

1. **"Agents never connect directly — only through Roles."** Org nesting (`Org -CONTAINS-> Team`) uses **direct Agent→Agent edges**. This is a pragmatic exception: org containment is a structural fact, not interpersonal friction. People, however, still attach through Roles (`Person -FILLS-> Role -SCOPED_TO-> Team`) — that discipline stays, because it's genuinely useful for reporting lines and role-vs-person distinctions. Systems are `Agent`s too (the `System` label is an `Agent` sub-label), so team→system edges (`OWNS`, `GOVERNS`) and system→system edges (`DEPENDS_ON`, `FLOWS_TO`, `RUNS_ON`) are also direct Agent→Agent — the same structural-fact exception, not a Role relationship.
2. **`PURPOSE` edges are not required.** Skip them for org/product/tech mapping unless someone explicitly states a role's or product's reason-to-exist.
3. **`Need` nodes generally don't apply.** Org mapping doesn't create `Need` nodes. If a genuine unmet need comes up ("this team needs a data engineer"), that's out of scope for these skills — flag it to the user rather than modeling it.
4. **`run_diagnostic`'s purpose-oriented checks will flag org nodes as defective.** Checks like `missing_purpose`, `entities_without_purpose`, and `roles_without_needs` are expected to fire on org data — including `System` nodes, which are `Agent`s but carry no `PURPOSE` edge by default. That's noise, not a signal something's wrong. None of this plugin's skills expose `run_diagnostic`; if you run it separately against a graph that mixes org data with personal structured-intent data, filter those findings out mentally for anything created by this plugin.

**Fields safe to omit for org modeling:** `capacity`, `rigidity`, `validation_state`, `origin_*`, `lifecycle_state`, `trust`, `cost`, `failure_condition`, `purpose_type`.
**Fields that must always be set** (to skip LLM extraction and keep data deterministic): `agent_type` (Agent), `resource_type` (Resource), `is_primitive` (Output). `System` requires none — it has no extraction prompt, so `create_entity System {name, content}` is already deterministic.
