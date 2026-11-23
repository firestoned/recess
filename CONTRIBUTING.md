<!--
Copyright (c) 2026 Erick Bourgeois, Recess
SPDX-License-Identifier: Apache-2.0
-->
# Contributing to Recess

Thank you for helping. This page covers what every contribution needs, how a change gets in,
and how to build and test it.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues
do **not** go in public issues or pull requests: report them privately as described in
[SECURITY.md](SECURITY.md).

## Every commit: sign-off (DCO) and signature

Recess uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO)
instead of a CLA. A sign-off certifies that you wrote the change, or otherwise have the right
to submit it under the project's [Apache-2.0 licence](LICENSE).

**Every commit needs both:**

1. **A `Signed-off-by:` trailer** matching the commit author (`git commit -s`).
2. **A cryptographic signature**, GPG or SSH (`git commit -S`). CI verifies signatures on
   every pull request, and a pull request with an unsigned commit cannot merge.

```sh
git commit -s -S -m "fix(web): describe the change"
```

To fix commits that are missing either, rewrite your branch before pushing again:

```sh
git rebase --signoff -S origin/main
git push --force-with-lease
```

## Pull requests

- One logical change per pull request.
- [Conventional Commits](https://www.conventionalcommits.org/) for subjects
  (`feat(scope): …`, `fix(scope): …`, `docs: …`), kept short, with the detail in the body.
- Say what changed and why, and how you tested it. For a change to a view, a screenshot or a
  short recording helps.
- Tests come with the change, written first for a bug fix.
- Every source file carries an SPDX header (`SPDX-License-Identifier: Apache-2.0`); CI
  enforces it.

## Rules worth knowing before you write code

- **Never show a secret.** No token, refresh material or private key reaches the browser, the
  terminal or a log; Secrets are read as metadata only. See
  [What it never does](README.md#what-it-never-does).
- **Never commit real infrastructure identifiers.** No real hostnames, IP addresses, user
  names or account IDs in code, tests, docs or commit messages: use placeholders
  (`bar.foo.io`, the RFC 5737 addresses).
- **Recess only reads the cluster.** It watches and lists what mediatore and banlieue publish;
  anything it changes (a claim, its release) goes through mediatore's broker as the signed-in
  user, never through the Kubernetes API. When a view needs data that is not there, propose the status field
  upstream (see [docs/cross-references.md](docs/cross-references.md)) rather than working
  around it.
- **Both web views share one theatre** (`assets/theatre.js`): a station or an edge common to
  AgentSandbox and Admin goes there, not into one view.

## Building and testing

```sh
make check   # fmt, clippy (pedantic, -D warnings), tests, cargo-deny
make demo    # the scripted run in a browser, no cluster needed
```

`recess web --demo` serves every view against scripted data, including the Admin view, so most
UI work needs no cluster. CI (`.github/workflows/build.yaml`) runs the same targets, plus the
licence headers, commit signatures and cargo-audit.

## Getting help

Open a [GitHub issue](https://github.com/firestoned/recess/issues) for bugs and feature
requests, or a draft pull request to discuss a change in code. How decisions are made, and how
to become a maintainer, is in [GOVERNANCE.md](GOVERNANCE.md).
