# Documentation

This is the navigation entry point for the `component-auth` documentation. The
set follows the Maestro two-plane information architecture: a **Product** shelf
for what the component does, and an **Architecture** shelf for how it is built.
This index page is navigation only and is not itself indexed in the workspace
SpecIndex.

## Shelves

### Product — `docs/product/`

What the component does. See the [Product shelf index](product/README.md).

- Functional specs live in `docs/product/specs/`.

### Architecture — `docs/architecture/`

How the component is built. See the [Architecture shelf index](architecture/README.md).

- Technical designs live directly under `docs/architecture/`.
- Decision records live in `docs/architecture/decisions/` — see the [decisions index](architecture/decisions/README.md).

## How documentation is organised

- **Paths** follow the two-plane layout above: product material under `docs/product/`, technical material under `docs/architecture/`.
- **File names** are lowercase, hyphen-separated slugs (no underscores) ending in `.md`. ADR files are prefixed by a four-digit sequence number, for example `0001-example-decision.md`.
- **Frontmatter** — every artefact intended for the SpecIndex carries a `maestro:` block with `feature`, `kind`, and a plain-language `summary` (at most 120 words and 800 characters, with no markdown, links, code, EARS keywords, or acceptance-criteria ids). Navigation pages such as this index and the shelf READMEs are unlisted and carry no frontmatter.

## Migration status

The shelves, decisions folder, and navigation are in place. Pages that pre-date
this standard are moved into the correct shelf and given frontmatter as part of
a live-tree audit of the repository's current files. Until that audit is
complete, any page not yet linked above must be classified and moved before the
branch is approved. Where a past decision has no record at all, raise the gap
with the architect rather than reconstructing it.
