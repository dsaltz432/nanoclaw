# docs/local/

Personal/install-specific documentation for this NanoClaw fork. **Not part
of the upstream NanoClaw framework** — these docs describe how *this
specific install* is configured, which groups exist, which dashboard
routes hard-code which paths, and so on.

## Purpose

Two things:

1. **Runbook for future-me.** When something breaks at 2am or I come back
   to this install after a long gap, this is the first place I read. The
   upstream `docs/` covers the framework; this covers my specific choices
   on top of it.
2. **Backup mechanism.** Committed to my fork (`origin = dsaltz432/nanoclaw`)
   so GitHub stores a durable copy. If my machine dies, this doc plus the
   code at the same commit tells me how to rebuild the install.

## What lives here

| File | Purpose |
|---|---|
| [`multi-group-architecture.md`](./multi-group-architecture.md) | The multi-group layout: six groups, the three-question rubric that drove the split, dashboard hard-coding constraints, and a runbook for adding a new group. |

## Upstream PR hygiene — IMPORTANT

**Never include `docs/local/**` in a PR to `upstream/main`.** These docs are
specific to this install and would pollute the upstream framework repo.

Remotes on this install:
- `origin` → `github.com:dsaltz432/nanoclaw.git` (my fork — docs/local/ goes here)
- `upstream` → `github.com:qwibitai/nanoclaw.git` (the framework — do NOT push docs/local/ here)

Before any upstream PR:

```bash
git diff upstream/main...HEAD -- docs/local/   # should be empty
```

If it isn't empty, either rebase those commits off the PR branch or
cherry-pick only the non-`docs/local/` commits. Don't merge `docs/local/`
into an upstream PR branch.

## Conventions for docs in this directory

- **Assume the reader has the repo checked out at the same commit.** If a
  doc references a file or line number, that reference is valid *at the
  commit the doc was last updated*, not forever.
- **Prefer absolute file paths** (from repo root) over relative ones.
- **Link to commits by SHA** when describing historical changes, so the
  link stays stable across branch renames.
- **Treat these as living docs.** When the install changes (new group, new
  task, new dashboard hard-coding), update the relevant doc as part of
  that change — not as a separate follow-up.
