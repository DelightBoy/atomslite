export type GenerationMode = 'ai' | 'example';
export type RunStatus = 'planning' | 'generating' | 'validating' | 'saving' | 'succeeded' | 'failed' | 'interrupted';
export interface ProjectSummary {
  id: string;
  title: string;
  prompt: string;
  mode: GenerationMode;
  updatedAt: string;
  artifactId: string | null;
}
export interface SavedState { data: Record<string, unknown>; version: number; }
export interface ProjectDetail extends ProjectSummary {
  html: string | null;
  state: SavedState;
  model: string | null;
  activeRun?: { id: string; prompt: string; mode: GenerationMode } | null;
}
export interface RunEvent { stage: string; message: string; at: string; }
export interface GenerationRun {
  id: string;
  projectId: string;
  status: RunStatus;
  events: RunEvent[];
  error: string | null;
  model: string | null;
  updatedAt: string;
}
export interface SessionInfo { token: string; visitorId: string; dailyLimit: number; }
export interface StartGeneration {
  prompt: string;
  mode: GenerationMode;
  requestId: string;
  projectId?: string;
}
export interface StartResult { runId: string; projectId: string; }
export interface ApiError { error: string; code?: string; }
export const EXAMPLE_PROMPTS = [
  { title: '项目待办看板', prompt: '帮我生成一个简洁的项目待办看板，可以新增任务、设置优先级、切换待办、进行中、已完成，并保存我的任务。', tag: '任务管理' },
  { title: '房贷月供计算器', prompt: '生成一个可交互的房贷月供计算器，输入贷款金额、年利率和年限，实时计算月供、总利息，并保存我输入的参数。', tag: '实用工具' },
  { title: '每日习惯记录', prompt: '生成一个每日习惯记录器，可以新增习惯、为今天打卡、取消打卡，显示今日完成率，并保存我的习惯和打卡记录。', tag: '生活效率' }
] as const;
