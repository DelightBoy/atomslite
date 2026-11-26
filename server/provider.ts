import { HttpError } from './errors';
import { tokenCap, type ModelInfo } from './model-selection';
import type { Usage } from './db';

export function providerConfig(): { baseUrl: string; key: string } | null {
  const rawUrl = process.env.MANUS_API_URL ?? process.env.BUILT_IN_FORGE_API_URL;
  const key = process.env.MANUS_API_KEY ?? process.env.BUILT_IN_FORGE_API_KEY;
  if (!rawUrl || !key) return null;
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const base = rawUrl.replace(/\/+$/, '');
    return { baseUrl: base.endsWith('/v1') ? base : `${base}/v1`, key };
  } catch { return null; }
}

export class ProviderError extends HttpError {
  constructor(message: string, code: string, readonly retryable = false) { super(502, message, code); }
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

export function normalizeCatalog(payload: unknown): ModelInfo[] {
  const container = object(payload);
  const data = Array.isArray(payload) ? payload : Array.isArray(container.data) ? container.data : Array.isArray(container.models) ? container.models : [];
  return data.flatMap(raw => {
    const model = object(raw);
    if (typeof model.id !== 'string' || !model.id || model.id.length > 255) return [];
    const capabilities: string[] = [];
    if (Array.isArray(model.capabilities)) {
      for (const capability of model.capabilities) if (typeof capability === 'string') capabilities.push(capability.slice(0, 80));
    } else if (model.capabilities && typeof model.capabilities === 'object') {
      for (const [key, value] of Object.entries(object(model.capabilities))) if (value === true) capabilities.push(key.slice(0, 80));
    }
    for (const key of ['modalities', 'output_modalities', 'supported_tasks', 'tags']) {
      if (Array.isArray(model[key])) for (const value of model[key] as unknown[]) if (typeof value === 'string') capabilities.push(value.slice(0, 80));
    }
    if (model.supports_coding === true) capabilities.push('coding');
    const pricing: Record<string, number> = {};
    const source = object(model.pricing ?? model.price);
    for (const key of ['input', 'output', 'prompt', 'completion', 'input_per_million', 'output_per_million']) {
      const value = numeric(source[key]); if (value !== undefined) pricing[key] = value;
    }
    const description = typeof model.description === 'string' ? model.description.slice(0, 3000) : typeof model.name === 'string' ? model.name.slice(0, 500) : '';
    const status = String(model.status ?? '').toLowerCase();
    return [{ id: model.id, description, capabilities: [...new Set(capabilities)], pricing: Object.keys(pricing).length ? pricing : null,
      deprecated: model.deprecated === true || !!model.deprecated_at || ['deprecated', 'superseded'].includes(status) || /\bsuperseded\b|shutdown date/i.test(description),
      available: model.available !== false && model.enabled !== false && !['disabled', 'unavailable', 'temporarily_unavailable', 'retired'].includes(status) && !/currently unsupported/i.test(description) }];
  });
}

async function responseJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > 2 * 1024 * 1024) throw new ProviderError('AI 服务返回内容过大。', 'AI_RESPONSE_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('AI 服务未返回内容。', 'AI_EMPTY_RESPONSE');
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ProviderError('AI 服务返回内容过大。', 'AI_RESPONSE_INVALID'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProviderError('AI 服务返回了无效内容。', 'AI_RESPONSE_INVALID'); }
}

async function call(path: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = providerConfig();
  if (!config) throw new HttpError(503, '尚未配置真实 AI 服务。', 'AI_NOT_CONFIGURED');
  try {
    const response = await fetch(`${config.baseUrl}${path}`, { method: body ? 'POST' : 'GET', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const failure = object(await responseJson(response).catch(() => ({})));
      const error = object(failure.error);
      const detail = String(error.message ?? error.code ?? '');
      if ([401, 403].includes(response.status)) throw new ProviderError('AI 服务认证失败，请联系管理员检查配置。', 'AI_AUTH_FAILED');
      if ([402, 429].includes(response.status) || /insufficient|credits?|balance|quota/i.test(detail)) throw new ProviderError('AI 服务额度或速率暂时受限，请稍后再试。', 'AI_PROVIDER_LIMIT');
      if (response.status === 400 || response.status === 404 || response.status === 422) throw new ProviderError('所选模型或请求参数未获 AI 服务支持。', 'AI_REQUEST_UNSUPPORTED');
      throw new ProviderError('AI 服务暂时不可用。', 'AI_UPSTREAM_UNAVAILABLE', [502, 503, 504].includes(response.status));
    }
    const parsed = await responseJson(response);
    const payload = Array.isArray(parsed) ? { data: parsed } : object(parsed);
    if (payload.error) {
      const error = object(payload.error);
      const detail = String(error.message ?? error.code ?? '');
      if (/insufficient|credits?|balance|quota/i.test(detail)) throw new ProviderError('AI 服务额度不足，请使用示例模式或联系管理员。', 'AI_PROVIDER_LIMIT');
      throw new ProviderError('AI 服务报告生成失败。', 'AI_PROVIDER_ERROR');
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new ProviderError('AI 生成超过 90 秒或服务已停止，请手动重试。', 'AI_TIMEOUT');
    throw new ProviderError('AI 服务连接失败。', 'AI_NETWORK_ERROR', true);
  }
}

export async function fetchCatalog(): Promise<ModelInfo[]> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const payload = await call('/models', controller.signal);
    const models = normalizeCatalog(payload);
    if (!models.length) throw new ProviderError('AI 服务没有返回可用模型目录。', 'AI_CATALOG_EMPTY');
    return models;
  } finally { clearTimeout(timer); }
}

export const systemPrompt = `你是 Atoms Lite 的单文件应用开发者。直接输出完整 <!doctype html> HTML 文件，不解释思考过程，不输出 Markdown。
构建真正可操作的小型应用，必须有真实输入控件和按钮、可用计算或增删改交互；中文界面，现代简洁设计、响应式布局、明显反馈和空状态。
全部 HTML/CSS/JavaScript 内联，尽量少于200行；不使用外部脚本、样式、字体、图片，不访问网络，不包含密钥，不读取父窗口或document.cookie。
唯一持久化接口是宿主提供的 window.atoms：启动时 await window.atoms.loadState() 返回业务 JSON 对象；每次业务变化 await window.atoms.saveState(nextObject)，参数必须是 JSON 对象。不要依赖localStorage、IndexedDB、fetch或其他网络API。处理加载/保存失败并在界面显示友好的提示。
将脚本封装在 async 启动函数中，等待DOM可用后绑定事件；使用textContent安全显示用户输入，避免eval、Function、动态脚本及内联事件属性。
给出非空<title>。页面禁止iframe、form外部提交、导航外部链接、下载、弹窗及浏览器权限。只输出一个完整HTML文件。`;

export async function complete(model: string, prompt: string, signal: AbortSignal, previousHtml?: string, repair?: string): Promise<{ html: string; usage: Usage; model: string }> {
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];
  if (previousHtml) messages.push({ role: 'user', content: `基于此已成功版本修改，保留合理的状态字段：\n${previousHtml.slice(0, 45000)}` });
  if (repair) messages.push({ role: 'user', content: `上一轮HTML未通过安全与交互校验。请从需求重新生成完整文件，修复规范违规；不要解释。上轮文件供参考：\n${repair.slice(0, 45000)}` });
  const payload = await call('/chat/completions', signal, { model, messages, stream: false, ...tokenCap(model) });
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = object(object(choices[0]).message);
  const content = message.content;
  const html = typeof content === 'string' ? content : Array.isArray(content) ? content.map(value => { const text = object(value).text; return typeof text === 'string' ? text : ''; }).join('') : '';
  const rawUsage = object(payload.usage);
  const inputTokens = numeric(rawUsage.prompt_tokens ?? rawUsage.input_tokens) ?? 0;
  const outputTokens = numeric(rawUsage.completion_tokens ?? rawUsage.output_tokens) ?? 0;
  const usage = { inputTokens, outputTokens, totalTokens: numeric(rawUsage.total_tokens) ?? inputTokens + outputTokens };
  if (!html.trim()) throw new ProviderError('AI 未返回可用页面。', 'AI_EMPTY_RESPONSE');
  return { html: html.trim().replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim(), usage,
    model: typeof payload.model === 'string' && payload.model.length <= 255 && payload.model ? payload.model : model };
}
