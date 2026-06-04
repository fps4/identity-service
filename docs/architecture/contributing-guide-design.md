---
title: "Contributing guide — technical design"
status: draft
last_updated: 2025-01-23
owners: [architect]
related:
  - docs/product/specs/contributing-guide.md
maestro:
  feature: contributing-guide
  kind: technical_design
  summary: |
    Add a single CONTRIBUTING.md file at the repository root. The file
    has three short sections — Prerequisites, Build, and Test — that
    mirror the commands already used in the repo (Node 20, npm ci,
    npm run build, npm test). No code, configuration, or tooling
    changes; this is documentation only. One small commit, one PR.
---

# Contributing guide — technical design

## Summary
The spec asks for a concise CONTRIBUTING.md at the repo root with three sections that accurately reflect the existing build/test setup. The design is a single documentation artefact: a new markdown file with fixed structure and verified commands. There is no code path, no runtime behaviour, and no architectural surface — the only work is writing the file and verifying its commands against the repo's current `package.json` and CI configuration.

## Requirements traceability

| AC | Satisfied by |
|---|---|
| AC-1 (file exists at repo root, named `CONTRIBUTING.md`) | Task 1 — create `CONTRIBUTING.md` at repo root |
| AC-2 (Prerequisites section states Node 20) | Task 1 — `## Prerequisites` section content |
| AC-3 (Build section documents `npm ci` then `npm run build`) | Task 1 — `## Build` section content |
| AC-4 (Test section documents `npm test`) | Task 1 — `## Test` section content |
| AC-5 (content is accurate to existing setup) | Task 1 — verification step against `package.json` and CI config before commit |
| AC-6 (concise — no extraneous sections) | Task 1 — three sections only, no preamble beyond a one-line intro |

> If the spec's ACs are not numbered exactly 1–6, the implementing builder maps to the actual `AC-N` ids in the spec; the structure above stands.

## Architecture

No runtime architecture. The artefact is a static markdown file read by humans (contributors, reviewers) and by GitHub's UI (which surfaces `CONTRIBUTING.md` on PR creation).

```
repo root/
├── CONTRIBUTING.md   ← new
├── package.json      ← read-only (source of truth for commands)
└── …
```

## Data model

None. The file is plain markdown with three `##` headings.

Document shape:

```
# Contributing

<one-line intro>

## Prerequisites
- Node.js 20

## Build
```
npm ci
npm run build
```

## Test
```
npm test
```
```

## API / contracts

None. The "contract" is between the document and the repo's actual scripts: every command shown in the file must exist and succeed in a clean checkout.

Verification contract for the builder:

- `node --version` in CI / `.nvmrc` / `engines.node` in `package.json` → must indicate Node 20. If the repo pins a different version, the spec's intent is wrong and the builder surfaces a clarify question rather than committing inaccurate content.
- `package.json` `scripts.build` → must exist for `npm run build` to be accurate.
- `package.json` `scripts.test` → must exist (or the default `npm test` behaviour must be acceptable) for `npm test` to be accurate.

## Trade-offs

- **One file vs. a docs tree.** A single root file is what the spec asks for and what GitHub surfaces. A `docs/contributing/` tree would be over-engineered for three sections. Cost: if the guide grows later, it splits — fine, that's a future concern.
- **Inline commands vs. links to scripts.** Inline `npm` commands are the convention contributors expect on first read. Linking out adds a hop with no payoff at this size.
- **No ADR proposed.** This is routine documentation; none of the *When to propose an ADR* triggers apply (no new runtime, store, protocol, or invariant change).

## Task list

| # | Task | Targets | Requirements | Depends on |
|---|---|---|---|---|
| 1 | Verify Node version, build script, and test script in `package.json` / CI config; write `CONTRIBUTING.md` at repo root with the three sections (Prerequisites, Build, Test) using the verified commands | fps4/component-auth | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 | — |

One task, one PR. If verification reveals a mismatch (e.g. repo pins Node 18, not 20), the builder must surface a clarify question against the spec rather than committing content that contradicts the repo.

## Notes

- The file lives at the repo root so GitHub's contributor-guide affordance picks it up automatically.
- Future additions (lint, formatting, commit conventions, PR checklist) are out of scope for this iteration — the spec explicitly asks for conciseness.
- No new dependencies; no manifest changes.