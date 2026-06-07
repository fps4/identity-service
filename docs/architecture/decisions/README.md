# Architecture Decision Records

This folder holds the Architecture Decision Records (ADRs) for `component-auth`.
Each ADR captures one decision in the standard one-page format. This index page
is navigation only and is not indexed in the workspace SpecIndex.

## Conventions

- One decision per file, named `NNNN-<slug>.md`, where `NNNN` is a four-digit sequence number assigned monotonically and `<slug>` is a lowercase, hyphen-separated summary of the decision.
- Numbers are never reused; a superseded decision keeps its number and records the superseding ADR.
- Each ADR carries a `maestro:` frontmatter block with `feature`, `kind: architecture_decision`, and a plain-language `summary`.
- Each ADR body uses the standard sections: **Context**, **Decision**, **Consequences**, with optional **Trade-offs** and **Open questions**.

## Template

Use [`adr-template.md`](adr-template.md) as the starting point when adding a new
decision record.

## Index

No decision records have been migrated into this folder yet. Decisions recorded
elsewhere in the repository are moved here under the naming and format above as
part of the live-tree audit. If a past decision has no record at all, raise the
gap with the architect rather than reconstructing it.
