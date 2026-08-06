# Org Graph Plugin

A Claude Code plugin that builds and navigates an organization's knowledge graph — its structure, people, products, and technical systems — on top of ESIM's graph. Six [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) packaged as a real Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`), distinct from the repo's core `skills/` directory, which covers ESIM's own structured-intent practice instead.

This plugin doesn't add anything to ESIM's schema — it maps org concepts onto ESIM's existing fixed node/relationship types. See [`shared/mapping-reference.md`](shared/mapping-reference.md) for exactly how, and why a few things deliberately diverge from ESIM's core ideology.

## Skills

| Skill | Invoke as | What it does |
|---|---|---|
| [`onboard`](skills/onboard/SKILL.md) | `/org:onboard` | Bootstraps the basic skeleton for a new organization — structure, org-chart, lightweight product/tech stubs. Start here. |
| [`product`](skills/product/SKILL.md) | `/org:product` | Deep-dive on one product — info, owning teams, tech dependencies, customers, roadmap. |
| [`person`](skills/person/SKILL.md) | `/org:person` | Deep-dive on one person — role(s), reporting line, direct ownership, skills/expertise. |
| [`tech`](skills/tech/SKILL.md) | `/org:tech` | Deep-dive on one technical system — ownership, dependencies/integrations, products served, docs. |
| [`diagnose`](skills/diagnose/SKILL.md) | `/org:diagnose` | Operational deep-dive on one system — pipeline stages, data flows, capacity, live state — then diagnose bottlenecks, blast radius, and root cause by traversal. Runtime counterpart to `/org:tech`. |
| [`lookup`](skills/lookup/SKILL.md) | `/org:lookup` | Read-only navigation and Q&A — who owns what, reporting chains, roadmaps, dependencies. Cannot modify the graph. |
| [`ingest`](skills/ingest/SKILL.md) | `/org:ingest` | Processes larger artifacts (docs, meeting notes, Slack exports) with confidence-gated staging, so uncertain facts don't pollute the graph. |

Typical flow: `/org:onboard` once to get the skeleton in place, then `/org:product` / `/org:person` / `/org:tech` to go deep on specific things as you learn more, `/org:diagnose` when you need to reason about a system's runtime behavior (bottlenecks, blast radius, root cause), `/org:ingest` for anything that comes as a document or transcript rather than a conversation, and `/org:lookup` any time you just want to ask the graph a question.

## Prerequisite: the ESIM MCP server

All six skills drive the ESIM MCP tools, so the server must be registered as `esim` first — see the repo [README](../../README.md#mcp-connection).

## Installing the plugin

### Global install (recommended — available in every project)

Any folder containing its own `.claude-plugin/plugin.json` is loaded as a namespaced plugin automatically when placed inside a skills directory — including the global one. Symlink (or copy) this plugin directory into `~/.claude/skills/`:

```bash
ln -s /absolute/path/to/esim/plugins/org ~/.claude/skills/org
```

On your next Claude Code session, anywhere on the machine, it loads as `org@skills-dir` and `/org:onboard`, `/org:product`, `/org:person`, `/org:tech`, `/org:lookup`, `/org:ingest` are all available — no marketplace, no install command, no per-project setup. This coexists fine with the repo's other skills (`purpose-discovery`, etc.), which are plain `SKILL.md` folders with no manifest and load un-namespaced by their bare names.

### Local testing (while iterating on the skill files)

```bash
cd /path/to/esim
claude --plugin-dir ./plugins/org
```

Faster to iterate with while editing the `SKILL.md` files, since there's no symlink step — just re-run with the flag.

## The model these skills assume

Unlike the repo's core skills, this plugin does **not** assume ESIM's "structured-intent" model (purpose on edges, the constraint stack, `(Needs + Resources) / Constraints = Output`). It borrows ESIM's graph mechanics — typed nodes, typed edges, semantic search, signal staging — without the ideology layered on top. If you're new to ESIM generally, [the repo README](../../README.md) is still worth reading for how the underlying graph and MCP tools work; just note that `Need`, `Constraint`, and `PURPOSE` edges are mostly unused here by design (see "Where this diverges from ESIM's ideology" in [`shared/mapping-reference.md`](shared/mapping-reference.md)).
