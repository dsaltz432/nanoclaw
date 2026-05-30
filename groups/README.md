# groups/

Per-group state. Each registered channel/group gets its own folder here, providing
**filesystem and memory isolation** — a running agent only ever has its own group folder
(plus, for non-main groups, read-only global memory) mounted into its container.

## Memory layout

| Path | What it is | Loaded into the agent how |
|------|------------|---------------------------|
| `groups/{name}/CLAUDE.md` | **Per-group memory** | The group folder is the agent's `cwd`, so the Claude Agent SDK auto-loads it. Writable by that group. |
| `groups/{name}/*.md`, files | Group working files | Read/written by that group as normal files. |
| `groups/global/CLAUDE.md` | **Global memory** (shared facts/preferences) | Bind-mounted read-only at `/workspace/global` and **appended to the system prompt — for non-main groups only**. Not loaded via directory walk. |

Notes:
- **Global memory is read-only to every container.** The non-main mount is read-only, and the
  `main` group never mounts it at all. To change global memory, edit
  `groups/global/CLAUDE.md` on the host.
- The repo-root `CLAUDE.md` is **not** group/global memory and is never loaded into a runtime
  agent — it's Claude Code project instructions for developers working on the repo.

Full mechanism (cwd, `settingSources`, mounts, the main vs. non-main split):
[docs/SPEC.md → Memory System](../docs/SPEC.md#memory-system). Implementation:
`src/container-runner.ts` (mounts) and `container/agent-runner/src/index.ts` (injection).
