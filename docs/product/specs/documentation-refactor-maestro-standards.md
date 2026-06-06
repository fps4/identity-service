---
title: "Documentation refactor to meet Maestro standards"
status: draft
last_updated: 2025-01-31
owners: [architect]
related:
  - docs/architecture/decisions/0025-managed-product-documentation-standard-and-navigation-ia.md
  - docs/architecture/decisions/0018-workspace-read-api-and-frontmatter-index.md
  - docs/architecture/decisions/0021-plain-language-summary-on-artefacts.md
  - standards/documentation.yaml
  - standards/naming.yaml
maestro:
  feature: documentation-refactor-maestro-standards
  kind: functional_spec
  task: run-64ef3f57
  summary: |
    The fps4/component-auth repository's documentation does not currently conform
    to the Maestro documentation standard. This work audits every existing
    documentation file in the repo, restructures the information architecture to
    match the two-plane Product / Architecture layout defined by ADR-0025, adds
    mandatory maestro frontmatter to all artefacts that must appear in the
    SpecIndex, and ensures all file paths, headings, and naming conventions comply
    with standards/documentation.yaml and standards/naming.yaml. The outcome is a
    repo whose documentation the Maestro toolchain can discover, index, and
    navigate without manual intervention.
---

# Documentation refactor to meet Maestro standards

## Summary

The fps4/component-auth repository currently holds documentation that was written outside the Maestro standard. Files may be missing frontmatter, placed at non-standard paths, or structured in ways the workspace read API cannot index. This spec defines what the refactored documentation set must look like: correct two-plane information architecture, complete and valid `maestro:` frontmatter on every indexed file, naming and heading conventions that match the standards files, and a navigable README that acts as the repo's entry point. No content is invented; existing knowledge is reorganised and annotated.

## Scope

**In scope**
- Audit all existing `.md` files in `fps4/component-auth` and classify each as Product-shelf, Architecture-shelf, or ephemeral/unlisted.
- Restructure file paths to match the two-plane IA: `docs/product/` for product-facing content and `docs/architecture/` for technical decisions and design records.
- Add or correct `maestro:` frontmatter blocks on every file that must appear in the SpecIndex, including the mandatory `feature`, `kind`, and `summary` fields.
- Ensure `summary` values are plain language, ≤ 120 words, no markdown or links (ADR-0021).
- Update or create the repo-root `README.md` to declare the preferred doc path and serve as the navigation entry point.
- Rename files to comply with `standards/naming.yaml` slug conventions (lowercase, hyphen-separated, no underscores).
- Update all internal cross-links broken by path changes.
- Ensure every ADR file under `docs/architecture/decisions/` follows the standard ADR template and numbering scheme.

**Out of scope**
- Rewriting or expanding the technical content of existing documentation (content accuracy is not reviewed here).
- Adding new documentation topics or coverage areas not already represented in the repo.
- Refactoring source code, configuration, or anything outside `.md` files.
- Setting up CI lint rules or automated frontmatter validation (tooling is a separate work item).
- Migrating documentation to an external site or wiki.

## User stories

- As an architect, I want every documentation file in fps4/component-auth to carry valid Maestro frontmatter, so that the workspace read API can index and surface them without manual curation.
- As a developer onboarding to the component-auth codebase, I want a README that points me to the correct doc paths, so that I can find product and architecture documentation without searching the full file tree.
- As the Maestro toolchain, I want all indexed files to reside at their declared `docs/product/` or `docs/architecture/` paths, so that the SpecIndex join key resolves without errors.
- As a functional reviewer, I want every artefact summary written in plain language under 120 words, so that I can understand the purpose of each file without reading its full body.

## Acceptance criteria (EARS)

- **AC-1.** WHEN the refactor is complete THE SYSTEM SHALL contain no `.md` file under `docs/` that is missing a `maestro:` frontmatter block and is intended to appear in the SpecIndex.
- **AC-2.** WHEN the workspace read API indexes `fps4/component-auth` THE SYSTEM SHALL return every SpecIndex-eligible file with a resolved `feature` slug and `kind` value drawn from the allowed set in `standards/documentation.yaml`.
- **AC-3.** IF a `maestro:` frontmatter `summary` field exceeds 120 words or 800 characters THEN THE SYSTEM SHALL be considered non-compliant and the file must be corrected before the branch is approved.
- **AC-4.** WHEN a file is classified as Product-shelf content THE SYSTEM SHALL place it under `docs/product/` with a filename matching the `standards/naming.yaml` slug pattern (lowercase, hyphen-separated, `.md` extension).
- **AC-5.** WHEN a file is classified as Architecture-shelf content THE SYSTEM SHALL place it under `docs/architecture/` following the same slug pattern, with ADR files additionally prefixed by their four-digit sequence number (e.g. `0001-<slug>.md`).
- **AC-6.** WHEN the refactor is complete THE SYSTEM SHALL have a `README.md` at the repo root that declares the preferred documentation path and links to both the Product-shelf and Architecture-shelf top-level index files.
- **AC-7.** WHEN any file path changes THE SYSTEM SHALL have all internal cross-links within the repo updated to the new path so that no link resolves to a 404.
- **AC-8.** IF a `maestro:` frontmatter `summary` field contains markdown formatting, inline code, hyperlinks, EARS keywords (WHEN, SHALL, IF, THEN, WHILE), or spec-section ids (AC-N) THEN THE SYSTEM SHALL be considered non-compliant and the field must be rewritten.
- **AC-9.** WHEN the workspace read API is queried for the repo's SpecIndex THE SYSTEM SHALL return at minimum one entry of `kind: functional_spec` and one entry of `kind: architecture_decision` confirming both planes are represented.

## Notes

- The exact current state of `fps4/component-auth` documentation is unknown at spec time. The implementing agent must begin with a full file-tree audit before making any moves. If files that should exist (e.g. ADRs for past decisions) are absent, that gap should be flagged to the architect rather than filled speculatively.
- `standards/documentation.yaml` and `standards/naming.yaml` are the authoritative sources for allowed `kind` values and slug rules. If those files are updated after this spec is approved, the implementation should follow the updated versions.
- Content accuracy review (whether the documentation says true things) is deferred and should be raised as a separate work item once the structural refactor is complete.