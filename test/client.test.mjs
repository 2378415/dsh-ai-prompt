import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── minimal React + DOM so the client factory can run headless ──────────────
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity);
    const next = { ...(props || {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    return { type, props: next };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect(effect) {
    effect();
  },
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
  memo(fn) {
    return fn;
  },
};

const documentStub = {
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition; } } };
globalThis.document = documentStub;

await import('../client.js');
assert.ok(captured && captured.id === 'dsh-ai-prompt', 'client bundle registers its id');
const module = captured.factory((name) => (name === 'react' ? React : {}));
assert.deepEqual(module.inject, ['slots', 'locale']);

// ── fake host/client context ────────────────────────────────────────────────
const registered = [];
const opened = [];
const calls = { draft: null, refine: 0 };
const ctx = {
  locale: {
    register() {},
    getLocale() { return 'zh'; },
    subscribe() { return () => {}; },
  },
  slots: {
    inject(slot, callback) {
      callback();
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
  get(name) {
    if (name === 'sessions') {
      return { fork: async (options) => { calls.fork = options; return 's2'; } };
    }
    if (name === 'uiWorkspace') {
      return { openSession: (id) => opened.push(id) };
    }
    return undefined;
  },
};

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/refine')) {
    calls.refine += 1;
    return { status: 200, async json() { return { ok: true, text: '  改写后的提示词  ', used: 3, provider: 'p', model: 'm' }; } };
  }
  return { status: 404, async json() { return { ok: false }; } };
};

module.apply(ctx);
assert.equal(registered.length, 4, `expected 4 seats, got ${registered.length}`);
const byId = Object.fromEntries(registered.map((entry) => [entry.options.id, entry]));
assert.ok(byId['ai-prompt.refine']);
assert.ok(byId['ai-prompt.dialog']);
assert.ok(byId['ai-prompt.style']);
assert.ok(byId['ai-prompt.notice']);
assert.equal(byId['ai-prompt.refine'].options.name, 'conversation.input.left');
assert.equal(byId['ai-prompt.dialog'].options.name, 'shell.overlay');
assert.equal(byId['ai-prompt.style'].options.name, 'shell.overlay');
const styleTree = byId['ai-prompt.style'].component({});
assert.ok(textOf(styleTree).includes('.aip-trigger'), 'the single style seat carries the stylesheet');

// ── tiny element helpers ────────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit);
    return;
  }
  visit(node);
  const children = node.props ? node.props.children : undefined;
  if (children !== undefined) walk(children, visit);
}

function textOf(node) {
  let out = '';
  walk(node, (value) => {
    if (value.text) out += value.text;
  });
  return out;
}

function findBy(node, predicate) {
  let found = null;
  walk(node, (value) => {
    if (!found && value.type && predicate(value)) found = value;
  });
  return found;
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (value) => {
    if (value.type && predicate(value)) out.push(value);
  });
  return out;
}

// ── composer trigger ────────────────────────────────────────────────────────
const inputProps = {
  sessionId: 's1',
  inputActions: { setDraft: (text) => { calls.draft = text; } },
  useInput: (selector) => selector({ draft: '原文', phase: 'plain' }),
  useChat: (selector) => selector({ timeline: { turnOrder: [1, 2] } }),
  useAccess: () => true,
};

const triggerTree = byId['ai-prompt.refine'].component(inputProps);
const trigger = findBy(triggerTree, (node) => node.props && node.props['data-ai-prompt'] === 'trigger');
assert.ok(trigger, 'star trigger renders');
assert.equal(trigger.props['aria-label'], '优化提示词');
const spark = findBy(trigger, (node) => node.type === 'svg');
assert.equal(spark.props.width, 18, 'star icon is enlarged');
trigger.props.onClick({ preventDefault() {} });

await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(calls.refine, 1);

// ── dialog: ready state + adopt ─────────────────────────────────────────────
const dialogTree = byId['ai-prompt.dialog'].component({});
const dialog = findBy(dialogTree, (node) => node.props && node.props.role === 'dialog');
assert.ok(dialog, 'dialog opens after the trigger');
assert.equal(textOf(dialogTree).includes('改写后的提示词'), true);
assert.equal(textOf(dialogTree).includes('参考 3 条历史消息'), true);

const adopt = findAll(dialogTree, (node) => node.props && node.props.className === 'aip-btn aip-primary')[0];
assert.ok(adopt, 'adopt button renders');
assert.equal(textOf(adopt), '采用');
adopt.props.onClick({});
assert.equal(calls.draft, '改写后的提示词');

// ── dock notice: adopted + revert ───────────────────────────────────────────
const noticeTree = byId['ai-prompt.notice'].component({
  sessionId: 's1',
  inputActions: { setDraft: (text) => { calls.draft = text; } },
  useInput: (selector) => selector({ draft: '改写后的提示词' }),
});
assert.equal(textOf(noticeTree).includes('已采用优化结果'), true);
const revert = findAll(noticeTree, (node) => textOf(node) === '撤销')[0];
assert.ok(revert, 'revert action renders');
revert.props.onClick({});
assert.equal(calls.draft, '原文');

// ── primary button hover must not lose its fill ─────────────────────────────
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
assert.match(
  source,
  /\.aip-btn\.aip-primary:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--dsw-alias-brand-primary\)/,
  'primary hover restates the brand fill',
);
assert.match(source, /\.aip-btn:not\(\.aip-primary\):hover:not\(:disabled\)/, 'generic hover excludes the primary variant');
assert.doesNotMatch(source, /^\.aip-btn:hover:not\(:disabled\)\s*\{/m, 'no unscoped button hover rule');
assert.match(source, /\.aip-btn\.aip-primary\s*\{[^}]*--dsw-static-neutral-00/, 'primary text color follows the theme token');
assert.match(source, /\.aip-trigger\s*\{[^}]*border-radius:\s*50%/, 'the star trigger is circular');
assert.match(
  source,
  /\.aip-trigger::before\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*50%/,
  'the hover circle is a fixed square layer, never an ellipse',
);
assert.match(
  source,
  /\.aip-trigger:hover::before\s*\{[^}]*--dsw-alias-interactive-bg-hover/,
  'the star hover uses the same grey as the permission chip',
);
assert.match(
  source,
  /\.aip-trigger\[aria-disabled="true"\]\s+\.aip-spark\s*\{[^}]*opacity/,
  'an empty draft dims only the icon, not the hover circle',
);
assert.doesNotMatch(source, /disabled:\s*empty/, 'an empty draft stays hoverable instead of using the disabled attribute');
assert.match(source, /\.aip-meta\s*\{[^}]*margin-top:\s*8px/, 'the context line keeps its distance from the header');

console.log('all client smoke checks passed');
