import http from 'node:http';
import assert from 'node:assert/strict';
import { registerRoutes } from '../lib/routes.js';
import { readConfig } from '../lib/config.js';

const msg = (text) => [{ type: 'text', text }];
const LOG = {
  s1: {
    session: { id: 's1', cwd: 'D:\\work' },
    events: [
      { seq: 0, type: 'session/end-seed', data: {} },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { role: 'user', content: msg('第一个问题') } },
      { seq: 3, type: 'assistant/message', data: { turn: 1, message: { id: 'm1', role: 'assistant', content: msg('第一个回答') } } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      { seq: 6, type: 'user/message', data: { role: 'user', content: msg('把刚才那个报错修一下') } },
      { seq: 7, type: 'assistant/message', data: { turn: 2, message: { id: 'm2', role: 'assistant', content: msg('已修复。') } } },
      { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { seq: 9, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4' } },
    ],
  },

};

const seen = [];
let finishKind = 'stop';
let modelCap = null;
const ctx = {
  get(name) {
    if (name === 'sessionQuery') {
      return {
        readSession: async (id) => {
          if (!LOG[id]) throw new Error('unknown session');
          return LOG[id];
        },
      };
    }
    if (name === 'llm') {
      return {
        stream(options) {
          seen.push(options);
          return (async function* generate() {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '```\n' };
            yield { type: 'text-delta', index: 0, text: '改清楚后的提示词\n' };
            yield { type: 'text-delta', index: 0, text: '```' };
            yield { type: 'finish', reason: { kind: finishKind } };
          })();
        },
        async resolveModelInfo() {
          return modelCap === null ? undefined : { defaultMaxTokens: modelCap };
        },
      };
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'fallback', model: 'fallback-model' }) };
    }
    return undefined;
  },
  logger: () => ({ warn() {} }),
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
};

const routes = [];
const dispose = registerRoutes(ctx, readConfig({}));
const server = http.createServer((request, response) => {
  const route = routes.find((candidate) => candidate.path === request.url.split('?')[0]);
  if (!route) {
    response.writeHead(404).end('no route');
    return;
  }
  route.handler(request, response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function call(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  return { status: response.status, body };
}

const health = await call('/dsh-ai-prompt/api/health');
assert.equal(health.status, 200);
assert.equal(health.body.ok, true);
assert.equal(health.body.limits.maxDraftChars, 8000);

const refined = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', draft: '把刚才那个报错修一下' }),
});
assert.equal(refined.status, 200, JSON.stringify(refined.body));
assert.equal(refined.body.ok, true, JSON.stringify(refined.body));
assert.equal(refined.body.text, '改清楚后的提示词');
assert.equal(refined.body.provider, 'deepseek');
assert.equal(refined.body.used, 4);
assert.equal(seen.length, 1);
assert.equal(seen[0].provider, 'deepseek');
assert.ok(seen[0].messages[0].content[0].text.includes('<draft>'));
assert.ok(seen[0].messages[0].content[0].text.includes('第一个问题'));
assert.equal(seen[0].maxTokens, 1024);

const longDraft = `把刚才那个报错修一下，${'并补上回归测试。'.repeat(400)}`;
const longRefined = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', draft: longDraft }),
});
assert.equal(longRefined.body.ok, true, JSON.stringify(longRefined.body));
assert.equal(seen.length, 2);
assert.ok(seen[1].maxTokens > 2048, `expected a scaled budget, got ${seen[1].maxTokens}`);
assert.ok(seen[1].maxTokens <= 8192);

modelCap = 2048;
const capped = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', draft: longDraft }),
});
assert.equal(capped.body.ok, true, JSON.stringify(capped.body));
assert.equal(seen.at(-1).maxTokens, 2048, 'a model that advertises less caps the budget');
modelCap = null;

finishKind = 'max-tokens';
const truncated = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', draft: '把刚才那个报错修一下' }),
});
assert.equal(truncated.body.ok, false);
assert.equal(truncated.body.error.code, 'output_limit');
finishKind = 'stop';

const empty = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', draft: '   ' }),
});
assert.equal(empty.body.ok, false);
assert.equal(empty.body.error.code, 'empty');

const noSession = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: '', draft: 'x' }),
});
assert.equal(noSession.body.error.code, 'bad_request');

const unknown = await call('/dsh-ai-prompt/api/refine', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'nope', draft: 'x' }),
});
assert.equal(unknown.body.error.code, 'failed');

const wrongMethod = await call('/dsh-ai-prompt/api/refine');
assert.equal(wrongMethod.status, 405);
assert.equal(wrongMethod.body.error.code, 'method_not_allowed');

dispose();
await new Promise((resolve) => server.close(resolve));
console.log('all route checks passed');
