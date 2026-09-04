# Message Delivery & the `<internal>` Filter

How agent output reaches a chat, why there are **two** paths, and why only one of them is
filtered. Read this before writing a scheduled task that is supposed to stay quiet.

## The two paths

| Path | Code | `<internal>` stripped? | Timing |
|---|---|---|---|
| **Final output** — whatever the agent returns when the container finishes | `task-scheduler.ts` → `index.ts` `sendMessage` → `formatOutbound()` → `router.ts` `stripInternalTags()` | **Yes.** If nothing survives the strip, `formatOutbound` returns `''` and **no message is sent.** | After the run completes |
| **`mcp__nanoclaw__send_message`** — the agent calling the tool mid-run | `ipc.ts` → `index.ts` `startIpcWatcher({ sendMessage })` → `channel.sendMessage()` **directly** | **No.** The text is passed through verbatim. | Immediately, mid-run |

The filtering lives in `formatOutbound()`, and **only the final-output path calls it**. The IPC
watcher's `sendMessage` hands the text straight to the channel:

```ts
// src/index.ts — scheduler path (filtered)
sendMessage: async (jid, rawText) => {
  const text = formatOutbound(rawText);   // strips <internal>, may return ''
  if (text) await channel.sendMessage(jid, text);
}

// src/index.ts — IPC / send_message path (NOT filtered)
sendMessage: (jid, text) => {
  return channel.sendMessage(jid, text);  // verbatim, no strip
}
```

This is by design — `send_message` exists precisely for immediate delivery while the agent is
still working, so buffering or filtering it would defeat its purpose. But it means:

> **`<internal>` can only suppress the final output. It cannot un-send a `send_message` call.**

## Making a scheduled task actually silent

**The robust way: set the task's `silent` flag.** A task with `silent = 1` in
`scheduled_tasks` never has its final output delivered — `task-scheduler.ts` skips the
send entirely, `<internal>` tags or not. The only way such a task can reach the chat is
an explicit `send_message` call. Set it at creation (`schedule_task` with `silent: true`),
later (`update_task`), or directly in SQLite. Use it for any task that should only speak
deliberately: alerting jobs, background maintenance.

The flag exists because the prompt-only approach below is enforced by nothing but the
model remembering it. The Health Watchdog ran for months on prompt instructions and still
leaked a bare "all checks passed" line to the Alerts group roughly one run in ten — the
agent wrote its "staying silent" note without the `<internal>` wrapper (observed
2026-09-03/04, e.g. runs 22:03 and 05:03). A 2026-09-04 audit found the same leak on the
Beacon weekday/weekend reports and Ticket Event Discovery; since then **every active
scheduled task runs with `silent = 1`**, with prompts that route any intentional message
through `send_message`. Keep it that way for new tasks unless a task genuinely wants its
final output delivered.

**The prompt-only way** (still required for the `send_message` half): a task is silent
only if **both** are true:

1. It never calls `send_message` — not even an acknowledgment.
2. Its entire final output is wrapped in `<internal>…</internal>` — unnecessary when
   `silent = 1`, load-bearing otherwise.

Miss #1 and the task still messages the user every run, no matter how carefully the final
output is wrapped. Note the error path is separately silent: `task-scheduler.ts` sends only
`if (result && !error)`, so a failed run notifies nobody and lands only in `task_run_logs`.

## The trap: a global "always acknowledge" rule

`groups/global/CLAUDE.md` is injected into every non-main group, and it tells agents to send a
brief acknowledgment via `send_message` before long-running work. That instruction is right for
chat-initiated work and **wrong for unattended runs** — so it is now explicitly scoped to
requests a person made in chat, with scheduled runs told to stay quiet unless their own
instructions say otherwise.

This was a live bug in the Recipe Club nightly builder (Mar–Aug 2026). Its `nightly-task.md`
said to "exit silently without creating a branch, PR, or message", and it obeyed perfectly on
the final-output path — 111 of 137 runs returned pure `<internal>`. But it also obeyed the
global ack rule, calling `send_message` at msg #6 of *every* run, before it had even decided
whether to skip. The owner got a message every night on a job that built nothing for months.

Both symptoms were real at once, which is what made it confusing to diagnose: the run log
showed a correctly-suppressed final output while the chat showed a nightly message. **When
auditing whether a task is silent, `task_run_logs.result` is not sufficient — check the
container log for `send_message` calls:**

```bash
grep -c "nanoclaw__send_message" groups/<group>/logs/container-<timestamp>.log
```

## Writing the prompt

The `create_scheduled_task` tool description already asks you to state the messaging policy in
the prompt. Be explicit about the acknowledgment, because the global rule pulls the other way:

- **Always report** — "Send a summary every run, even if nothing changed."
- **Only when there's something** — "Send no message when there's nothing to report. That
  includes the acknowledgment: make no `send_message` call, and wrap your entire final output
  in `<internal>` tags."
- **Never** — "This is background maintenance. Never send a message; wrap all output in
  `<internal>`."
