/**
 * Session toolkit — browser half.
 *
 * Two Session-header utilities:
 *   - move the open Session into another workspace;
 *   - switch the Agent preset of the open Session, started or not.
 *
 * Both call the package's own Host routes with a relative fetch, so the Host
 * half owns every store mutation and this half only renders the outcome.
 */

// The loader keys registration by the package name, so this literal is not
// decoration: rename the package and every copy of it has to move with it.
// Declared once and reused below, because the CSS-tag identity is the second
// place that silently carries the same name.
const PACKAGE_ID = '@qqiqiq/dsh-session-toolkit';

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-toolkit';
    const UTILITIES = 'conversation.session.header.utilities';
    const MIGRATE_ROUTE = '/session-toolkit/migrate'.slice(1);
    const PRESET_ROUTE = '/session-toolkit/preset'.slice(1);

    //#region dictionaries
    const zh = {
      'trigger.workspace': '工作区',
      'trigger.workspace.title': '迁移会话到其他工作区',
      'trigger.preset': '预设',
      'trigger.preset.title': '切换 Agent 预设',
      'workspace.title': '迁移到工作区',
      'workspace.current': '当前工作区',
      'workspace.unknown': '会话尚未关联工作区',
      'workspace.empty': '没有其他工作区可迁移',
      'workspace.archive': '迁移后归档原会话',
      'workspace.note': '迁移会在目标目录下生成一个包含完整历史的新会话；原会话按上面的开关处理。',
      'preset.title': '切换 Agent 预设',
      'preset.note': '空白会话立即生效；已开始的会话会重绑插件与提示词，下一条消息生效，并让请求缓存从零重建。',
      'preset.empty': '没有可用预设',
      'preset.standard': '标准模式',
      'preset.ptc': 'PTC 模式',
      'preset.minimal': '极简模式',
      'preset.cordis': '创造模式',
      'badge.default': '默认',
      'badge.current': '当前',
      'badge.broken': '不可用',
      'action.close': '关闭',
      'state.loading': '加载中…',
      'state.pending': '处理中…',
      'notice.workspace': '已迁移到「{title}」',
      'notice.preset': '预设已切换为「{name}」',
      'error.fallback': '操作失败：{message}',
      'error.no-remote': '浏览器无法访问 Host 的预设接口',
      'error.load-roster': '预设列表加载失败',
      'error/session-not-live': '这个会话当前没有在 Host 中加载，重新打开它再试',
      'error/session-busy': '这个会话正在运行，等这一轮结束后再试',
      'error/already-in-workspace': '会话已经在目标工作区里',
      'error/workspace-not-found': '目标工作区不存在',
      'error/workspace-missing-dir': '目标工作区的目录不存在',
      'error/agent-preset/not-found': '找不到这个预设',
      'error/agent-preset/invalid': '这个预设无法组合到会话里',
      'error/agent-preset/locked': '这个会话已经开始，无法按默认方式切换',
      'error/unsupported-media-type': '请求格式不被接受',
      'error/invalid-request': '请求缺少必要参数',
    };
    const en = {
      'trigger.workspace': 'Workspace',
      'trigger.workspace.title': 'Move this Session to another workspace',
      'trigger.preset': 'Preset',
      'trigger.preset.title': 'Switch the Agent preset of this Session',
      'workspace.title': 'Move to workspace',
      'workspace.current': 'Current workspace',
      'workspace.unknown': 'This Session belongs to no workspace',
      'workspace.empty': 'No other workspace to move to',
      'workspace.archive': 'Archive the source Session after moving',
      'workspace.note': 'Moving creates a new Session with the full history under the target directory; the source follows the switch above.',
      'preset.title': 'Switch Agent preset',
      'preset.note': 'A blank Session switches at once. A started Session rebinds plugins and prompt, takes effect on the next message, and rebuilds the request cache.',
      'preset.empty': 'No preset available',
      'preset.standard': 'Standard',
      'preset.ptc': 'PTC',
      'preset.minimal': 'Minimal',
      'preset.cordis': 'Cordis',
      'badge.default': 'default',
      'badge.current': 'current',
      'badge.broken': 'unavailable',
      'action.close': 'Close',
      'state.loading': 'Loading…',
      'state.pending': 'Working…',
      'notice.workspace': 'Moved to “{title}”',
      'notice.preset': 'Preset switched to “{name}”',
      'error.fallback': 'Failed: {message}',
      'error.no-remote': 'The browser cannot reach the Host preset API',
      'error.load-roster': 'Could not load the preset roster',
      'error/session-not-live': 'This Session is not loaded in the Host; open it again and retry',
      'error/session-busy': 'A turn is running in this Session; retry when it finishes',
      'error/already-in-workspace': 'The Session already lives in that workspace',
      'error/workspace-not-found': 'The target workspace does not exist',
      'error/workspace-missing-dir': 'The directory of the target workspace is missing',
      'error/agent-preset/not-found': 'No such preset',
      'error/agent-preset/invalid': 'That preset cannot compose a Session',
      'error/agent-preset/locked': 'This Session already started; the default switch is refused',
      'error/unsupported-media-type': 'The request format was rejected',
      'error/invalid-request': 'The request is missing a required argument',
    };
    //#endregion

    //#region stylesheet
    const css = [
      '.dstk-trigger{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:16px;cursor:pointer}',
      '.dstk-trigger:hover{background:var(--dsw-alias-bg-layer-2,#2a2a2a)}',
      '.dstk-trigger:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px}',
      '.dstk-glyph{color:var(--dsw-alias-label-secondary,#aaa);font-size:12px;line-height:1}',
      '.dstk-scrim{position:fixed;inset:0;z-index:120;background:transparent}',
      '.dstk-panel{position:fixed;z-index:121;box-sizing:border-box;width:320px;max-height:min(60vh,420px);overflow:auto;padding:10px;background:var(--dsw-alias-bg-overlay,#1e1e1e);border:.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-md,8px);box-shadow:0 8px 28px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#eee);font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:18px}',
      '.dstk-title{font-size:12px;font-weight:600;margin:0 0 8px}',
      '.dstk-option{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dstk-option:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#2a2a2a)}',
      '.dstk-option:disabled{cursor:default;opacity:.55}',
      '.dstk-option-row{display:flex;align-items:center;gap:6px}',
      '.dstk-option-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dstk-option-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}',
      '.dstk-badge{flex:none;padding:0 5px;border:.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:999px;color:var(--dsw-alias-label-secondary,#aaa);font-size:10px;line-height:14px}',
      '.dstk-badge[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff)}',
      '.dstk-note{margin-top:8px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px;line-height:16px}',
      '.dstk-error{margin-top:8px;color:var(--dsw-alias-state-error-primary,#ff5d5d);font-size:11px;line-height:16px}',
      '.dstk-check{display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px;line-height:16px}',
      '.dstk-empty{padding:6px 8px;color:var(--dsw-alias-label-secondary,#aaa)}',
      '.dstk-footer{display:flex;justify-content:flex-end;margin-top:8px}',
      '.dstk-secondary{padding:3px 8px;border:.5px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-secondary,#aaa);font:inherit;font-size:11px;cursor:pointer}',
      '.dstk-notice{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:122;padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#1e1e1e);border:.5px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-primary,#eee);font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:18px}',
    ].join('');
    const cssId = PACKAGE_ID + '/header-utilities.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(cssId) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = cssId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region helpers
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    }

    function samePath(left, right) {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      const trim = (value) => value.replace(/[\\/]+$/, '').toLowerCase();
      return trim(left) === trim(right);
    }

    /** POST JSON to one of this package's Host routes and unwrap its error envelope. */
    async function requestJson(route, payload) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const detail = body && body.error ? body.error : undefined;
        const error = new Error((detail && detail.message) || 'HTTP ' + String(response.status));
        error.code = detail ? detail.code : undefined;
        throw error;
      }
      return body;
    }

    function presetLabel(id, row, t) {
      if (row && typeof row.name === 'string' && row.name.length > 0) return row.name;
      const key = 'preset.' + String(id);
      const label = t(key);
      return label === key ? String(id) : label;
    }

    function describeError(error, t) {
      const code = error && typeof error.code === 'string' ? error.code : undefined;
      if (code !== undefined) {
        const key = 'error/' + code;
        const message = t(key);
        if (message !== key) return message;
      }
      return fmt(t('error.fallback'), { message: String((error && error.message) || error) });
    }

    /** Anchor a fixed popover under the trigger, following header scroll and resize. */
    function useAnchoredPosition(anchor, open) {
      const [position, setPosition] = React.useState(null);
      React.useEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const measure = () => {
          const node = anchor.current;
          if (!node) return;
          const rect = node.getBoundingClientRect();
          setPosition({
            top: Math.round(rect.bottom + 8),
            right: Math.max(8, Math.round(window.innerWidth - rect.right)),
          });
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', measure, true);
        };
      }, [anchor, open]);
      return position;
    }

    function useDismiss(open, close) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open, close]);
    }

    function useNotice() {
      const [notice, setNotice] = React.useState(null);
      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 2800);
        return () => clearTimeout(timer);
      }, [notice]);
      return [notice, setNotice];
    }
    //#endregion

    //#region components
    function createActions(ctx, t) {
      function Trigger(props) {
        return h(
          'button',
          {
            ref: props.anchor,
            type: 'button',
            className: 'dstk-trigger',
            title: props.title,
            'aria-haspopup': 'dialog',
            'aria-expanded': props.open === true,
            onClick: props.onClick,
          },
          h('span', { className: 'dstk-glyph', 'aria-hidden': 'true' }, props.glyph),
          h('span', null, props.label),
        );
      }

      function Panel(props) {
        if (props.position === null) return null;
        return h(
          React.Fragment,
          null,
          h('div', { key: 'scrim', className: 'dstk-scrim', 'aria-hidden': 'true', onClick: props.onClose }),
          h(
            'div',
            {
              key: 'panel',
              className: 'dstk-panel',
              role: 'dialog',
              'aria-label': props.title,
              style: { top: String(props.position.top) + 'px', right: String(props.position.right) + 'px' },
            },
            h('div', { className: 'dstk-title' }, props.title),
            props.children,
            props.note === undefined ? null : h('div', { className: 'dstk-note' }, props.note),
            props.error === null || props.error === undefined
              ? null
              : h('div', { className: 'dstk-error', role: 'alert' }, props.error),
            h(
              'div',
              { className: 'dstk-footer' },
              h('button', { type: 'button', className: 'dstk-secondary', onClick: props.onClose }, t('action.close')),
            ),
          ),
        );
      }

      function Badge(props) {
        return h('span', { className: 'dstk-badge', 'data-tone': props.tone }, props.children);
      }

      /**
       * Move the open Session into another workspace. The Host opens a seeded
       * continuation under the target directory and archives the source.
       */
      function WorkspaceAction(props) {
        const sessionId = props.sessionId;
        const cwd = props.useSessions((state) => (state.byId[sessionId] === undefined ? undefined : state.byId[sessionId].cwd));
        const items = props.useWorkspaces((state) => state.items);
        const preset = props.useProjection('agentPreset');
        const anchor = React.useRef(null);
        const [open, setOpen] = React.useState(false);
        const [archiveSource, setArchiveSource] = React.useState(true);
        const [pending, setPending] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [notice, setNotice] = useNotice();
        const position = useAnchoredPosition(anchor, open);
        const close = React.useCallback(() => setOpen(false), []);
        useDismiss(open, close);

        const list = Array.isArray(items) ? items : [];
        const current = list.find((item) => samePath(item.path, cwd));
        const targets = list.filter((item) => !samePath(item.path, cwd));

        const move = async (item) => {
          if (pending !== null) return;
          setPending(item.workspaceId);
          setError(null);
          try {
            const result = await requestJson(MIGRATE_ROUTE, {
              sessionId,
              workspaceId: item.workspaceId,
              archiveSource,
              agentPreset: typeof preset === 'string' ? preset : undefined,
            });
            setOpen(false);
            setNotice(fmt(t('notice.workspace'), { title: item.title || item.path }));
            const workspaceUi = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
            if (workspaceUi !== undefined && typeof workspaceUi.openSession === 'function') {
              workspaceUi.openSession(result.sessionId);
            }
          } catch (reason) {
            setError(describeError(reason, t));
          } finally {
            setPending(null);
          }
        };

        const body =
          targets.length === 0
            ? h('div', { className: 'dstk-empty' }, t('workspace.empty'))
            : targets.map((item) =>
                h(
                  'button',
                  {
                    key: item.workspaceId,
                    type: 'button',
                    className: 'dstk-option',
                    disabled: pending !== null,
                    onClick: () => move(item),
                  },
                  h(
                    'span',
                    { className: 'dstk-option-row' },
                    h('span', { className: 'dstk-option-label' }, item.title || item.path),
                    pending === item.workspaceId ? h(Badge, null, t('state.pending')) : null,
                  ),
                  h('span', { className: 'dstk-option-path' }, item.path),
                ),
              );

        return h(
          React.Fragment,
          null,
          h(Trigger, {
            anchor,
            glyph: '⇄',
            label: t('trigger.workspace'),
            title: t('trigger.workspace.title'),
            open,
            onClick: () => setOpen(!open),
          }),
          h(
            Panel,
            {
              position,
              title: t('workspace.title'),
              note: t('workspace.note'),
              error,
              onClose: close,
            },
            h(
              'div',
              { className: 'dstk-option-path' },
              t('workspace.current') + '：' + (current === undefined ? t('workspace.unknown') : current.title || current.path),
            ),
            h('div', { style: { height: '6px' } }),
            body,
            h(
              'label',
              { className: 'dstk-check' },
              h('input', {
                type: 'checkbox',
                checked: archiveSource,
                onChange: (event) => setArchiveSource(event.target.checked),
              }),
              h('span', null, t('workspace.archive')),
            ),
          ),
          notice === null ? null : h('div', { className: 'dstk-notice', role: 'status' }, notice),
        );
      }

      /**
       * Switch the open Session onto another preset. A blank Session takes the
       * official Remote; anything already started goes through the Host route,
       * which rebinds the same scope instead of refusing.
       */
      function PresetAction(props) {
        const sessionId = props.sessionId;
        const current = props.useProjection('agentPreset');
        const anchor = React.useRef(null);
        const [open, setOpen] = React.useState(false);
        const [roster, setRoster] = React.useState(null);
        const [loadError, setLoadError] = React.useState(null);
        const [pending, setPending] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [notice, setNotice] = useNotice();
        const position = useAnchoredPosition(anchor, open);
        const close = React.useCallback(() => setOpen(false), []);
        useDismiss(open, close);

        React.useEffect(() => {
          if (!open) return undefined;
          const remote = ctx.remote === undefined ? undefined : ctx.remote.agentPresets;
          if (remote === undefined || typeof remote.list !== 'function') {
            setLoadError(t('error.no-remote'));
            return undefined;
          }
          let cancelled = false;
          setLoadError(null);
          setRoster(null);
          remote
            .list()
            .then((result) => {
              if (cancelled) return;
              if (result.ok) setRoster(result.value.presets);
              else setLoadError(result.error.message || t('error.load-roster'));
            })
            .catch((reason) => {
              if (!cancelled) setLoadError(String((reason && reason.message) || reason));
            });
          return () => {
            cancelled = true;
          };
        }, [open]);

        const pick = async (row) => {
          if (pending !== null) return;
          setPending(row.id);
          setError(null);
          try {
            await requestJson(PRESET_ROUTE, { sessionId, agentPreset: row.id });
            setOpen(false);
            setNotice(fmt(t('notice.preset'), { name: presetLabel(row.id, row, t) }));
          } catch (reason) {
            setError(describeError(reason, t));
          } finally {
            setPending(null);
          }
        };

        const rows = Array.isArray(roster) ? roster : null;
        let body;
        if (loadError !== null) body = h('div', { className: 'dstk-error', role: 'alert' }, loadError);
        else if (rows === null) body = h('div', { className: 'dstk-empty' }, t('state.loading'));
        else if (rows.length === 0) body = h('div', { className: 'dstk-empty' }, t('preset.empty'));
        else {
          body = rows.map((row) => {
            const isCurrent = row.id === current;
            const blocked = row.broken !== undefined && row.broken !== null;
            return h(
              'button',
              {
                key: row.id,
                type: 'button',
                className: 'dstk-option',
                disabled: pending !== null || isCurrent || blocked,
                title: blocked ? String(row.broken) : row.description,
                onClick: () => pick(row),
              },
              h(
                'span',
                { className: 'dstk-option-row' },
                h('span', { className: 'dstk-option-label' }, presetLabel(row.id, row, t)),
                isCurrent ? h(Badge, { tone: 'brand' }, t('badge.current')) : null,
                row.isDefault === true ? h(Badge, null, t('badge.default')) : null,
                blocked ? h(Badge, null, t('badge.broken')) : null,
                pending === row.id ? h(Badge, null, t('state.pending')) : null,
              ),
              row.description === undefined ? null : h('span', { className: 'dstk-option-path' }, row.description),
            );
          });
        }

        return h(
          React.Fragment,
          null,
          h(Trigger, {
            anchor,
            glyph: '◈',
            label: t('trigger.preset'),
            title: t('trigger.preset.title'),
            open,
            onClick: () => setOpen(!open),
          }),
          h(
            Panel,
            { position, title: t('preset.title'), note: t('preset.note'), error, onClose: close },
            body,
          ),
          notice === null ? null : h('div', { className: 'dstk-notice', role: 'status' }, notice),
        );
      }

      return { WorkspaceAction, PresetAction };
    }
    //#endregion

    const inject = ['slots', 'locale', 'remote', 'remote.agentPresets'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-toolkit: dictionaries');
      const t = ctx.locale.bind(NS);
      const actions = createActions(ctx, t);
      ctx.slots.inject(UTILITIES, () =>
        ctx.slots.register({ name: UTILITIES, id: 'session-workspace-move', order: 20, locale: NS }, actions.WorkspaceAction),
      );
      ctx.slots.inject(UTILITIES, () =>
        ctx.slots.register({ name: UTILITIES, id: 'session-preset-switch', order: 21, locale: NS }, actions.PresetAction),
      );
    }

    return { inject, apply };
  },
});
