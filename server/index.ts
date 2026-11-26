import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, DAILY_LIMIT } from './db';
import { GenerationExecutor } from './generation';
import { HttpError, assertObject, assertState } from './errors';
import { fetchCatalog, providerConfig } from './provider';
import { buildExportDocument } from '../shared/preview';
import type { StartGeneration } from '../shared/types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(raw: unknown): string {
  if (typeof raw !== 'string' || !uuid.test(raw)) throw new HttpError(400, '标识符格式无效。', 'INVALID_ID');
  return raw;
}
function bearer(req: Request, optional = false): string | undefined {
  const authorization = req.get('authorization');
  if (!authorization && optional) return undefined;
  const match = authorization?.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) throw new HttpError(401, '请提供有效的 Bearer 访客凭证。', 'AUTH_REQUIRED');
  return match[1];
}
export function parseGeneration(raw: unknown): StartGeneration {
  assertObject(raw);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 4000) throw new HttpError(400, '请输入 1–4000 字的生成需求。', 'INVALID_PROMPT');
  if (raw.mode !== 'ai' && raw.mode !== 'example') throw new HttpError(400, '必须明确选择 ai 或 example 模式。', 'INVALID_MODE');
  if (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(raw.requestId)) throw new HttpError(400, '请提供 8–128 位的唯一 requestId。', 'INVALID_REQUEST_ID');
  return { prompt: raw.prompt.trim(), mode: raw.mode, requestId: raw.requestId, ...(raw.projectId !== undefined ? { projectId: id(raw.projectId) } : {}) };
}

export function createApp(database: Database, executor: GenerationExecutor, bootId: string, startTime: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.get('/api/health', async (_req, res) => {
    const ready = await database.ready();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', ready, bootId, startTime });
  });
  app.get('/api/config', (_req, res) => { res.json({ aiConfigured: !!providerConfig(), dailyLimit: DAILY_LIMIT }); });
  app.use('/api', express.json({ limit: '128kb', strict: true }));
  app.get('/api/session', async (req, res) => { res.json(await database.session(bearer(req, true))); });
  app.use('/api', async (req, res, next) => {
    try { res.locals.owner = await database.authenticate(bearer(req)!); next(); } catch (error) { next(error); }
  });
  app.get('/api/models', async (_req, res) => { res.json({ models: await fetchCatalog() }); });
  app.get('/api/projects', async (_req, res) => { res.json({ projects: await database.projects(res.locals.owner) }); });
  app.get('/api/projects/:id', async (req, res) => { res.json(await database.project(res.locals.owner, id(req.params.id))); });
  app.post('/api/generations', async (req, res) => {
    const input = parseGeneration(req.body);
    let reserved = false;
    try {
      const result = await database.start(res.locals.owner, input, !!providerConfig(), () => { reserved = executor.reserve(); return reserved; });
      if (result.created) { executor.enqueue(result.runId); reserved = false; }
      res.status(result.created ? 202 : 200).json({ runId: result.runId, projectId: result.projectId });
    } finally { if (reserved) executor.release(); }
  });
  app.get('/api/runs/:id', async (req, res) => { res.json(await database.run(res.locals.owner, id(req.params.id))); });
  app.get('/api/artifacts/:artifactId/state', async (req, res) => { res.json(await database.state(res.locals.owner, id(req.params.artifactId))); });
  app.put('/api/artifacts/:artifactId/state', async (req, res) => {
    assertObject(req.body); assertState(req.body.data);
    if (typeof req.body.version !== 'number' || !Number.isSafeInteger(req.body.version) || req.body.version < 0 || req.body.version >= 4294967295) throw new HttpError(400, '状态 version 必须是有效非负整数。', 'INVALID_VERSION');
    res.json(await database.putState(res.locals.owner, id(req.params.artifactId), req.body.data, req.body.version));
  });
  app.get('/api/projects/:id/export', async (req, res) => {
    const projectId = id(req.params.id);
    const artifact = await database.exportData(res.locals.owner, projectId);
    const html = buildExportDocument(artifact.html, artifact.state, projectId);
    const filename = artifact.title.replace(/[\x00-\x1f\x7f\\/<>:"|?*]/g, '-').slice(0, 100) || 'atoms-project';
    res.setHeader('Content-Disposition', `attachment; filename="atoms-project.html"; filename*=UTF-8''${encodeURIComponent(filename + '.html').replace(/'/g, '%27')}`);
    res.type('html').send(html);
  });
  app.use('/api', (_req, _res, next) => { next(new HttpError(404, 'API 不存在。', 'NOT_FOUND')); });
  return app;
}

export function installErrorHandler(app: express.Express): void {
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const bodyError = error && typeof error === 'object' ? error as { type?: string } : {};
    if (bodyError.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大。', code: 'BODY_TOO_LARGE' }); return; }
    if (bodyError.type === 'entity.parse.failed') { res.status(400).json({ error: '请求必须是有效 JSON。', code: 'INVALID_JSON' }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    console.error('[atoms] request failed (details redacted)');
    res.status(500).json({ error: '服务暂时无法完成请求，请稍后再试。', code: 'INTERNAL_ERROR' });
  });
}

export function listenOptions(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const rawPort = env.PORT ?? '3000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return { host: env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'), port: Number(rawPort) };
}

async function frontend(app: express.Express, server: Server): Promise<(() => Promise<void>) | undefined> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.env.NODE_ENV === 'production') {
    const publicDir = join(root, 'dist/public');
    app.use(express.static(publicDir, { index: false }));
    app.get('/{*path}', (_req, res) => { res.sendFile(join(publicDir, 'index.html')); });
    return;
  }
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ configFile: join(root, 'vite.config.ts'), root: join(root, 'client'), server: { middlewareMode: true, hmr: { server } }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try { const template = await readFile(join(root, 'client/index.html'), 'utf8'); res.type('html').send(await vite.transformIndexHtml(req.originalUrl, template)); }
    catch { next(new HttpError(503, '开发页面暂时不可用。', 'FRONTEND_UNAVAILABLE')); }
  });
  return () => vite.close();
}

export async function bootstrap(): Promise<void> {
  const { host, port } = listenOptions();
  const bootId = randomUUID(); const startTime = new Date().toISOString();
  const database = new Database(bootId); const executor = new GenerationExecutor(database);
  const app = createApp(database, executor, bootId, startTime); const server = createServer(app);
  const closeFrontend = await frontend(app, server); installErrorHandler(app);
  server.on('error', () => { console.error('[atoms] listen failed; check HOST/PORT (no port fallback)'); process.exitCode = 1; void executor.stop().finally(async () => { await closeFrontend?.(); await database.close(); }); });
  await new Promise<void>((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, host, () => { server.removeListener('error', rejectListen); resolveListen(); }); });
  console.info(`[atoms] service listening on ${host}:${port}`);
  void database.ready().then(ready => { console.info(`[atoms] database ${ready ? 'ready' : 'not ready'}`); });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10000); deadline.unref();
    server.close(); await executor.stop(); await closeFrontend?.(); await database.close(); clearTimeout(deadline); process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void bootstrap().catch(() => { console.error('[atoms] startup failed (configuration/details redacted)'); process.exitCode = 1; });
}
