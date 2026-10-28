/**
 * dsh-ai-prompt — Web client half.
 *
 * Seats:
 *   conversation.input.left        the four-pointed-star trigger
 *   shell.overlay (dialog)         the refinement dialog (frame level, never clipped)
 *   shell.overlay (style)          the one stylesheet for every seat
 *   conversation.input.dock        the "adopted" notice and its undo
 *
 * A single controller owns refinement and adoption; the seats only render it.
 * Adoption replaces the composer draft through the shipped InputActions.
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-ai-prompt';
    const API = '/dsh-ai-prompt/api';

    const DICT = {
      zh: {
        tipTitle: '优化提示词',
        tipBody: '用当前模型的会话上下文改写得更清楚，采用前不会替换原文',
        title: '提示词优化',
        meta: '参考 {n} 条历史消息',
        working: '正在优化…',
        workingHint: '正在读取当前会话的上下文',
        adopt: '采用',
        adoptConfirm: '覆盖并采用',
        again: '再来一次',
        discard: '放弃',
        cancel: '取消',
        close: '关闭',
        overwrite: '输入框已修改，采用会覆盖当前内容',
        adopted: '已采用优化结果',
        revert: '撤销',
        hintFailed: '检查模型与网络后重试',
        errEmpty: '输入框是空的，先写点内容再优化',
        errTooLong: '内容超过 {max} 字符，无法优化',
        errNoModel: '当前会话没有可用的模型，无法优化提示词',
        errTimeout: '优化超时，请重试',
        errNoAnswer: '模型没有给出结果，请重试',
        errOutputLimit: '优化结果达到输出上限被截断，请缩短提示词后重试',
        errApply: '输入框已不可用，采用失败，请关闭后重新打开',
        errFailed: '优化失败，请重试',
        errBadRequest: '优化请求格式不正确',
        errNetwork: '无法连接到 Host，请重试',
      },
      en: {
        tipTitle: 'Refine prompt',
        tipBody: 'Rewrite it more clearly with the current model and this conversation; your text stays until you adopt it',
        title: 'Prompt refinement',
        meta: 'Used {n} messages of context',
        working: 'Refining…',
        workingHint: 'Reading the current conversation',
        adopt: 'Adopt',
        adoptConfirm: 'Replace and adopt',
        again: 'Try again',
        discard: 'Discard',
        cancel: 'Cancel',
        close: 'Close',
        overwrite: 'The box has changed; adopting replaces what is there now',
        adopted: 'Adopted the refined prompt',
        revert: 'Undo',
        hintFailed: 'Check the model and network, then try again',
        errEmpty: 'The box is empty; write something first',
        errTooLong: 'The text is over {max} characters and cannot be refined',
        errNoModel: 'This session has no model to refine the prompt with',
        errTimeout: 'Refining timed out; try again',
        errNoAnswer: 'The model returned nothing; try again',
        errOutputLimit: 'The rewrite hit the output limit and was cut; shorten the prompt and try again',
        errApply: 'The composer is no longer available; close and reopen',
        errFailed: 'Refining failed; try again',
        errBadRequest: 'The refine request was malformed',
        errNetwork: 'Could not reach the Host; try again',
      },
    };

    /** Populated by `apply`; every seat reads locale through it. */
    let localeCtx = null;

    function localeId() {
      try {
        const snapshot = localeCtx && localeCtx.locale ? localeCtx.locale.getLocale() : null;
        if (typeof snapshot === 'string') return snapshot;
        if (snapshot && typeof snapshot === 'object') {
          const value = snapshot.id || snapshot.locale || snapshot.language;
          if (typeof value === 'string') return value;
        }
      } catch {
        // Fall through to the Chinese dictionary.
      }
      return 'zh';
    }

    function translate(key, vars) {
      const lang = /^en/iu.test(localeId()) ? 'en' : 'zh';
      const table = DICT[lang] || DICT.zh;
      let text = table[key];
      if (text === undefined) text = DICT.en[key] !== undefined ? DICT.en[key] : key;
      if (vars) {
        text = text.replace(/\{(\w+)\}/gu, (match, name) => (
          vars[name] === undefined ? match : String(vars[name])
        ));
      }
      return text;
    }

    function useT() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const service = localeCtx && localeCtx.locale;
        if (!service || typeof service.subscribe !== 'function') return undefined;
        try {
          return service.subscribe(() => force((value) => value + 1));
        } catch {
          return undefined;
        }
      }, []);
      return translate;
    }

    // ── tiny observable store ──────────────────────────────────────────────
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get() {
          return state;
        },
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
          if (next === state) return;
          state = next;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch {
              // A failing seat must not stop the others.
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function useStore(store) {
      const [, force] = React.useState(0);
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [store]);
      return store.get();
    }

    // ── HTTP ──────────────────────────────────────────────────────────────
    async function readJsonResponse(response) {
      const data = await response.json().catch(() => null);
      if (data && typeof data === 'object') return data;
      return { ok: false, error: { code: 'failed', message: `HTTP ${response.status}` } };
    }

    async function getJson(path, signal) {
      try {
        const response = await fetch(`${API}${path}`, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal,
        });
        return await readJsonResponse(response);
      } catch (cause) {
        return {
          ok: false,
          error: { code: 'network', message: String((cause && cause.message) || cause) },
        };
      }
    }

    async function postJson(path, body, signal) {
      try {
        const response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body || {}),
          signal,
        });
        return await readJsonResponse(response);
      } catch (cause) {
        return {
          ok: false,
          error: { code: 'network', message: String((cause && cause.message) || cause) },
        };
      }
    }

    function errorKey(code) {
      switch (code) {
        case 'empty': return 'errEmpty';
        case 'too_long': return 'errTooLong';
        case 'no_model': return 'errNoModel';
        case 'timeout': return 'errTimeout';
        case 'no_answer': return 'errNoAnswer';
        case 'output_limit': return 'errOutputLimit';
        case 'bad_request': return 'errBadRequest';
        case 'network': return 'errNetwork';
        default: return 'errFailed';
      }
    }

    // ── icons ─────────────────────────────────────────────────────────────
    function SparkIcon(props) {
      const size = props && Number(props.size) ? Number(props.size) : 14;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: false,
        fill: 'none',
      },
      h('path', {
        d: 'M12 2.6c.4 3.9 1.9 6.4 4.6 7.5 1.1.5 2.4.8 3.9 1 -1.5.2-2.8.5-3.9 1-2.7 1.1-4.2 3.6-4.6 7.5-.4-3.9-1.9-6.4-4.6-7.5-1.1-.5-2.4-.8-3.9-1 1.5-.2 2.8-.5 3.9-1 2.7-1.1 4.2-3.6 4.6-7.5Z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M19 2.5c.35 2.2 1.3 3.7 3.2 4.3.35.1.65.15 1 .15-.35 0-.65.05-1 .15-1.9.6-2.85 2.1-3.2 4.3-.35-2.2-1.3-3.7-3.2-4.3-.35-.1-.65-.15-1-.15.35 0 .65-.05 1-.15 1.9-.6 2.85-2.1 3.2-4.3Z',
        fill: 'currentColor',
        opacity: 0.7,
      }));
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
          stroke: 'currentColor',
          'stroke-width': 1.5,
          'stroke-linecap': 'round',
        }));
    }

    // ── styles ────────────────────────────────────────────────────────────
    const CSS = `
.aip-seat { position: relative; display: inline-flex; align-items: center; flex: none; }
.aip-trigger {
  position: relative;
  width: 28px; height: 28px; min-width: 28px; min-height: 28px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; padding: 0; transition: color .12s;
}
/* The circle is a fixed 28x28 layer, so a stretched or squeezed button box
   (host flex rules, DPI rounding) can never turn the hover shape into an
   ellipse. */
.aip-trigger::before {
  content: ""; position: absolute; top: 50%; left: 50%;
  width: 28px; height: 28px; margin: -14px 0 0 -14px;
  border-radius: 50%; background: transparent; pointer-events: none;
  transition: background-color .12s;
}
.aip-trigger:hover { color: var(--dsw-alias-label-primary); }
.aip-trigger:hover::before {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.aip-spark { position: relative; z-index: 1; display: inline-flex; }
.aip-trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.aip-trigger:disabled, .aip-trigger[aria-disabled="true"] { cursor: default; }
.aip-trigger:disabled .aip-spark, .aip-trigger[aria-disabled="true"] .aip-spark { opacity: .45; }
.aip-trigger[aria-busy="true"] .aip-spark { animation: aip-pulse 1.1s ease-in-out infinite; }
@keyframes aip-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
.aip-tip {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 60;
  width: 248px; padding: 8px 10px; border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l1); box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font-size: 12px; line-height: 17px; opacity: 0; visibility: hidden; transform: translateY(2px);
  transition: opacity .12s, transform .12s; pointer-events: none;
}
.aip-tip b { display: block; font-weight: 600; margin-bottom: 2px; }
.aip-tip span { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.aip-seat:hover .aip-tip, .aip-seat:focus-within .aip-tip { opacity: 1; visibility: visible; transform: none; }

.aip-backdrop {
  position: fixed; inset: 0; z-index: 1000; pointer-events: auto; background: rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.aip-dialog {
  width: min(560px, calc(100vw - 48px)); max-height: min(72vh, 640px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l1); border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,.28);
}
.aip-head {
  display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
}
.aip-head-icon { color: var(--dsw-alias-brand-primary); display: inline-flex; }
.aip-head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
.aip-meta { display: block; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 0 16px 8px; }
.aip-close {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.aip-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.aip-body { padding: 12px 16px; overflow: auto; flex: 1; min-height: 120px; }
.aip-wait { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 13px; margin: 0; }
.aip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-brand-primary); animation: aip-pulse 1s ease-in-out infinite; }
.aip-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 8px 0 0; }
.aip-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; margin: 0; }
.aip-error.aip-apply { margin-top: 10px; }
.aip-pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.72; font-family: inherit; color: var(--dsw-alias-label-primary);
}
.aip-warn {
  margin: 10px 0 0; padding: 6px 8px; border-radius: 8px; font-size: 12px;
  color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2);
}
.aip-foot {
  display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px;
  border-top: .5px solid var(--dsw-alias-border-l1);
}
.aip-foot .aip-grow { flex: 1; }
.aip-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
}
.aip-btn:not(.aip-primary):hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.aip-btn:disabled { opacity: .5; cursor: default; }
.aip-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.aip-btn.aip-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
  color: var(--dsw-static-neutral-00, #fff);
}
/* Restate the fill and text color: the generic hover rule must never win here. */
.aip-btn.aip-primary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-static-neutral-00, #fff);
  filter: brightness(1.08);
}
.aip-btn.aip-weak { border-color: transparent; color: var(--dsw-alias-label-secondary); }

.aip-notice {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border-radius: 8px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border: .5px solid var(--dsw-alias-border-l1);
}
.aip-notice-text { flex: 1; min-width: 0; }
.aip-link {
  border: none; background: transparent; color: var(--dsw-alias-brand-primary);
  font-size: 12px; cursor: pointer; padding: 0 2px;
}
.aip-link:hover { text-decoration: underline; }
.aip-notice-x {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 11px; padding: 0 2px;
}

`;

    function Styles() {
      return h('style', { 'data-ai-prompt-style': '' }, CSS);
    }

    // ── focus helpers ─────────────────────────────────────────────────────
    function focusables(root) {
      if (!root) return [];
      const nodes = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      return [...nodes].filter((node) => !node.disabled && node.offsetParent !== null);
    }

    function trapFocus(event, root) {
      const items = focusables(root);
      if (items.length === 0) return;
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        items[0].focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /**
     * Refinement and adoption in one place.
     *
     * The controller never touches React: seats subscribe to its stores and
     * call its actions. Every composer that can accept an adopted prompt binds
     * itself here, so an adoption can prove the target composer is still the
     * one the dialog was opened from.
     */
    function createController() {
      const dialog = createStore({
        open: false,
        phase: 'idle',
        sessionId: '',
        attempt: '',
        result: '',
        error: '',
        used: 0,
        overwrite: false,
        applyError: false,
      });
      const notice = createStore({ sessionId: '', kind: '', text: '', at: 0 });
      let binding = null;
      let pending = null;
      let limits = { maxDraftChars: 8000 };

      void getJson('/health').then((response) => {
        if (response && response.ok === true && response.limits) {
          limits = { ...limits, ...response.limits };
        }
      });

      function abort() {
        const controller = pending;
        pending = null;
        if (!controller) return;
        try {
          controller.abort();
        } catch {
          // Already settled.
        }
      }

      function focusTrigger() {
        if (!binding || typeof binding.focusTrigger !== 'function') return;
        try {
          binding.focusTrigger();
        } catch {
          // The composer may already be unmounted.
        }
      }

      function bind(next) {
        binding = next;
        return () => {
          if (binding === next) binding = null;
        };
      }

      function close() {
        abort();
        dialog.set({
          open: false,
          phase: 'idle',
          overwrite: false,
          applyError: false,
          error: '',
        });
        focusTrigger();
      }

      async function run(sessionId, draft) {
        abort();
        const controller = new AbortController();
        pending = controller;
        dialog.set({ phase: 'working', attempt: draft, result: '', error: '', used: 0, overwrite: false, applyError: false });
        const response = await postJson('/refine', { sessionId, draft }, controller.signal);
        if (controller.signal.aborted) return;
        if (pending === controller) pending = null;
        if (response && response.ok === true) {
          dialog.set({
            phase: 'ready',
            result: String(response.text || '').trim(),
            used: Number(response.used) || 0,
          });
          return;
        }
        const code = response && response.error && typeof response.error.code === 'string'
          ? response.error.code
          : 'failed';
        dialog.set({ phase: 'failed', error: code });
      }

      function open(sessionId, draft) {
        dialog.set({
          open: true,
          phase: 'working',
          sessionId,
          attempt: draft,
          result: '',
          error: '',
          used: 0,
          overwrite: false,
          applyError: false,
        });
        if (draft.length > limits.maxDraftChars) {
          dialog.set({ phase: 'failed', error: 'too_long' });
          return;
        }
        void run(sessionId, draft);
      }

      function retry() {
        const state = dialog.get();
        if (state.phase === 'working') return;
        void run(state.sessionId, state.attempt);
      }

      function adopt() {
        const state = dialog.get();
        if (state.phase !== 'ready' || state.result === '') return;
        if (!binding || binding.sessionId !== state.sessionId) {
          dialog.set({ applyError: true });
          return;
        }
        const latest = binding.readDraft();
        if (latest !== state.attempt && state.overwrite !== true) {
          dialog.set({ overwrite: true });
          return;
        }
        if (!binding.applyDraft(state.result)) {
          dialog.set({ applyError: true });
          return;
        }
        notice.set({ sessionId: state.sessionId, kind: 'adopted', text: latest, at: Date.now() });
        close();
      }

      function dismissNotice() {
        notice.set({ sessionId: '', kind: '', text: '', at: 0 });
      }

      function revertAdopt(sessionId) {
        const current = notice.get();
        if (!current || current.sessionId !== sessionId || current.kind !== 'adopted') return false;
        if (!binding || binding.sessionId !== sessionId) return false;
        if (!binding.applyDraft(current.text)) return false;
        dismissNotice();
        return true;
      }

      return {
        dialog,
        notice,
        bind,
        open,
        close,
        retry,
        adopt,
        dismissNotice,
        revertAdopt,
        limits: () => limits,
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeCtx = ctx;
        try {
          ctx.locale.register(NS, DICT);
        } catch {
          for (const [locale, dict] of Object.entries(DICT)) {
            try {
              ctx.locale.register(NS, locale, dict);
            } catch {
              // One unsupported locale must not stop the plugin.
            }
          }
        }

        const ui = createController();

        // ── seats ─────────────────────────────────────────────────────────
        // Guards keep every hook call unconditional inside the inner seat: a
        // missing slot prop removes the seat instead of changing hook order.
        function RefineButton(props) {
          if (typeof props.useInput !== 'function'
            || !props.inputActions || typeof props.sessionId !== 'string') return null;
          return h(RefineButtonSeat, props);
        }

        function RefineButtonSeat(props) {
          const t = useT();
          const state = useStore(ui.dialog);
          const sessionId = props.sessionId;
          const inputActions = props.inputActions;
          const draft = props.useInput((value) => (value && typeof value.draft === 'string' ? value.draft : ''));
          const triggerRef = React.useRef(null);
          const draftRef = React.useRef(draft);
          const actionsRef = React.useRef(inputActions);
          draftRef.current = draft;
          actionsRef.current = inputActions;

          React.useEffect(() => ui.bind({
            sessionId,
            readDraft: () => draftRef.current,
            applyDraft: (text) => {
              try {
                actionsRef.current.setDraft(text);
                return true;
              } catch {
                return false;
              }
            },
            focusTrigger: () => {
              if (triggerRef.current) triggerRef.current.focus();
            },
          }), [sessionId]);

          React.useEffect(() => {
            const current = ui.dialog.get();
            if (current.open && current.sessionId !== sessionId) ui.close();
          }, [sessionId]);

          const busy = state.open && state.phase === 'working' && state.sessionId === sessionId;
          const empty = draft.trim() === '';

          const onClick = (event) => {
            event.preventDefault();
            if (empty) return;
            ui.open(sessionId, draft);
          };

          return h('div', { className: 'aip-seat' },
            h('button', {
              type: 'button',
              className: 'aip-trigger',
              'aria-label': t('tipTitle'),
              'aria-haspopup': 'dialog',
              'aria-expanded': state.open && state.sessionId === sessionId ? 'true' : 'false',
              'aria-busy': busy ? 'true' : 'false',
              'aria-disabled': empty || busy ? 'true' : undefined,
              'data-ai-prompt': 'trigger',
              ref: triggerRef,
              onMouseDown: (event) => event.preventDefault(),
              onClick,
            }, h('span', { className: 'aip-spark', style: { display: 'inline-flex' } }, h(SparkIcon, { size: 18 }))),
            h('span', { className: 'aip-tip', role: 'tooltip' },
              h('b', null, t('tipTitle')),
              h('span', null, t('tipBody'))));
        }

        function RefineDialog() {
          const t = useT();
          const state = useStore(ui.dialog);
          const cardRef = React.useRef(null);
          const closeRef = React.useRef(null);
          const primaryRef = React.useRef(null);

          // Move focus into the dialog as soon as it opens, whatever phase.
          React.useEffect(() => {
            if (!state.open) return;
            if (closeRef.current) closeRef.current.focus();
          }, [state.open]);

          React.useEffect(() => {
            if (!state.open) return undefined;
            const onKey = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                ui.close();
                return;
              }
              if (event.key === 'Tab') {
                trapFocus(event, cardRef.current);
                return;
              }
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                ui.adopt();
              }
            };
            document.addEventListener('keydown', onKey, true);
            return () => document.removeEventListener('keydown', onKey, true);
          }, [state.open, state.phase, state.overwrite, state.result]);

          React.useEffect(() => {
            if (state.open && state.phase === 'ready' && primaryRef.current) primaryRef.current.focus();
          }, [state.open, state.phase]);

          if (!state.open) return null;

          const working = state.phase === 'working';
          const ready = state.phase === 'ready';
          const failed = state.phase === 'failed';
          const errorText = failed ? t(errorKey(state.error), { max: ui.limits().maxDraftChars }) : '';

          return h('div', {
            className: 'aip-backdrop',
            'data-ai-prompt': 'backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) ui.close();
            },
          },
          h('div', {
            className: 'aip-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('title'),
            'aria-busy': working ? 'true' : 'false',
            ref: cardRef,
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('header', { className: 'aip-head' },
            h('span', { className: 'aip-head-icon' }, h(SparkIcon, { size: 16 })),
            h('h2', null, t('title')),
            h('button', {
              type: 'button',
              className: 'aip-close',
              'aria-label': t('close'),
              ref: closeRef,
              onClick: () => ui.close(),
            }, h(CloseIcon))),
          ready && state.used > 0
            ? h('span', { className: 'aip-meta' }, t('meta', { n: state.used }))
            : null,
          h('div', { className: 'aip-body' },
            working
              ? h(React.Fragment, null,
                h('p', { className: 'aip-wait', role: 'status' },
                  h('span', { className: 'aip-dot' }),
                  t('working')),
                h('p', { className: 'aip-hint' }, t('workingHint')))
              : null,
            failed
              ? h(React.Fragment, null,
                h('p', { className: 'aip-error', role: 'alert' }, errorText),
                h('p', { className: 'aip-hint' }, t('hintFailed')))
              : null,
            ready ? h('pre', { className: 'aip-pre' }, state.result) : null,
            ready && state.overwrite
              ? h('p', { className: 'aip-warn', role: 'alert' }, t('overwrite'))
              : null,
            state.applyError
              ? h('p', { className: 'aip-error aip-apply', role: 'alert' }, t('errApply'))
              : null),
          h('footer', { className: 'aip-foot' },
            h('span', { className: 'aip-grow' }),
            h('button', {
              type: 'button',
              className: 'aip-btn aip-weak',
              onClick: () => ui.close(),
            }, working ? t('cancel') : t('discard')),
            working
              ? null
              : h('button', {
                type: 'button',
                className: 'aip-btn',
                onClick: () => ui.retry(),
              }, t('again')),
            ready
              ? h('button', {
                type: 'button',
                className: 'aip-btn aip-primary',
                ref: primaryRef,
                onClick: () => ui.adopt(),
              }, state.overwrite ? t('adoptConfirm') : t('adopt'))
              : null)));
        }

        function NoticeBar(props) {
          return h('div', { className: 'aip-notice', 'data-ai-prompt': props.kind },
            h('span', { className: 'aip-notice-text' }, props.text),
            props.actions.map((action, index) => h('button', {
              key: `${action.label}-${index}`,
              type: 'button',
              className: action.weak ? 'aip-notice-x' : 'aip-link',
              'aria-label': action.ariaLabel || action.label,
              onClick: action.onClick,
            }, action.label)));
        }

        function DockNotice(props) {
          if (!props.inputActions || typeof props.sessionId !== 'string') return null;
          return h(DockNoticeSeat, props);
        }

        function DockNoticeSeat(props) {
          const t = useT();
          const sessionId = props.sessionId;
          const notice = useStore(ui.notice);
          const adopted = notice && notice.sessionId === sessionId && notice.kind === 'adopted' ? notice : null;

          React.useEffect(() => {
            if (!adopted) return undefined;
            const timer = setTimeout(() => {
              const current = ui.notice.get();
              if (current.at === adopted.at) ui.dismissNotice();
            }, 8000);
            return () => clearTimeout(timer);
          }, [adopted && adopted.at]);

          if (!adopted) return null;

          return h(NoticeBar, {
            kind: 'adopted',
            text: t('adopted'),
            actions: [
              { label: t('revert'), onClick: () => ui.revertAdopt(sessionId) },
              { label: '✕', ariaLabel: t('close'), weak: true, onClick: () => ui.dismissNotice() },
            ],
          });
        }

        function StyleSeat() {
          return h(Styles);
        }

        const seats = [
          ['conversation.input.left', { name: 'conversation.input.left', id: 'ai-prompt.refine', order: 10 }, RefineButton],
          ['conversation.input.dock', { name: 'conversation.input.dock', id: 'ai-prompt.notice', order: 20 }, DockNotice],
          ['shell.overlay', { name: 'shell.overlay', id: 'ai-prompt.dialog', order: 90 }, RefineDialog],
          ['shell.overlay', { name: 'shell.overlay', id: 'ai-prompt.style', order: 95 }, StyleSeat],
        ];

        for (const [slot, options, component] of seats) {
          try {
            ctx.slots.inject(slot, () => ctx.slots.register(options, component));
          } catch {
            // A host without this seat loses that one surface, not the plugin.
          }
        }
      },
    };
  },
});
