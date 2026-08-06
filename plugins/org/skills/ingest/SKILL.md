---
name: ingest
description: Process a larger artifact — meeting notes, a Slack thread export, a document, a wiki page — into the org graph. Stages low-confidence facts as Signal nodes for review instead of writing them straight to structure, keeping the graph clean. Also handles reviewing and promoting previously staged signals.
allowed-tools: [mcp__esim__search, mcp__esim__list, mcp__esim__get_node, mcp__esim__create_entity, mcp__esim__create_relationship, mcp__esim__batch_create_relationships, mcp__esim__update_node, mcp__esim__batch_update_nodes, mcp__esim__create_signal, mcp__esim__create_session, mcp__esim__stats]
---

# Org Ingest

You are processing a larger artifact — not the guided one-entity-at-a-time conversation the other skills in this plugin use, but a chunk of text someone hands you: meeting notes, a Slack thread export, a document, a wiki page, a transcript.

**Read [`../../shared/mapping-reference.md`](../../shared/mapping-reference.md) first** — it defines every node/relationship mapping and the dedup gate used below.

This skill has two modes: **ingest** (process a new artifact) and **review** (work through previously staged facts). Ask the user which one they want if it isn't obvious from what they've given you.

## Mode 1: Ingest

Read through the artifact and extract candidate facts — statements that map to the node/relationship types in the shared reference (people, roles, teams, products, systems, and the relationships between them). For each candidate fact, apply the confidence gate before doing anything with it.

### Confidence gate

**High confidence → apply directly**, through the normal dedup-gate-and-create procedure from the shared reference, only if **all** of the following hold:
- The fact is stated directly in the source — not inferred, guessed, or paraphrased from something vaguer.
- Every entity involved resolves confidently: either an unambiguous match via the dedup gate, or clearly new with no plausible existing match.
- It doesn't contradict anything already in the graph.
- The source is authoritative for this specific fact — e.g. a person describing their own role or team, an official doc, a manager describing their own org. Not hearsay.

**Low confidence → stage as a `Signal`, do not touch structure**, if **any** of the following hold:
- Ambiguous entity resolution — could plausibly match more than one existing node, or it's unclear whether it's new or an alias for something existing.
- Speculative or inferred language in the source ("I think", "probably", "sounds like", "might be").
- It contradicts something already in the graph — this needs a human decision, not a silent overwrite.
- It's secondhand or unverified — e.g. a Slack message relaying something the poster didn't witness directly.

When in doubt, stage it. A false "staged for review" costs a few seconds of the user's attention later; a false "written to structure" pollutes the graph with something that might be wrong, and there's no built-in way to tell it apart from a verified fact once it's in.

### Staging a low-confidence fact

`create_signal` with:
- `observation`: the candidate fact, in plain language, close to the source's actual wording.
- `context`: the source citation (doc title/link, `"Meeting: <name>, <date>"`, `"#<channel> Slack, <date>, @<author>"`) plus a short note on *why* it's uncertain.
- `properties: { how_observed: "reported" (source stated it, secondhand) or "inferred" (you inferred it, source didn't state it outright), confidence: "low" or "medium" (never "high" — if it were high-confidence it wouldn't be staged), status: "needs_classification" }`. This deliberately repurposes `needs_classification` as "staged here, pending review" — it's a different meaning than the repo's `signal-processing` skill uses that status for, but it keeps these signals out of that skill's own queue (which filters on `status:"unprocessed"`), so the two don't collide.
- `signals_entity_id`: the best-guess target entity's id, if one resolves even tentatively — gives the review step and any lookup traversal a starting anchor.
- `produced_in_session_id`: create one `Session` per ingestion batch up front (`create_session {name, properties:{session_type:"review"}, ...}`, `scope_description` = the source description), and pass its id here for every signal from this artifact — keeps everything from one source grouped for provenance.

## Mode 2: Review & promotion

Run this on demand, whenever the user wants to work through what's been staged.

1. `list {type:"Signal", status:"needs_classification", limit:50}` to pull the pending queue.
2. For each signal, present: the candidate fact (`observation`), its source (`context`), and why it was staged.
3. **On confirmation:** apply the fact through the normal dedup-gate-and-create path (same as a high-confidence fact would have gone), then `update_node` the signal to `{status:"resolved_into_update", disposition:"additive", disposition_note:"<what was created/updated, with the resulting node id(s)>"}`.
4. **On rejection:** `update_node` the signal to `{status:"dismissed", disposition_note:"<why>"}`. No structural change.
5. Never `delete_node` a signal (this skill doesn't have that tool anyway) — dismissed or resolved signals are the audit trail of what was claimed and what was decided. That trail is what makes it safe to keep the structural graph clean: nothing gets silently lost, it's just not treated as fact until a human says so.

## Confirm

At the end of either mode, report a summary: facts applied directly, facts staged, (in review mode) signals confirmed vs. dismissed. Run `stats` if the user wants a sense of overall graph growth.
