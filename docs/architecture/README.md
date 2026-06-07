# Architecture shelf

The Architecture shelf holds documentation about **how the `component-auth`
component is built**: technical designs and decision records. This index page is
navigation only and is not indexed in the workspace SpecIndex.

## Contents

- **Technical designs** — placed directly under `docs/architecture/`, named `<slug>-design.md`. Each carries `maestro:` frontmatter with `kind: technical_design`.
- **Decision records** — `docs/architecture/decisions/` holds Architecture Decision Records. See the [decisions index](decisions/README.md).

## Conventions

- File names are lowercase, hyphen-separated slugs ending in `.md`.
- ADR files are additionally prefixed by a four-digit sequence number, for example `0001-<slug>.md`.
- Indexed artefacts carry `maestro:` frontmatter with `feature`, `kind`, and a plain-language `summary`.

See the [documentation index](../README.md) and the [Product shelf](../product/README.md).
