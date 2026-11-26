import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mysql, { type Pool, type PoolConnection, type PoolOptions, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { and, eq, gt } from 'drizzle-orm';
import * as schema from './schema';
import { migrations } from './migrations';
import { HttpError, positiveInteger } from './errors';
import type { GenerationMode, GenerationRun, ProjectDetail, ProjectSummary, RunEvent, RunStatus, SavedState, SessionInfo, StartGeneration, StartResult } from '../shared/types';

export const DAILY_LIMIT = positiveInteger(process.env.AI_DAILY_LIMIT ?? process.env.VISITOR_DAILY_LIMIT, 3);
export const SITE_DAILY_LIMIT = positiveInteger(process.env.AI_SITE_DAILY_LIMIT ?? process.env.GLOBAL_DAILY_LIMIT, 20);
const pending = ['planning', 'generating', 'validating', 'saving'];
const dbError = () => new HttpError(503, '数据库暂时不可用，未切换为临时存储，请稍后重试。', 'DATABASE_UNAVAILABLE');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
};
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z')).toISOString();

export function poolOptions(dsn: string): PoolOptions {
  const url = new URL(dsn);
  if (!['mysql:', 'mysql2:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error('Invalid database configuration');
  const options: PoolOptions = {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: positiveInteger(process.env.DB_POOL_SIZE, 5, 20), waitForConnections: true, queueLimit: 50,
    connectTimeout: 10000, timezone: 'Z', dateStrings: true, charset: 'utf8mb4', multipleStatements: false,
    enableKeepAlive: true,
  };
  const params = url.searchParams;
  const mode = (params.get('sslmode') ?? params.get('ssl-mode') ?? '').toLowerCase();
  const raw = params.get('ssl');
  if (mode && !['disable', 'disabled', 'require', 'required', 'prefer', 'verify-ca', 'verify-full'].includes(mode)) throw new Error('Unsupported TLS configuration');
  const accept = params.get('sslaccept');
  if (accept && !['strict', 'accept_invalid_certs'].includes(accept)) throw new Error('Unsupported TLS configuration');
  const disabled = ['disable', 'disabled'].includes(mode) || ['false', '0', 'disabled', 'disable'].includes((raw ?? '').toLowerCase());
  const required = (!!mode && !['disable', 'disabled'].includes(mode)) || !!accept || raw?.startsWith('{') || ['true', '1', 'require', 'required'].includes((raw ?? '').toLowerCase());
  if (disabled && required) throw new Error('Conflicting TLS configuration');
  let ssl: { rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string } | undefined;
  if (raw?.startsWith('{')) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid TLS configuration');
    const value = parsed as Record<string, unknown>;
    ssl = { rejectUnauthorized: value.rejectUnauthorized !== false };
    for (const key of ['ca', 'cert', 'key'] as const) if (typeof value[key] === 'string') ssl[key] = value[key];
  } else if (required) {
    ssl = { rejectUnauthorized: true };
  } else if (raw && !['false', '0', 'disabled', 'disable'].includes(raw.toLowerCase())) throw new Error('Unsupported TLS configuration');
  if (ssl) {
    const reject = params.get('rejectUnauthorized') ?? params.get('sslrejectunauthorized');
    if (reject === 'false' || reject === '0' || params.get('sslaccept') === 'accept_invalid_certs') ssl.rejectUnauthorized = false;
    if (reject === 'true' || params.get('sslaccept') === 'strict') ssl.rejectUnauthorized = true;
    for (const [parameter, key] of [['sslca', 'ca'], ['sslcert', 'cert'], ['sslkey', 'key']] as const) {
      const value = params.get(parameter); if (value) ssl[key] = value;
    }
    options.ssl = ssl;
  }
  return options;
}

type ProjectRow = { id: string; owner_id: string; title: string; prompt: string; mode: GenerationMode; artifact_id: string | null; active_run_id: string | null; updated_at: unknown };
export type RunRow = { id: string; project_id: string; owner_id: string; request_id: string; prompt: string; mode: GenerationMode; status: RunStatus; events: unknown; error: string | null; model: string | null; token_usage: unknown; updated_at: unknown; boot_id: string };
export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
type Connection = Pool | PoolConnection;
async function rows<T extends object>(connection: Connection, sql: string, values: unknown[] = []): Promise<T[]> {
  const [result] = await connection.query<(T & RowDataPacket)[]>(sql, values);
  return result;
}
const summary = (row: ProjectRow): ProjectSummary => ({ id: row.id, title: row.title, prompt: row.prompt, mode: row.mode, artifactId: row.artifact_id, updatedAt: iso(row.updated_at) });
const runInfo = (row: RunRow): GenerationRun => ({ id: row.id, projectId: row.project_id, status: row.status, events: parseJson<RunEvent[]>(row.events, []), error: row.error, model: row.model, updatedAt: iso(row.updated_at) });

export class Database {
  private pool: Pool | null = null;
  private orm: MySql2Database<typeof schema> | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private retryAt = 0;
  constructor(readonly bootId: string) {}

  async ready(): Promise<boolean> {
    try { await this.ensure(); await this.pool!.query('SELECT 1'); return true; } catch { return false; }
  }
  async ensure(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    if (Date.now() < this.retryAt) throw dbError();
    this.initializing = (async () => {
      try {
        if (!this.pool) {
          if (!process.env.DATABASE_URL) throw dbError();
          this.pool = mysql.createPool(poolOptions(process.env.DATABASE_URL));
          this.orm = drizzle(this.pool, { schema, mode: 'default' });
        }
        for (const sql of migrations) await this.pool.query(sql);
        // Development and rolling deployments share the DB. A different boot ID can still be alive.
        await this.pool.query(`UPDATE atoms_runs SET status='interrupted', error=?, updated_at=UTC_TIMESTAMP(3),
          events=JSON_ARRAY_APPEND(events, '$', JSON_OBJECT('stage','interrupted','message',?,'at',?))
          WHERE status IN ('planning','generating','validating','saving')
          AND heartbeat_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 240 SECOND)`,
        ['长时间未收到任务心跳，本轮生成已中断；请手动重试。', '任务心跳已过期，保留已有成功版本。', new Date().toISOString()]);
        await this.pool.query(`UPDATE atoms_projects p JOIN atoms_runs r ON p.active_run_id=r.id
          SET p.active_run_id=NULL WHERE r.status IN ('failed','succeeded','interrupted')`);
        this.initialized = true;
      } catch (error) {
        const safe = error && typeof error === 'object' ? error as { code?: string; errno?: number; sqlState?: string } : {};
        console.error('[atoms] database initialization failed', { code: safe.code, errno: safe.errno, sqlState: safe.sqlState });
        this.retryAt = Date.now() + 5000; throw dbError();
      }
      finally { this.initializing = null; }
    })();
    return this.initializing;
  }
  private async access<T>(operation: () => Promise<T>): Promise<T> {
    try { await this.ensure(); return await operation(); } catch (error) { if (error instanceof HttpError) throw error; throw dbError(); }
  }
  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    return this.access(async () => {
      const connection = await this.pool!.getConnection();
      try { await connection.beginTransaction(); const result = await operation(connection); await connection.commit(); return result; }
      catch (error) { try { await connection.rollback(); } catch { /* no raw diagnostics */ } throw error; }
      finally { connection.release(); }
    });
  }
  async session(token?: string): Promise<SessionInfo> {
    if (token) return { token, visitorId: await this.authenticate(token), dailyLimit: DAILY_LIMIT };
    return this.access(async () => {
      const token = randomBytes(32).toString('hex'); const visitorId = randomUUID(); const now = new Date();
      await this.orm!.insert(schema.visitors).values({ id: visitorId, tokenHash: tokenHash(token), createdAt: now, expiresAt: new Date(now.getTime() + 30 * 86400000) });
      return { token, visitorId, dailyLimit: DAILY_LIMIT };
    });
  }
  async authenticate(token: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new HttpError(401, '访客凭证无效或已过期。', 'INVALID_SESSION');
    return this.access(async () => {
      const found = await this.orm!.select({ id: schema.visitors.id }).from(schema.visitors).where(and(eq(schema.visitors.tokenHash, tokenHash(token)), gt(schema.visitors.expiresAt, new Date()))).limit(1);
      if (!found[0]) throw new HttpError(401, '访客凭证无效或已过期。', 'INVALID_SESSION');
      return found[0].id;
    });
  }
  async projects(owner: string): Promise<ProjectSummary[]> {
    return this.access(async () => (await rows<ProjectRow>(this.pool!, 'SELECT * FROM atoms_projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200', [owner])).map(summary));
  }
  async project(owner: string, id: string): Promise<ProjectDetail> {
    return this.access(async () => {
      const found = await rows<ProjectRow & { html: string | null; model: string | null; data: unknown; version: number | null }>(this.pool!,
        `SELECT p.*, a.html, a.model, s.data, s.version FROM atoms_projects p
         LEFT JOIN atoms_artifacts a ON a.id=p.artifact_id AND a.owner_id=p.owner_id
         LEFT JOIN atoms_states s ON s.artifact_id=a.id AND s.owner_id=p.owner_id WHERE p.id=? AND p.owner_id=?`, [id, owner]);
      const row = found[0]; if (!row) throw new HttpError(404, '项目不存在。', 'NOT_FOUND');
      return { ...summary(row), html: row.html, model: row.model, state: { data: parseJson(row.data, {}), version: row.version ?? 0 } };
    });
  }
  async start(owner: string, input: StartGeneration, aiConfigured: boolean, capacityAvailable: () => boolean): Promise<StartResult & { created: boolean }> {
    return this.transaction(async connection => {
      const visitors = await rows<{ id: string }>(connection, 'SELECT id FROM atoms_visitors WHERE id=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [owner]);
      if (!visitors.length) throw new HttpError(401, '访客凭证已过期。', 'INVALID_SESSION');
      const old = await rows<RunRow>(connection, 'SELECT * FROM atoms_runs WHERE owner_id=? AND request_id=?', [owner, input.requestId]);
      if (old[0]) {
        if (old[0].prompt !== input.prompt || old[0].mode !== input.mode || (input.projectId && old[0].project_id !== input.projectId)) throw new HttpError(409, '幂等键已用于不同的请求。', 'IDEMPOTENCY_CONFLICT');
        return { runId: old[0].id, projectId: old[0].project_id, created: false };
      }
      if (input.mode === 'ai' && !aiConfigured) throw new HttpError(503, '尚未配置真实 AI 服务，可选择明确标注的示例模式。', 'AI_NOT_CONFIGURED');
      if (!capacityAvailable()) throw new HttpError(503, '生成队列暂时已满，请稍后再试。', 'QUEUE_FULL');
      const projectId = input.projectId ?? randomUUID();
      if (input.projectId) {
        const project = (await rows<ProjectRow>(connection, 'SELECT * FROM atoms_projects WHERE id=? AND owner_id=? FOR UPDATE', [projectId, owner]))[0];
        if (!project) throw new HttpError(404, '项目不存在。', 'NOT_FOUND');
        if (project.active_run_id) throw new HttpError(409, '此项目已有生成任务，请等待当前任务结束。', 'PROJECT_BUSY');
      }
      if (input.mode === 'ai') {
        const day = new Date().toISOString().slice(0, 10);
        // Global row is always locked before per-visitor row. Both reservations commit with the run.
        for (const [subject, limit] of [['global', SITE_DAILY_LIMIT], [owner, DAILY_LIMIT]] as const) {
          await connection.query('INSERT IGNORE INTO atoms_daily_usage (day,subject,count) VALUES (?,?,0)', [day, subject]);
          const [result] = await connection.query<ResultSetHeader>('UPDATE atoms_daily_usage SET count=count+1 WHERE day=? AND subject=? AND count<?', [day, subject, limit]);
          if (!result.affectedRows) throw new HttpError(429, subject === 'global' ? '今日全站 AI 额度已用完，请明天再试。' : `今日 ${DAILY_LIMIT} 次 AI 额度已用完，请明天再试。`, 'DAILY_LIMIT');
        }
      }
      const runId = randomUUID(); const at = new Date();
      if (!input.projectId) await connection.query('INSERT INTO atoms_projects (id,owner_id,title,prompt,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [projectId, owner, input.prompt.slice(0, 60), input.prompt, input.mode, at, at]);
      const event: RunEvent = { stage: 'planning', message: input.mode === 'ai' ? '请求已保存，正在选择可用模型。' : '正在创建明确标注的交互示例（不调用 AI）。', at: at.toISOString() };
      await connection.query(`INSERT INTO atoms_runs (id,project_id,owner_id,request_id,prompt,mode,status,events,boot_id,heartbeat_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'planning',?,?,?,?,?)`, [runId, projectId, owner, input.requestId, input.prompt, input.mode, JSON.stringify([event]), this.bootId, at, at, at]);
      await connection.query('UPDATE atoms_projects SET active_run_id=?, updated_at=? WHERE id=? AND owner_id=?', [runId, at, projectId, owner]);
      return { runId, projectId, created: true };
    });
  }
  async run(owner: string, id: string): Promise<GenerationRun> {
    return this.access(async () => {
      const row = (await rows<RunRow>(this.pool!, 'SELECT * FROM atoms_runs WHERE id=? AND owner_id=?', [id, owner]))[0];
      if (!row) throw new HttpError(404, '生成任务不存在。', 'NOT_FOUND');
      return runInfo(row);
    });
  }
  async workRun(id: string): Promise<RunRow> {
    return this.access(async () => {
      const row = (await rows<RunRow>(this.pool!, 'SELECT * FROM atoms_runs WHERE id=? AND boot_id=?', [id, this.bootId]))[0];
      if (!row || !pending.includes(row.status)) throw new HttpError(409, '生成任务已结束或已中断。', 'RUN_INTERRUPTED');
      return row;
    });
  }
  async event(id: string, status: RunStatus, message: string, model?: string): Promise<void> {
    return this.access(async () => {
      const event: RunEvent = { stage: status, message, at: new Date().toISOString() };
      const [result] = await this.pool!.query<ResultSetHeader>(`UPDATE atoms_runs SET status=?, events=JSON_ARRAY_APPEND(events,'$',CAST(? AS JSON)),
        model=COALESCE(?,model), heartbeat_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3)
        WHERE id=? AND boot_id=? AND status IN ('planning','generating','validating','saving')`, [status, JSON.stringify(event), model ?? null, id, this.bootId]);
      if (!result.affectedRows) throw new HttpError(409, '生成任务已中断。', 'RUN_INTERRUPTED');
    });
  }
  async heartbeat(id: string): Promise<void> {
    await this.access(async () => { await this.pool!.query(`UPDATE atoms_runs SET heartbeat_at=UTC_TIMESTAMP(3) WHERE id=? AND boot_id=? AND status IN ('planning','generating','validating','saving')`, [id, this.bootId]); });
  }
  async usage(id: string, usage: Usage): Promise<void> {
    await this.access(async () => { await this.pool!.query('UPDATE atoms_runs SET token_usage=? WHERE id=? AND boot_id=?', [JSON.stringify(usage), id, this.bootId]); });
  }
  async save(run: RunRow, html: string, title: string, model: string | null, usage: Usage | null): Promise<void> {
    await this.transaction(async connection => {
      const current = (await rows<RunRow>(connection, 'SELECT * FROM atoms_runs WHERE id=? AND boot_id=? FOR UPDATE', [run.id, this.bootId]))[0];
      if (!current || !pending.includes(current.status)) throw new HttpError(409, '生成任务已中断。', 'RUN_INTERRUPTED');
      const project = (await rows<ProjectRow>(connection, 'SELECT * FROM atoms_projects WHERE id=? AND owner_id=? FOR UPDATE', [run.project_id, run.owner_id]))[0];
      if (!project || project.active_run_id !== run.id) throw new HttpError(409, '项目生成锁已失效。', 'RUN_INTERRUPTED');
      const oldState = project.artifact_id ? (await rows<{ data: unknown }>(connection, 'SELECT data FROM atoms_states WHERE artifact_id=? AND owner_id=? FOR UPDATE', [project.artifact_id, run.owner_id]))[0] : undefined;
      const artifactId = randomUUID(); const at = new Date();
      await connection.query('INSERT INTO atoms_artifacts (id,project_id,owner_id,html,title,model,token_usage,created_at) VALUES (?,?,?,?,?,?,?,?)', [artifactId, run.project_id, run.owner_id, html, title.slice(0, 255), model, usage ? JSON.stringify(usage) : null, at]);
      await connection.query('INSERT INTO atoms_states (artifact_id,owner_id,data,version,updated_at) VALUES (?,?,?,0,?)', [artifactId, run.owner_id, JSON.stringify(parseJson(oldState?.data, {})), at]);
      await connection.query('UPDATE atoms_projects SET artifact_id=?,active_run_id=NULL,title=?,prompt=?,mode=?,updated_at=? WHERE id=? AND owner_id=?', [artifactId, title.slice(0, 255), run.prompt, run.mode, at, run.project_id, run.owner_id]);
      const event: RunEvent = { stage: 'succeeded', message: '交互页面和业务状态已持久化。', at: at.toISOString() };
      await connection.query(`UPDATE atoms_runs SET status='succeeded',error=NULL,model=?,token_usage=?,events=JSON_ARRAY_APPEND(events,'$',CAST(? AS JSON)),updated_at=?,heartbeat_at=? WHERE id=?`, [model, usage ? JSON.stringify(usage) : null, JSON.stringify(event), at, at, run.id]);
    });
  }
  async fail(id: string, message: string, status: 'failed' | 'interrupted' = 'failed'): Promise<void> {
    await this.transaction(async connection => {
      const run = (await rows<RunRow>(connection, 'SELECT * FROM atoms_runs WHERE id=? AND boot_id=? FOR UPDATE', [id, this.bootId]))[0];
      if (!run || !pending.includes(run.status)) return;
      const event: RunEvent = { stage: status, message, at: new Date().toISOString() };
      await connection.query(`UPDATE atoms_runs SET status=?,error=?,events=JSON_ARRAY_APPEND(events,'$',CAST(? AS JSON)),updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [status, message, JSON.stringify(event), id]);
      await connection.query('UPDATE atoms_projects SET active_run_id=NULL WHERE id=? AND owner_id=? AND active_run_id=?', [run.project_id, run.owner_id, id]);
    });
  }
  async state(owner: string, artifactId: string): Promise<SavedState> {
    return this.access(async () => {
      const row = (await rows<{ data: unknown; version: number }>(this.pool!, `SELECT s.data,s.version FROM atoms_states s JOIN atoms_artifacts a ON a.id=s.artifact_id AND a.owner_id=s.owner_id JOIN atoms_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE s.artifact_id=? AND s.owner_id=?`, [artifactId, owner]))[0];
      if (!row) throw new HttpError(404, '产物不存在。', 'NOT_FOUND');
      return { data: parseJson(row.data, {}), version: row.version };
    });
  }
  async putState(owner: string, artifactId: string, data: Record<string, unknown>, version: number): Promise<SavedState> {
    return this.transaction(async connection => {
      const row = (await rows<{ version: number }>(connection, `SELECT s.version FROM atoms_states s JOIN atoms_artifacts a ON a.id=s.artifact_id AND a.owner_id=s.owner_id JOIN atoms_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE s.artifact_id=? AND s.owner_id=? FOR UPDATE`, [artifactId, owner]))[0];
      if (!row) throw new HttpError(404, '产物不存在。', 'NOT_FOUND');
      if (row.version !== version) throw new HttpError(409, '状态已被其他页面更新，请重新加载后再保存。', 'STATE_CONFLICT');
      const [result] = await connection.query<ResultSetHeader>('UPDATE atoms_states SET data=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE artifact_id=? AND owner_id=? AND version=?', [JSON.stringify(data), artifactId, owner, version]);
      if (!result.affectedRows) throw new HttpError(409, '状态版本冲突。', 'STATE_CONFLICT');
      return { data, version: version + 1 };
    });
  }
  async exportData(owner: string, projectId: string): Promise<{ html: string; title: string; state: Record<string, unknown> }> {
    const project = await this.project(owner, projectId);
    if (!project.html || !project.artifactId) throw new HttpError(409, '项目尚无可导出的成功版本。', 'NO_ARTIFACT');
    return { html: project.html, title: project.title, state: project.state.data };
  }
  async recoverStale(): Promise<void> {
    await this.access(async () => {
      await this.pool!.query(`UPDATE atoms_runs SET status='interrupted',error=?,updated_at=UTC_TIMESTAMP(3),events=JSON_ARRAY_APPEND(events,'$',JSON_OBJECT('stage','interrupted','message',?,'at',?)) WHERE status IN ('planning','generating','validating','saving') AND heartbeat_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 240 SECOND)`, ['生成任务已超时中断，请手动重试。', '长时间未收到任务心跳，已保留旧版本。', new Date().toISOString()]);
      await this.pool!.query(`UPDATE atoms_projects p JOIN atoms_runs r ON p.active_run_id=r.id SET p.active_run_id=NULL WHERE r.status IN ('failed','succeeded','interrupted')`);
    });
  }
  async close(): Promise<void> { await this.pool?.end(); }
}
