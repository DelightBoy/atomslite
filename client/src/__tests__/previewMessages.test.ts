import assert from 'node:assert/strict';
import test from 'node:test';
import { isStateData, parsePreviewMessage } from '../previewMessages';

const channel = 'host-created-channel';
const request = { type: 'atoms:request', channel, id: 'request-1', operation: 'load' };

test('preview requests accept only the host channel and fixed schema', () => {
  assert.equal(parsePreviewMessage(request, channel)?.type, 'atoms:request');
  assert.equal(parsePreviewMessage({ ...request, channel: 'other-frame' }, channel), null);
  assert.equal(parsePreviewMessage({ ...request, artifactId: 'other-artifact' }, channel), null);
  assert.equal(parsePreviewMessage({ ...request, projectId: 'other-project' }, channel), null);
  assert.equal(parsePreviewMessage({ ...request, operation: 'fetch' }, channel), null);
  assert.equal(parsePreviewMessage({ ...request, id: '' }, channel), null);
  assert.equal(parsePreviewMessage({ ...request, id: 'a'.repeat(129) }, channel), null);
  assert.equal(parsePreviewMessage(null, channel), null);
  assert.equal(parsePreviewMessage([request], channel), null);
});

test('preview readiness and errors must match their message schema', () => {
  assert.deepEqual(parsePreviewMessage({ type: 'atoms:ready', channel }, channel), { type: 'atoms:ready', channel });
  assert.equal(parsePreviewMessage({ type: 'atoms:ready', channel, token: 'not-allowed' }, channel), null);
  assert.deepEqual(parsePreviewMessage({ type: 'atoms:runtime-error', channel, error: 'Application error' }, channel), {
    type: 'atoms:runtime-error', channel, error: 'Application error',
  });
  assert.equal(parsePreviewMessage({ type: 'atoms:runtime-error', channel, error: {} }, channel), null);
  assert.equal(parsePreviewMessage({ type: 'atoms:runtime-error', channel, error: 'x'.repeat(4001) }, channel), null);
});

test('state validation permits JSON app state and rejects unsafe structured-clone payloads', () => {
  assert.equal(isStateData({ tasks: [{ id: 't1', done: false }], amount: 300, optional: null }), true);
  assert.equal(isStateData({}), true);
  assert.equal(isStateData([]), false);
  assert.equal(isStateData({ value: NaN }), false);
  assert.equal(isStateData({ value: Infinity }), false);
  assert.equal(isStateData({ value: undefined }), false);
  assert.equal(isStateData({ value: new Map([['key', 'value']]) }), false);
  assert.equal(isStateData({ value: new Date() }), false);
  assert.equal(isStateData({ value: () => undefined }), false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isStateData(cyclic), false);
  assert.equal(isStateData({ text: 'x'.repeat(256001) }), false);
  assert.equal(isStateData({ items: new Array(20001).fill(null) }), false);
});
