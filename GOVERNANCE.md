<!--
Copyright (c) 2026 Erick Bourgeois, Recess
SPDX-License-Identifier: Apache-2.0
-->
# Governance

How Recess is run today, and how that changes as it grows.

## Mission

Recess shows a workload going through mediatore, from minting the token to the exit code,
with every secret on the map: in a browser (AgentSandbox, AgentSandbox Admin and Kubernetes views) and in a
terminal. It is a window onto mediatore, not a part of its trust path.

## Roles

**Users** run Recess and shape it through issues and feedback.

**Contributors** submit changes: code, docs, reviews, triage. Anyone can contribute; see
[CONTRIBUTING.md](CONTRIBUTING.md).

**Maintainers** are listed in [MAINTAINERS.md](MAINTAINERS.md). They review and merge pull
requests, cut releases, triage security reports under [SECURITY.md](SECURITY.md), and enforce
the [Code of Conduct](CODE_OF_CONDUCT.md). Review ownership by path is in
[`.github/CODEOWNERS`](.github/CODEOWNERS).

## How decisions are made

- **Day to day: lazy consensus.** A pull request that has passed CI and maintainer review
  merges unless a maintainer objects. Once there are two or more maintainers, a change needs
  approval from a maintainer other than its author.
- **Design: in mediatore first.** A change that needs mediatore to expose something new (a
  status field, a condition, a log line) is proposed there as an ADR; Recess follows once it
  lands. [docs/cross-references.md](docs/cross-references.md) lists the ones wanted today.
- **When consensus fails: a vote.** Any maintainer may call one on the issue or pull request.
  It passes with a simple majority of all maintainers, open for at least five business days.
  With a single maintainer, that maintainer decides and records the reasoning in the pull
  request.
- **Changes to this document** need a two-thirds majority of maintainers.

## Becoming a maintainer

A contributor becomes a maintainer after several months of sustained, careful contributions
and reviews, and of working by the Code of Conduct. Any maintainer may nominate them; the
nomination passes with a two-thirds majority of the existing maintainers, and the new
maintainer is added to [MAINTAINERS.md](MAINTAINERS.md) and `.github/CODEOWNERS` in the same
pull request. A maintainer may step down at any time and becomes emeritus.

## Releases

Releases are cut from `main` by a maintainer, tagged `vX.Y.Z`
([Semantic Versioning](https://semver.org/)), and published by CI with the binaries and their
SHA-256 sums. Before 1.0, only the latest release and `main` are supported.
