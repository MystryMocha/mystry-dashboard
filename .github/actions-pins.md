# Pinned GitHub Actions SHAs

Third-party Actions are referenced by full commit SHA (not floating tags), to reduce the risk of supply chain tampering. When updating a SHA, check it against the upstream release/tag notes and record the review date in this table.

| Action | Reference tag | Commit SHA | Review date |
|--------|----------|------------|----------|
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 2026-10-21 |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0) | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | 2026-10-21 |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | 2026-10-21 |
| [actions/download-artifact](https://github.com/actions/download-artifact/releases/tag/v8.0.2) | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | 2026-10-21 |

The repository no longer uses Dependabot to check for Actions updates automatically (the private repository's Actions quota ran out and the config was removed). When an upgrade is needed, check the upstream release manually, review the changes, and write the new SHA into this table and the workflows.
