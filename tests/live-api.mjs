// Finite opt-in integration check. Writes only to freshly created test visitor workspaces.
// No account credentials are needed; visitor tokens stay in memory and are never logged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const base = process.argv[2];
if (!base || !process.argv.includes('--live')) throw new Error('Usage: node tests/live-api.mjs https://your-site --live');
const origin = new URL(base).origin;
async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const report = [];
const check = (name, detail) => { report.push({ name, ...detail }); console.log(name, detail); };
const health = await request('/api/health'); assert.equal(health.status, 200); assert.equal(health.data.ready, true);
check('HEALTH_READY', { ready: true, bootId: health.data.bootId });
const first = await request('/api/session'); const second = await request('/api/session');
assert.equal(first.status, 200); assert.equal(second.status, 200);
const token = first.data.token; const other = second.data.token; assert.notEqual(token, other);
const mode = process.argv.includes('--ai') ? 'ai' : 'example';
const input = { prompt: '在线验收：做一个中文项目待办看板，可以新增任务、勾选完成、删除，显示完成数量，修改后自动保存，重新打开恢复。', mode, requestId: randomUUID() };
const started = await request('/api/generations', { token, method: 'POST', body: input }); assert.equal(started.status, 202);
const same = await request('/api/generations', { token, method: 'POST', body: input });
assert.equal(same.status, 200); assert.deepEqual(same.data, started.data);
check('IDEMPOTENT_ACCEPTANCE', { initialStatus: started.status, repeatStatus: same.status });
let run;
for (let attempt = 0; attempt < 40; attempt++) {
  const polled = await request('/api/runs/' + started.data.runId, { token }); assert.equal(polled.status, 200); run = polled.data;
  if (['succeeded', 'failed', 'interrupted'].includes(run.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1500));
}
assert.equal(run.status, 'succeeded', 'Generation must succeed');
if (mode === 'ai') assert.ok(run.model);
check(mode === 'ai' ? 'AI_RUN_SAVED' : 'EXAMPLE_RUN_SAVED', { status: run.status, stages: run.events.map(event => event.stage), model: run.model });
const detail = await request('/api/projects/' + started.data.projectId, { token }); assert.equal(detail.status, 200);
assert.ok(detail.data.html.includes('atoms.saveState')); const artifactId = detail.data.artifactId;
const forbidden = await request('/api/projects/' + started.data.projectId, { token: other }); assert.equal(forbidden.status, 404);
const forbiddenState = await request('/api/artifacts/' + artifactId + '/state', { token: other }); assert.equal(forbiddenState.status, 404);
const missingAuth = await request('/api/projects'); assert.equal(missingAuth.status, 401);
check('VISITOR_ISOLATION', { project: forbidden.status, state: forbiddenState.status, noToken: missingAuth.status });
const current = await request('/api/artifacts/' + artifactId + '/state', { token }); assert.equal(current.status, 200);
const data = { tasks: [{ id: 'acceptance-task', title: '验收：刷新后仍保留', status: 'todo', priority: 'high' }] };
const saved = await request('/api/artifacts/' + artifactId + '/state', { token, method: 'PUT', body: { data, version: current.data.version } });
assert.equal(saved.status, 200); assert.equal(saved.data.version, current.data.version + 1);
const restored = await request('/api/artifacts/' + artifactId + '/state', { token }); assert.equal(restored.status, 200); assert.deepEqual(restored.data, saved.data);
const conflict = await request('/api/artifacts/' + artifactId + '/state', { token, method: 'PUT', body: { data: { overwrite: true }, version: current.data.version } });
assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'STATE_CONFLICT');
check('STATE_PERSISTENCE_AND_CAS', { savedVersion: saved.data.version, reloaded: true, staleWriteStatus: conflict.status });
const history = await request('/api/projects', { token }); assert.equal(history.status, 200); assert.ok(history.data.projects.some(project => project.id === started.data.projectId));
const exported = await request('/api/projects/' + started.data.projectId + '/export', { token }); assert.equal(exported.status, 200);
assert.equal(typeof exported.data, 'string'); assert.ok(exported.data.includes('验收：刷新后仍保留')); assert.ok(!exported.data.includes(token)); assert.ok(!exported.data.includes('window.parent.postMessage'));
await writeFile('/tmp/atoms-live-api-export.html', exported.data);
check('HISTORY_AND_INDEPENDENT_EXPORT', { found: true, exportBytes: Buffer.byteLength(exported.data), tokenFree: true });
await writeFile('/tmp/atoms-live-api-report.json', JSON.stringify({ origin, checks: report }, null, 2));
console.log('LIVE_API_CHECKS_PASSED', report.length);
