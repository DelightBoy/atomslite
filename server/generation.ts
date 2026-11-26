import { Database, type Usage } from './db';
import { positiveInteger, safeRunError, HttpError } from './errors';
import { complete, fetchCatalog, ProviderError } from './provider';
import { selectModel } from './model-selection';
import { getExampleHtml } from '../shared/examples';
import { validateGeneratedHtml } from '../shared/validation';

type Job = { id: string; controller: AbortController };
export class GenerationExecutor {
  private permits = 0;
  private running = 0;
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private stopped = false;
  private concurrency = positiveInteger(process.env.GENERATION_CONCURRENCY, 2, 4);
  private capacity = positiveInteger(process.env.GENERATION_QUEUE_LIMIT, 20, 100);
  private timer: ReturnType<typeof setInterval>;
  constructor(private database: Database) {
    this.timer = setInterval(() => {
      for (const id of this.jobs.keys()) void this.database.heartbeat(id).catch(() => { /* persisted stale recovery handles DB outage */ });
      void this.database.recoverStale().catch(() => { /* no fake in-memory persistence */ });
    }, 15000);
    this.timer.unref();
  }
  reserve(): boolean {
    if (this.stopped || this.permits >= this.capacity) return false;
    this.permits++; return true;
  }
  release(): void { this.permits = Math.max(0, this.permits - 1); }
  enqueue(id: string): void {
    const job = { id, controller: new AbortController() };
    this.jobs.set(id, job); this.queue.push(job); this.drain();
  }
  private drain(): void {
    while (!this.stopped && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.running++;
      void this.execute(job).finally(() => { this.jobs.delete(job.id); this.running--; this.release(); this.drain(); });
    }
  }
  private async execute(job: Job): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = await this.database.workRun(job.id);
      let html: string; let title: string; let model: string | null = null; let usage: Usage | null = null;
      if (run.mode === 'example') {
        await this.database.event(job.id, 'generating', '正在构建示例，未调用 AI 模型。');
        const raw = getExampleHtml(run.prompt);
        await this.database.event(job.id, 'validating', '正在校验示例交互页面。');
        ({ html, title } = validateGeneratedHtml(raw));
      } else {
        let selected;
        try { selected = selectModel(await fetchCatalog()); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, '当前目录没有可选的可用编程模型，请检查模型配置。', 'MODEL_UNAVAILABLE'); }
        model = selected.id;
        await this.database.event(job.id, 'generating', '已选择实时目录中的模型，正在生成交互页面。', model);
        timeout = setTimeout(() => job.controller.abort(), 90000);
        const existing = await this.database.project(run.owner_id, run.project_id);
        usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let repair: string | undefined; let validated: { html: string; title: string } | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try { response = await complete(selected.id, run.prompt, job.controller.signal, existing.html ?? undefined, repair); }
          catch (error) {
            if (attempt === 0 && error instanceof ProviderError && error.retryable && !job.controller.signal.aborted) {
              await this.database.event(job.id, 'generating', 'AI 连接暂时异常，正在进行唯一一次重试。');
              await new Promise(resolve => setTimeout(resolve, 500)); continue;
            }
            throw error;
          }
          usage.inputTokens += response.usage.inputTokens; usage.outputTokens += response.usage.outputTokens; usage.totalTokens += response.usage.totalTokens;
          model = response.model;
          await this.database.usage(job.id, usage);
          await this.database.event(job.id, 'validating', '正在检查页面安全、持久化接口和实际交互。', model);
          try { validated = validateGeneratedHtml(response.html); break; }
          catch {
            if (attempt === 0 && !job.controller.signal.aborted) {
              repair = response.html;
              await this.database.event(job.id, 'generating', '页面未通过校验，正在进行唯一一次修复。');
            } else throw new HttpError(422, 'AI 页面未通过安全或交互校验，未覆盖已有版本。', 'HTML_VALIDATION_FAILED');
          }
        }
        if (!validated) throw new HttpError(422, 'AI 页面未通过校验。', 'HTML_VALIDATION_FAILED');
        ({ html, title } = validated);
      }
      if (job.controller.signal.aborted) throw new HttpError(504, '生成已超时或中断，请手动重试。', 'RUN_INTERRUPTED');
      await this.database.event(job.id, 'saving', '正在原子保存新版本及业务状态。');
      await this.database.save(run, html, title, model, usage);
    } catch (error) {
      const interrupted = job.controller.signal.aborted;
      await this.database.fail(job.id, safeRunError(error), interrupted ? 'interrupted' : 'failed').catch(() => { /* heartbeat/restart recovery will mark abandoned runs */ });
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.keys()].map(id => this.database.fail(id, '服务停止，本轮任务已中断；旧版本已保留。', 'interrupted').catch(() => {})));
    this.queue = [];
  }
}
