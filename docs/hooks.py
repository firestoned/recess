# Copyright (c) 2026 Erick Bourgeois, Recess
# SPDX-License-Identifier: Apache-2.0

"""Links in the included documents, pointed at the site.

The pages are made of the repository's own documents (the README, deploy/README.md,
CONTRIBUTING.md, ...), pulled in by include-markdown, which rewrites each relative link from the
included file's place to the page's. Here each one becomes what it means on the site: a document
that is a page goes to that page; a section of the README to the page that holds it; the media to
the site's copy; anything else in the repository to its file on GitHub.
"""

from __future__ import annotations

import os
import re

REPO_URL = "https://github.com/firestoned/recess/blob/main/"

# Each document that is a page of its own, by its path in the repository.
PAGES = {
    "README.md": "index.md",
    "deploy/README.md": "cluster.md",
    "docs/cross-references.md": "cross-references.md",
    "CONTRIBUTING.md": "contributing.md",
    "CODE_OF_CONDUCT.md": "code-of-conduct.md",
    "SECURITY.md": "security.md",
    "GOVERNANCE.md": "governance.md",
    "MAINTAINERS.md": "maintainers.md",
}

# The README's sections, by anchor, and the page each is on.
SECTIONS = {
    "run": "index.md",
    "the-3d-page": "agentsandbox.md",
    "drilling-in": "agentsandbox.md",
    "arranging-the-theatre": "layout.md",
    "recording-it": "agentsandbox.md",
    "the-admin-view": "admin.md",
    "the-agentsandbox-admin-view": "admin.md",
    "the-kubernetes-view": "kubernetes.md",
    "the-tui": "tui.md",
    "config-file": "configuration.md",
    "kubernetes-access": "configuration.md",
    "build": "build.md",
    "limits": "build.md",
    "what-it-never-does": "security.md",
    "in-a-cluster": "cluster.md",
    "contributing-and-licence": "contributing.md",
}

LINK = re.compile(r"(\]\()([^)\s]+)(\))")
FENCE = re.compile(r"^(```|~~~)")


def _target(link: str, page: str, docs_dir: str, repo: str) -> str:
    if re.match(r"^[a-z][a-z0-9+.-]*:", link) or link.startswith("//"):
        return link
    path, _, anchor = link.partition("#")
    if not path:
        # A section of the page, or of the README when the page holds part of it.
        where = SECTIONS.get(anchor)
        return link if where in (None, page) else f"{where}#{anchor}"
    here = os.path.dirname(os.path.join(docs_dir, page))
    rel = os.path.relpath(os.path.normpath(os.path.join(here, path)), repo).replace(os.sep, "/")
    if rel.startswith("docs/src/"):
        return link
    if rel.startswith("docs/media/"):
        out = "media/" + rel.removeprefix("docs/media/")
    elif rel == "README.md" and anchor in SECTIONS:
        out = SECTIONS[anchor]
    elif rel in PAGES:
        out = PAGES[rel]
    else:
        return REPO_URL + rel + (f"#{anchor}" if anchor else "")
    # Every page is at the root of the site, so a page's link is its name.
    return out + (f"#{anchor}" if anchor else "")


def on_page_markdown(markdown, page, config, files):  # noqa: ARG001 (the hook's signature)
    docs_dir = config["docs_dir"]
    repo = os.path.normpath(os.path.join(docs_dir, "..", ".."))
    out, fenced = [], False
    for line in markdown.split("\n"):
        if FENCE.match(line.lstrip()):
            fenced = not fenced
        if not fenced:
            line = LINK.sub(lambda m: m[1] + _target(m[2], page.file.src_uri, docs_dir, repo) + m[3], line)
        out.append(line)
    return "\n".join(out)
