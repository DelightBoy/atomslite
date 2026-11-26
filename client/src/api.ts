import type {
  ApiError,
  GenerationRun,
  ProjectDetail,
  ProjectSummary,
  SavedState,
  SessionInfo,
  StartGeneration,
  StartResult,
} from '../../shared/types';

const TOKEN_KEY = 'atoms-lite-token';
let token: string | null = null;
let sessionRequest: Promise<SessionInfo> | null = null;

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 409) {
    return '保存发生版本冲突。请刷新预览读取最新数据，再重新操作。';
  }
  if (error instanceof ApiRequestError && error.status === 401) {
    return '访客凭证已失效，请重新连接。不要清除浏览器数据，以免失去历史项目入口。';
  }
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

async function request<T>(path: string, options: RequestInit = {}, text = false): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'omit', cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiRequestError('网络连接失败，请检查网络后重试。', 0);
  }
  if (!response.ok) {
    let detail: Partial<ApiError> = {};
    try { detail = await response.json(); } catch { /* The gateway may return a non-JSON error. */ }
    throw new ApiRequestError(
      typeof detail.error === 'string' ? detail.error : `请求失败（${response.status}），请稍后重试。`,
      response.status,
      typeof detail.code === 'string' ? detail.code : undefined,
    );
  }
  if (text) return await response.text() as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiRequestError('服务返回的数据无法读取，请重试。', response.status);
  }
}

export function connectSession(): Promise<SessionInfo> {
  if (sessionRequest) return sessionRequest;
  sessionRequest = (async () => {
    try { token = localStorage.getItem(TOKEN_KEY); } catch {
      throw new ApiRequestError('浏览器阻止了本地存储。请允许此站点使用本地存储后重试。', 0);
    }
    const session = await request<SessionInfo>('/api/session');
    if (!session.token || !session.visitorId) throw new ApiRequestError('访客会话未建立，请重试。', 0);
    try { localStorage.setItem(TOKEN_KEY, session.token); } catch {
      throw new ApiRequestError('无法保存访客凭证。请允许此站点使用本地存储后重试。', 0);
    }
    token = session.token;
    return session;
  })();
  sessionRequest.catch(() => { sessionRequest = null; });
  return sessionRequest;
}

export interface AppConfig { aiConfigured: boolean; dailyLimit: number; }

export const api = {
  config: (signal?: AbortSignal) => request<AppConfig>('/api/config', { signal }),
  projects: async (signal?: AbortSignal) => (await request<{ projects: ProjectSummary[] }>('/api/projects', { signal })).projects,
  project: (id: string, signal?: AbortSignal) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, { signal }),
  generate: (body: StartGeneration, signal?: AbortSignal) => request<StartResult>('/api/generations', {
    method: 'POST', body: JSON.stringify(body), signal,
  }),
  run: (id: string, signal?: AbortSignal) => request<GenerationRun>(`/api/runs/${encodeURIComponent(id)}`, { signal }),
  loadState: (artifactId: string, signal?: AbortSignal) => request<SavedState>(`/api/artifacts/${encodeURIComponent(artifactId)}/state`, { signal }),
  saveState: (artifactId: string, state: SavedState, signal?: AbortSignal) => request<SavedState>(`/api/artifacts/${encodeURIComponent(artifactId)}/state`, {
    method: 'PUT', body: JSON.stringify(state), signal,
  }),
  exportHtml: (projectId: string, signal?: AbortSignal) => request<string>(`/api/projects/${encodeURIComponent(projectId)}/export`, { signal }, true),
};
