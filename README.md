# DSH Session Toolkit

Adds two buttons to the DSH conversation header, plus a retry action on interrupted turns:

| Button | What it does |
| --- | --- |
| ⇄ Workspace | Moves the current session into another registered workspace (optionally archiving the original) |
| ◈ Preset | Switches the Agent preset of the current session — **including sessions that already started** |
| ↻ Retry | Appears on a turn that ended in error / interrupted / aborted; re-runs the last request **without sending a new message** |

All three are things a browser half cannot do alone, which is why this plugin ships a host half as well.

## Install

From the plugin market (search for "Session Toolkit"), or by hand:

```powershell
dsh plugin --profile web add https://github.com/QqiqiQ/dsh-session-toolkit/releases/latest/download/dsh-session-toolkit.tgz
```

Then restart `dsh web`.

## Why a host half is required

**Workspace membership is derived, not stored.** A session belongs to a workspace because the `cwd` in
its `session header` equals the workspace path — `dsh-workspace`'s `sessionIds` getter filters on that
condition every time, and `attachSession` refuses a session whose cwd does not match. The header is
immutable and no API rewrites `cwd`, so "moving" a session means **opening a continuation session in the
target directory that carries the whole history**:

```
sessionQuery.readSession
  → agents.create({ seed, inheritedEventCount,
                    meta: { cwd: targetPath, parentSession: sourceId, isSeeded: true } })
  → workspace.attachSession(newId)      // its header cwd is the target path, so it survives a restart
  → optional archiveSession(sourceId)
```

The new session keeps fork provenance (`parentSession`, `isSeeded`, the `session/end-seed` marker),
because the harness has no "delete session" and no "change session id". It also starts on the model the
source last used — read from the last `model/selection` event, or, when the picker was never touched,
from the `config` of the last `request/header` event — because the persona prefix's `{{model}}` variable
only resolves from the options the Agent was created with.

**`agentPresets.select` only accepts a blank session.** It throws `agent-preset/locked` once the session
has run a turn. The plugin tries that official path first, and only when it is refused does it rebind the
same Agent scope through `agentPresets.recompose(agent.ctx, id)` and write the `agent-preset/selected`
event that call would have written. History is not rewritten; projections and browser tabs follow.

**A retry is a shoulder tap, not a message.** After a failed or interrupted turn, the model-visible
surface already ends with the user message that never got an answer — the failed attempt only leaves
non-surface `assistant/attempt` records. The driver, though, only starts a turn when a wake arrives with
a message. So the retry route sends an inbox message whose `source.kind` is `runtime-context`: the turn
opens, the step claims the envelope and deliberately keeps it off the surface (the code path that exists
for expired runtime-context snapshots), and the request is assembled from the untouched surface — byte
for byte the request that failed. No "continue" bubble, no log duplication, same session id.

There is also an earlier, synchronous chance: while the failed turn is still open, the plugin listens on
the `agent/request-error` waterfall downstream of the shipped recoveries (provider retry budget,
compaction, image offload) and asks through the host's own question card. Answering 重试 returns
`{ kind: 'retry' }`, which re-runs the same step inside the still-open turn; anything else delegates and
the ordinary turn error applies. The turn's abort signal guarantees the wait always settles.

## Channels

The browser half calls three host routes of this package with relative-URL `fetch` (deliberately not
session commands, so nothing lands in the session log as `command/run`):

- `POST /session-toolkit/migrate` — `{ sessionId, workspaceId, archiveSource?, agentPreset? }`
- `POST /session-toolkit/preset` — `{ sessionId, agentPreset }`
- `POST /session-toolkit/retry` — `{ sessionId }` → `{ ok, turn, reason }`

All pass `connection.requestRejection` (login cookie / loopback / same-site checks) first, accept
`application/json` only, and cap the body at 64 KiB. The retry route answers `session-busy` while a turn
is open and `nothing-to-retry` unless the last turn ended with `error`, `interrupted` or `aborted`.

## Known limits

- A migration produces a **new session id**; the original history is untouched. To get it back, unarchive
  the source session in its original workspace.
- Switching the preset changes the system prompt and tool catalog of the next request, so the provider's
  prefix cache is invalidated from the first token. While a turn is running the route answers
  `session-busy`.
- Switching the preset does not switch the model: model choice belongs to the session, not to the preset.
- Retry re-runs the failed request, so the output tokens are paid again; the input side stays cached
  because the surface is byte-identical. A retry after `aborted` likewise replays the last user message.
- The in-turn question card only appears for failures the automatic retry budget already gave up on, and
  only where the question channel has an answerer (the GUI); elsewhere the failure behaves as before.

## License

MIT
