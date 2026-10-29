/**
 * Session toolkit: move a Session into another workspace, and switch the Agent
 * preset of a Session that has already started.
 *
 * Both operations need the Host plane:
 * - a workspace membership is derived from the Session header's `cwd`, and the
 *   header is immutable, so "moving" a Session means opening a seeded
 *   continuation of it at the target directory (the same mechanism the shipped
 *   fork uses) and archiving the source;
 * - `agentPresets.select` refuses a Session that already started its first
 *   turn, while the underlying `recompose` has no such gate.
 *
 * The browser half reaches these through two small POST routes instead of a
 * Session command, so nothing is written into the transcript.
 */

import { randomUUID } from 'node:crypto';

const MIGRATE_PATH = '/session-toolkit/migrate';
const PRESET_PATH = '/session-toolkit/preset';
const MAX_BODY_BYTES = 64 * 1024;

export const inject = [
  'webServer',
  'connection',
  'agents',
  'agentPresets',
  'sessionProjections',
  'sessionQuery',
  'workspaceRegistry',
];

/** A failure that maps to one HTTP status and one stable error code. */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  return new RouteError(status, code, message);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendJson(res, 405, { error: { code: 'method-not-allowed', message: `expected ${allow}` } });
}

/** Read a bounded JSON body; `undefined` result codes stay distinguishable. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return { ok: false, code: 'payload-too-large' };
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'invalid-json' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: 'invalid-json' };
  }
}

function requireString(body, key) {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw fail(400, 'invalid-request', `"${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * The Host connection service fences every browser request (login-token cookie,
 * loopback and same-site checks). A rejected request never reaches an operation.
 */
function makeRejection(ctx) {
  const connection = Reflect.get(ctx, 'connection');
  return (req, res) => {
    const rejection = connection?.requestRejection?.(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}

async function dispatch(ctx, req, res, rejected, operation) {
  try {
    if (rejected(req, res)) return;
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, 'POST');
      return;
    }
    const media = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (media !== 'application/json') {
      sendJson(res, 415, {
        error: { code: 'unsupported-media-type', message: 'expected application/json' },
      });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.code === 'payload-too-large' ? 413 : 400, {
        error: {
          code: body.code,
          message:
            body.code === 'payload-too-large'
              ? `request body exceeds ${MAX_BODY_BYTES} bytes`
              : 'request body is not a JSON object',
        },
      });
      return;
    }
    sendJson(res, 200, await operation(ctx, body.value));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'internal';
    sendJson(res, status, { error: { code, message: String(error?.message ?? error) } });
  }
}

function findWorkspace(workspaces, id) {
  return workspaces.find((workspace) => workspace.id === id);
}

/**
 * The model belongs to the Session, not to the preset, so the copy starts on
 * the model the source last used. Unknown fields are dropped on purpose: the
 * Agent only accepts the four documented options.
 */
function lastModelOptions(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'model/selection') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const options = {};
    if (typeof data.provider === 'string') options.provider = data.provider;
    if (typeof data.model === 'string') options.model = data.model;
    if (typeof data.reasoningEffort === 'string') options.reasoningEffort = data.reasoningEffort;
    if (typeof data.maxTokens === 'number') options.maxTokens = data.maxTokens;
    return Object.keys(options).length === 0 ? undefined : options;
  }
  return undefined;
}

/**
 * Copy the Session's log into a new Session whose header cwd is the target
 * workspace path, then record the membership there.
 *
 * `readSession` returns a contiguous log from seq 0 and never makes the source
 * live. The seeded header carries an inherited cut at the copy length and the
 * log ends with the `session/end-seed` marker that marker-aware readers check,
 * so the copy stays self-contained and reopens without the source.
 */
async function migrate(ctx, body) {
  const sessionId = requireString(body, 'sessionId');
  const workspaceId = requireString(body, 'workspaceId');
  const archiveSource = body.archiveSource !== false;
  const requestedPreset =
    typeof body.agentPreset === 'string' && body.agentPreset.length > 0 ? body.agentPreset : undefined;

  const workspaces = await ctx.workspaceRegistry.list();
  const target = findWorkspace(workspaces, workspaceId);
  if (target === undefined) {
    throw fail(404, 'workspace-not-found', `no workspace registered for '${workspaceId}'`);
  }
  if ((await target.status()) !== 'ok') {
    throw fail(409, 'workspace-missing-dir', `the directory of workspace '${target.title}' is missing`);
  }

  const snapshot = await ctx.sessionQuery.readSession(sessionId);
  const header = snapshot.session;
  if (header.cwd === target.path) {
    throw fail(409, 'already-in-workspace', 'the session already belongs to that workspace');
  }

  const presetId = (await ctx.agentPresets.resolve(requestedPreset ?? header.agentPreset)).id;

  const events = snapshot.events;
  const cut = events.length;
  const seed = events.slice();
  seed.push({
    type: 'session/end-seed',
    seq: cut,
    time: events[cut - 1]?.time ?? Date.now(),
    data: { inherited: true },
  });

  const copyId = `session-${randomUUID()}`;
  const agentOptions = lastModelOptions(events);
  await ctx.agents.create({
    sessionId: copyId,
    seed,
    inheritedEventCount: cut,
    meta: {
      cwd: target.path,
      parentSession: sessionId,
      isSeeded: true,
      agentPreset: presetId,
    },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, presetId);
    },
  });
  await target.attachSession(copyId);

  let archived = false;
  if (archiveSource) {
    await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
    archived = true;
  }

  return {
    sessionId: copyId,
    agentPreset: presetId,
    archived,
    eventCount: cut,
    workspace: { id: target.id, path: target.path, title: target.title },
  };
}

/**
 * Switch one live Session onto another preset.
 *
 * `select` is the official path and its blank-session gate is what the harness
 * wants a plugin to respect, so it runs first. Only when it reports
 * `agent-preset/locked` (the Session already started) does the operation rebind
 * the same Agent scope and record the same `agent-preset/selected` event that
 * `select` would have recorded, which is what makes the projection and the
 * browser label follow. Nothing re-reads that event to re-compose, so this is
 * not a loop.
 */
async function switchPreset(ctx, body) {
  const sessionId = requireString(body, 'sessionId');
  const requested = requireString(body, 'agentPreset');
  const preset = await ctx.agentPresets.resolve(requested);

  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    throw fail(409, 'session-not-live', 'the session is not loaded in the host; open it again and retry');
  }

  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
  if (boundary !== undefined && boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined) {
    throw fail(409, 'session-busy', 'a turn is running in this session; retry when it finishes');
  }

  try {
    return { agentPreset: await ctx.agentPresets.select(agent, preset.id), mode: 'select' };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code !== 'agent-preset/locked') {
      throw fail(400, code === '' ? 'preset-failed' : code, String(error?.message ?? error));
    }
  }

  await ctx.agentPresets.recompose(agent.ctx, preset.id);
  agent.session.append('agent-preset/selected', { agentPreset: preset.id });
  return { agentPreset: preset.id, mode: 'recompose' };
}

export function apply(ctx) {
  const rejected = makeRejection(ctx);
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: MIGRATE_PATH,
        handler: (req, res) => dispatch(ctx, req, res, rejected, migrate),
      }),
    `session-toolkit: POST ${MIGRATE_PATH}`,
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PRESET_PATH,
        handler: (req, res) => dispatch(ctx, req, res, rejected, switchPreset),
      }),
    `session-toolkit: POST ${PRESET_PATH}`,
  );
}
