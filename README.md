# DSH Session Toolkit

Adds two buttons to the DSH conversation header:

| Button | What it does |
| --- | --- |
| ⇄ Workspace | Moves the current session into another registered workspace (optionally archiving the original) |
| ◈ Preset | Switches the Agent preset of the current session — **including sessions that already started** |

Both are things a browser half cannot do alone, which is why this plugin ships a host half as well.

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
because the harness has no "delete session" and no "change session id".

**`agentPresets.select` only accepts a blank session.** It throws `agent-preset/locked` once the session
has run a turn. The plugin tries that official path first, and only when it is refused does it rebind the
same Agent scope through `agentPresets.recompose(agent.ctx, id)` and write the `agent-preset/selected`
event that call would have written. History is not rewritten; projections and browser tabs follow.

## Channels

The browser half calls two host routes of this package with relative-URL `fetch` (deliberately not
session commands, so nothing lands in the session log as `command/run`):

- `POST /session-toolkit/migrate` — `{ sessionId, workspaceId, archiveSource?, agentPreset? }`
- `POST /session-toolkit/preset` — `{ sessionId, agentPreset }`

Both pass `connection.requestRejection` (login cookie / loopback / same-site checks) first, accept
`application/json` only, and cap the body at 64 KiB.

## Known limits

- A migration produces a **new session id**; the original history is untouched. To get it back, unarchive
  the source session in its original workspace.
- Switching the preset changes the system prompt and tool catalog of the next request, so the provider's
  prefix cache is invalidated from the first token. While a turn is running the route answers
  `session-busy`.
- Switching the preset does not switch the model: model choice belongs to the session, not to the preset.

## License

MIT
