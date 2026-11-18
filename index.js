/**
 * Session toolkit: move a Session into another workspace, switch the Agent
 * preset of a Session that has already started, and retry a turn whose model
 * request failed or was interrupted.
 *
 * The operations need the Host plane:
 * - a workspace membership is derived from the Session header's `cwd`, and the
 *   header is immutable, so "moving" a Session means opening a seeded
 *   continuation of it at the target directory (the same mechanism the shipped
 *   fork uses) and archiving the source;
 * - `agentPresets.select` refuses a Session that already started its first
 *   turn, while the underlying `recompose` has no such gate;
 * - the driver has no empty-wake primitive, so "retry" sends an inbox message
 *   whose `runtime-context` source kind keeps it off the model-visible
 *   surface: the turn opens, the step claims and drops the envelope, and the
 *   request is assembled from the untouched surface, which already ends with
 *   the unanswered user message. A second path catches live request failures
 *   in the `agent/request-error` waterfall and asks the user, re-running the
 *   same step in place when they pick retry.
 *
 * The browser half reaches these through small POST routes instead of a
 * Session command, so nothing is written into the transcript.
 */

import { randomUUID } from 'node:crypto';

const MIGRATE_PATH = '/session-toolkit/migrate';
const PRESET_PATH = '/session-toolkit/preset';
const RETRY_PATH = '/session-toolkit/retry';
const MAX_BODY_BYTES = 64 * 1024;

const RETRYABLE_REASONS = new Set(['error', 'interrupted', 'aborted']);
const RETRY_QUESTION_ID = 'session-toolkit-retry';
const RETRY_OPTION = '重试';
const ABANDON_OPTION = '放弃';

export const inject = [
  'webServer',
  'connection',
  'agents',
  'agentPresets',
  'sessionProjections',
  'sessionQuery',
  'workspaceRegistry',
  'userQuestions',
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
 *
 * A session that never touched the model picker has no `model/selection`
 * event; there the model lived in the `config` of each `request/header`
 * event, which is also where the `modelSelection` projection reads
 * `lastUsed` from, so that is the fallback. Without either the copy is
 * created without options and `{{model}}` in the persona prefix has no
 * value, failing the first assembly.
 */
function optionsFrom(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const options = {};
  if (typeof data.provider === 'string') options.provider = data.provider;
  if (typeof data.model === 'string') options.model = data.model;
  if (typeof data.reasoningEffort === 'string') options.reasoningEffort = data.reasoningEffort;
  if (typeof data.maxTokens === 'number') options.maxTokens = data.maxTokens;
  return options.provider === undefined || options.model === undefined ? undefined : options;
}

function lastModelOptions(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'model/selection') {
      const options = optionsFrom(event.data);
      if (options !== undefined) return options;
    } else if (event.type === 'request/header') {
      const options = optionsFrom(event.data?.header?.config);
      if (options !== undefined) return options;
    }
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

/**
 * Re-run the last turn's unanswered request without adding anything to the
 * model-visible surface.
 *
 * After a failed or interrupted turn the surface already ends with the user
 * message that never got an answer (the failed attempt only leaves
 * non-surface `assistant/attempt` records), so nothing has to be removed. The
 * driver, however, only starts a turn when a wake arrives with a message, and
 * a turn whose claimed batch is empty closes immediately. The wake therefore
 * rides on a message whose source kind is `runtime-context`: the claim loop
 * admits every claimed message except those to the surface, so the model sees
 * exactly the request that failed, while the non-empty batch keeps the turn
 * open. The envelope id must be unique because the inbox refuses duplicates.
 *
 * Guards: the session must be live, no turn may be open, and the last
 * `turn/end` must carry a retryable reason (error / interrupted / aborted).
 * A `turn/start` seen before any `turn/end` means the scan raced a new turn,
 * which the turnBoundary guard already rejects, so the loop only needs to
 * stop early there defensively.
 */
async function retryTurn(ctx, body) {
  const sessionId = requireString(body, 'sessionId');
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    throw fail(409, 'session-not-live', 'the session is not loaded in the host; open it again and retry');
  }

  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
  if (boundary !== undefined && boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined) {
    throw fail(409, 'session-busy', 'a turn is running in this session; retry when it finishes');
  }

  const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
  let end;
  const events = observation.events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index].type;
    if (type === 'turn/end') {
      end = events[index];
      break;
    }
    if (type === 'turn/start') break;
  }
  const kind = end?.data?.reason?.kind;
  if (end === undefined || typeof kind !== 'string' || !RETRYABLE_REASONS.has(kind)) {
    throw fail(409, 'nothing-to-retry', 'the last turn did not end with a retryable failure');
  }

  agent.send(
    {
      id: `stk-wake-${randomUUID()}`,
      role: 'user',
      content: [],
      source: { kind: 'runtime-context' },
    },
    'next-turn',
    true,
  );
  return { ok: true, turn: end.data.turn, reason: kind };
}

/**
 * Offer an in-place retry while the failed turn is still open.
 *
 * The listener sits downstream of the shipped recoveries (provider retry
 * budget, compaction on context overflow, image offload) because waterfall
 * dispatch is outermost-first and each of those delegates when it gives up.
 * Whatever reaches this point would otherwise close the turn with an error,
 * so the user is asked through the Host's own question channel: answering
 * RETRY re-runs the same step without touching the log, anything else
 * delegates and the ordinary turn error applies.
 *
 * Settling is guaranteed even if nobody ever answers: the payload signal
 * aborts with the turn (including Host disposal) and rejects the ask, and
 * answerers that cannot serve this agent (a delegated subagent, a missing
 * provider) reject as well, so both paths fall through to `next()`.
 */
function registerRequestRecovery(ctx) {
  ctx.on('agent/request-error', async (payload, next) => {
    const { agent, failure, provider, signal } = payload;
    if (signal.aborted) return next();
    let answer;
    try {
      answer = await ctx.userQuestions.ask({
        agent,
        signal,
        questions: [
          {
            id: RETRY_QUESTION_ID,
            header: '请求失败',
            question: `模型请求失败（${provider}）。要在本步重试吗？`,
            detail: typeof failure?.message === 'string' ? failure.message : String(failure?.code ?? ''),
            options: [
              { label: RETRY_OPTION, description: '在同一轮同一步重新发起这次请求' },
              { label: ABANDON_OPTION, description: '结束本轮，保留错误记录' },
            ],
          },
        ],
      });
    } catch {
      return next();
    }
    const selected = answer?.answers?.find((item) => item.id === RETRY_QUESTION_ID)?.selected;
    if (Array.isArray(selected) && selected.includes(RETRY_OPTION)) return { kind: 'retry' };
    return next();
  });
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
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RETRY_PATH,
        handler: (req, res) => dispatch(ctx, req, res, rejected, retryTurn),
      }),
    `session-toolkit: POST ${RETRY_PATH}`,
  );
  registerRequestRecovery(ctx);
}
