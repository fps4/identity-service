# component-auth

`component-auth` is a shared authentication component maintained as part of the
**Shared Components** product. Its documentation follows the Maestro
documentation standard: a two-plane information architecture, a single
navigation entry point, and machine-readable `maestro:` frontmatter on every
indexed artefact.

## Documentation layout

All documentation lives under [`docs/`](docs/README.md), split across two
shelves plus a decisions folder:

| Shelf | Path | Holds |
| --- | --- | --- |
| **Product** | [`docs/product/`](docs/product/README.md) | What the component does: functional specs and product-facing material. |
| **Architecture** | [`docs/architecture/`](docs/architecture/README.md) | How the component is built: technical designs and decision records. |
| Decisions | [`docs/architecture/decisions/`](docs/architecture/decisions/README.md) | Architecture Decision Records, one per file, named `NNNN-<slug>.md`. |

### Preferred documentation path

- Product-facing material goes under `docs/product/` (functional specs in `docs/product/specs/`).
- Technical designs and decisions go under `docs/architecture/` (ADRs in `docs/architecture/decisions/`).
- File names are lowercase, hyphen-separated slugs ending in `.md`; ADR files are additionally prefixed by a four-digit sequence number.
- Every artefact intended for the workspace index carries a `maestro:` frontmatter block with `feature`, `kind`, and a plain-language `summary`.

Start at the [documentation index](docs/README.md) for the full map of both shelves.
