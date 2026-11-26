import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiRequestError, connectSession, errorMessage, generationOutcomeUnknown } from '../api';
import type { StartGeneration } from '../../../shared/types';

test('known rejection permits fallback while uncertain acceptance preserves idempotent retry', () => {
  assert.equal(generationOutcomeUnknown(new ApiRequestError('quota', 429, 'DAILY_LIMIT')), false);
  assert.equal(generationOutcomeUnknown(new ApiRequestError('not configured', 503, 'AI_NOT_CONFIGURED')), false);
  assert.equal(generationOutcomeUnknown(new ApiRequestError('network', 0)), true);
  assert.equal(generationOutcomeUnknown(new ApiRequestError('gateway', 502)), true);
  assert.match(errorMessage(new ApiRequestError('busy', 409, 'PROJECT_BUSY')), /仍在生成/);
  assert.match(errorMessage(new ApiRequestError('conflict', 409, 'STATE_CONFLICT')), /版本冲突/);
});

test('front-end API keeps auth in host storage and implements the shared REST contract', async t => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>([['atoms-lite-token', 'existing-visitor-token']]);
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const calls: Array<{ url: string; options: RequestInit }> = [];
  let response = () => Response.json({});
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), options: init ?? {} });
    return response();
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  await t.test('connects once and preserves the returned visitor token only under the required key', async () => {
    response = () => Response.json({ token: 'returned-visitor-token', visitorId: 'visitor-1', dailyLimit: 5 });
    const first = connectSession();
    const second = connectSession();
    assert.equal(first, second);
    assert.equal((await first).visitorId, 'visitor-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/session');
    assert.equal(new Headers(calls[0].options.headers).get('Authorization'), 'Bearer existing-visitor-token');
    assert.deepEqual([...values.keys()], ['atoms-lite-token']);
    assert.equal(values.get('atoms-lite-token'), 'returned-visitor-token');
  });

  await t.test('repeated generation with the same retry body preserves request ID and uses Bearer auth', async () => {
    const body: StartGeneration = { prompt: 'Create a task board', mode: 'ai', requestId: 'same-retry-id', projectId: 'p1' };
    response = () => Response.json({ runId: 'r1', projectId: 'p1' });
    await api.generate(body);
    await api.generate(body);
    const pair = calls.slice(-2);
    assert.equal(pair[0].options.body, pair[1].options.body);
    for (const call of pair) {
      assert.equal(call.url, '/api/generations');
      assert.equal(call.options.method, 'POST');
      assert.equal(new Headers(call.options.headers).get('Authorization'), 'Bearer returned-visitor-token');
      assert.equal(call.options.credentials, 'omit');
      assert.deepEqual(JSON.parse(String(call.options.body)), body);
    }
  });

  await t.test('artifact state load/save encodes IDs and supplies the known optimistic version', async () => {
    response = () => Response.json({ data: { tasks: [] }, version: 8 });
    const state = await api.loadState('artifact/one');
    assert.equal(calls.at(-1)?.url, '/api/artifacts/artifact%2Fone/state');
    await api.saveState('artifact/one', { data: { tasks: ['one'] }, version: state.version });
    assert.equal(calls.at(-1)?.options.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.options.body)), { data: { tasks: ['one'] }, version: 8 });
  });

  await t.test('project/run/config/history endpoints and HTML export match the shared contract', async () => {
    response = () => Response.json({ projects: [] });
    assert.deepEqual(await api.projects(), []);
    assert.equal(calls.at(-1)?.url, '/api/projects');
    await api.project('project/one');
    assert.equal(calls.at(-1)?.url, '/api/projects/project%2Fone');
    await api.run('run/one');
    assert.equal(calls.at(-1)?.url, '/api/runs/run%2Fone');
    await api.config();
    assert.equal(calls.at(-1)?.url, '/api/config');
    response = () => new Response('<!doctype html><title>Export</title>');
    assert.equal(await api.exportHtml('p1'), '<!doctype html><title>Export</title>');
    assert.equal(calls.at(-1)?.url, '/api/projects/p1/export');
  });

  await t.test('version conflicts and non-JSON failures never masquerade as success', async () => {
    response = () => Response.json({ error: 'Version conflict', code: 'STATE_CONFLICT' }, { status: 409 });
    await assert.rejects(api.saveState('a1', { data: {}, version: 1 }), error => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'STATE_CONFLICT');
      assert.match(errorMessage(error), /版本冲突/);
      return true;
    });
    response = () => new Response('Bad gateway', { status: 502 });
    await assert.rejects(api.projects(), error => error instanceof ApiRequestError && error.status === 502);
  });
});
