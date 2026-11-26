import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight,
  CircleAlert, Code2, Command, FolderClock, Leaf, LoaderCircle, Monitor,
  PanelLeftClose, Play, Plus, RefreshCw, Send, ShieldCheck, Smartphone, Sparkles,
} from 'lucide-react';
import { EXAMPLE_PROMPTS } from '../../shared/types';
import type { GenerationMode, GenerationRun, ProjectDetail, ProjectSummary, SessionInfo, StartGeneration } from '../../shared/types';
import { api, connectSession, errorMessage, generationOutcomeUnknown } from './api';
import type { AppConfig } from './api';
import PreviewFrame from './PreviewFrame';
import type { SyncStatus } from './PreviewFrame';

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted']);
const STAGES: Record<string, string> = {
  planning: '理解需求', generating: '生成应用', validating: '检查代码', saving: '保存项目',
  succeeded: '生成完成', failed: '生成失败', interrupted: '生成中断',
};
const SYNC_LABELS: Record<SyncStatus, string> = {
  loading: '读取已存数据', ready: '数据已同步', saving: '正在保存', saved: '已保存', unsynced: '未同步',
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function updateProjectUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('project', id);
  else url.searchParams.delete('project');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function AppMark({ small = false }: { small?: boolean }) {
  return <span className={`app-mark ${small ? 'app-mark--small' : ''}`} aria-hidden="true"><span /><span /><span /></span>;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [run, setRun] = useState<GenerationRun | null>(null);
  const [runMode, setRunMode] = useState<GenerationMode>('ai');
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [taskError, setTaskError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [failedStart, setFailedStart] = useState<StartGeneration | null>(null);
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [mobilePanel, setMobilePanel] = useState<'demand' | 'preview'>('demand');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sync, setSync] = useState<SyncStatus>('loading');
  const [syncDetail, setSyncDetail] = useState<string | undefined>();
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const requestBusy = useRef(false);
  const restoreSequence = useRef(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventEnd = useRef<HTMLDivElement>(null);
  const busy = submitting || Boolean(activeRunId);
  const hasPreview = Boolean(project?.html && project.artifactId);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setConnecting(true);
    setConnectionError(null);
    (async () => {
      try {
        const visitor = await connectSession();
        if (!alive) return;
        setSession(visitor);
        const [settings, history] = await Promise.all([api.config(controller.signal), api.projects(controller.signal)]);
        if (!alive) return;
        setConfig(settings);
        setProjects(history);
        setHistoryError(null);
        const selectedId = new URL(window.location.href).searchParams.get('project');
        if (selectedId) {
          try {
            const detail = await api.project(selectedId, controller.signal);
            if (!alive) return;
            setProject(detail);
            setPrompt(detail.activeRun?.prompt ?? detail.prompt);
            setRunMode(detail.activeRun?.mode ?? detail.mode);
            setSubmittedPrompt(detail.activeRun?.prompt ?? '');
            setActiveRunId(detail.activeRun?.id ?? null);
            setMobilePanel(detail.html ? 'preview' : 'demand');
          } catch (error) {
            if (alive) setTaskError(`上次应用暂时无法恢复：${errorMessage(error)}`);
          }
        }
      } catch (error) {
        if (alive) setConnectionError(errorMessage(error));
      } finally {
        if (alive) setConnecting(false);
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [connectionAttempt]);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setProjects(await api.projects()); setHistoryError(null); }
    catch (error) { setHistoryError(errorMessage(error)); }
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      let complete = false;
      try {
        const result = await api.run(activeRunId, controller.signal);
        if (disposed) return;
        setRun(result);
        setPollError(null);
        if (TERMINAL.has(result.status)) {
          if (result.status === 'succeeded') {
            // Keep the previous preview until the durable artifact is available.
            const detail = await api.project(result.projectId, controller.signal);
            if (disposed) return;
            if (!detail.html || !detail.artifactId) throw new Error('生成已结束，但应用文件暂不可用。正在重新读取…');
            setProject(detail);
            updateProjectUrl(detail.id);
            setView('preview');
            setRuntimeError(null);
            setSync('loading');
            setProjects(previous => [detail, ...previous.filter(item => item.id !== detail.id)]);
            void refreshHistory();
            setMobilePanel('preview');
          } else {
            setTaskError(result.error || (result.status === 'interrupted' ? '本次生成已中断。已有项目和预览保持不变，可以重新生成。' : '本次生成失败。已有项目和预览保持不变，可以重新生成。'));
          }
          complete = true;
          setActiveRunId(null);
        }
      } catch (error) {
        if (!disposed) setPollError(errorMessage(error));
      } finally {
        if (!disposed && !complete) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [activeRunId, refreshHistory]);

  useEffect(() => { eventEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [run?.events.length]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const generate = async (mode: GenerationMode, retry?: StartGeneration) => {
    if (requestBusy.current || busy || restoringId || !session || connecting || connectionError) return;
    const text = retry?.prompt ?? prompt.trim();
    if (!text) { promptRef.current?.focus(); return; }
    if (mode === 'ai' && !config?.aiConfigured) return;
    requestBusy.current = true;
    setSubmitting(true);
    setTaskError(null);
    setPollError(null);
    const body: StartGeneration = retry ?? {
      prompt: text, mode, requestId: crypto.randomUUID(), ...(project ? { projectId: project.id } : {}),
    };
    setRunMode(body.mode);
    setSubmittedPrompt(body.prompt);
    try {
      const accepted = await api.generate(body);
      setRun(null);
      setFailedStart(null);
      setActiveRunId(accepted.runId);
      updateProjectUrl(accepted.projectId);
      void refreshHistory();
    } catch (error) {
      setTaskError(errorMessage(error));
      // Only uncertain acceptance must preserve the exact request ID. A known
      // rejection (e.g. quota) leaves the prompt available for example fallback.
      setFailedStart(generationOutcomeUnknown(error) ? body : null);
    } finally {
      requestBusy.current = false;
      setSubmitting(false);
    }
  };

  const restore = async (id: string) => {
    if (busy || requestBusy.current) return;
    const sequence = ++restoreSequence.current;
    setRestoringId(id);
    setTaskError(null);
    try {
      const detail = await api.project(id);
      if (sequence !== restoreSequence.current) return;
      setProject(detail);
      updateProjectUrl(detail.id);
      setPrompt(detail.activeRun?.prompt ?? detail.prompt);
      setRun(null);
      setFailedStart(null);
      setRunMode(detail.activeRun?.mode ?? detail.mode);
      setSubmittedPrompt(detail.activeRun?.prompt ?? '');
      setActiveRunId(detail.activeRun?.id ?? null);
      setView('preview');
      setSync('loading');
      setRuntimeError(null);
      setHistoryOpen(false);
      setMobilePanel(detail.html ? 'preview' : 'demand');
    } catch (error) {
      if (sequence === restoreSequence.current) setTaskError(errorMessage(error));
    } finally {
      if (sequence === restoreSequence.current) setRestoringId(null);
    }
  };

  const newProject = () => {
    if (busy || restoringId || requestBusy.current) return;
    ++restoreSequence.current;
    updateProjectUrl(null);
    setProject(null); setPrompt(''); setRun(null); setFailedStart(null);
    setTaskError(null); setPollError(null); setRuntimeError(null); setSubmittedPrompt('');
    setMobilePanel('demand'); setHistoryOpen(false); setView('preview');
    promptRef.current?.focus();
  };

  const exportHtml = async () => {
    if (!project || exporting) return;
    setExporting(true);
    try {
      const html = await api.exportHtml(project.id);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${project.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80) || 'atoms-app'}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setTaskError(errorMessage(error)); }
    finally { setExporting(false); }
  };

  const copyCode = async () => {
    if (!project?.html) return;
    try {
      await navigator.clipboard.writeText(project.html);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setTaskError('无法访问剪贴板。你可以在代码面板中全选并复制。'); }
  };

  const onSyncChange = useCallback((status: SyncStatus, detail?: string) => { setSync(status); setSyncDetail(detail); }, []);
  const formDisabled = connecting || !session || Boolean(connectionError) || busy || Boolean(restoringId);
  const aiDisabled = formDisabled || !prompt.trim() || !config?.aiConfigured || Boolean(failedStart);

  return (
    <div className="app-shell">
      {historyOpen && <button className="sidebar-backdrop" aria-label="关闭项目历史" onClick={() => setHistoryOpen(false)} />}
      <aside className={`sidebar ${historyOpen ? 'sidebar--open' : ''}`} aria-label="项目导航">
        <a className="brand" href="/" aria-label="Atoms Lite 首页"><AppMark small /><span>atoms<span className="brand-lite">lite</span></span></a>
        <button className="new-project" onClick={newProject} disabled={busy || Boolean(restoringId)}><Plus size={17} />新建应用<span className="new-project-shortcut">↗</span></button>
        <div className="history-heading"><span>我的项目</span><button className="icon-button" aria-label="刷新项目列表" title="刷新项目列表" disabled={!session || historyLoading} onClick={() => void refreshHistory()}><RefreshCw size={14} className={historyLoading ? 'spin' : ''} /></button></div>
        <nav className="history-list" aria-label="历史项目">
          {connecting && <p className="history-empty">正在连接工作区…</p>}
          {!connecting && projects.length === 0 && <div className="history-empty"><FolderClock size={23} /><p>想法从这里开始</p><span>生成的应用会保存在这里，<br />下次回来可以继续使用。</span></div>}
          {projects.map(item => <button key={item.id} className={`history-item ${project?.id === item.id ? 'history-item--active' : ''}`} disabled={busy || Boolean(restoringId)} onClick={() => void restore(item.id)} aria-current={project?.id === item.id ? 'page' : undefined}>
            <span className="history-icon">{restoringId === item.id ? <LoaderCircle size={16} className="spin" /> : <Code2 size={16} />}</span>
            <span className="history-item-text"><strong>{item.title}</strong><span>{item.mode === 'example' ? '示例项目' : 'AI 生成'} · {formatTime(item.updatedAt)}</span></span><ChevronRight size={13} />
          </button>)}
        </nav>
        {historyError && <div className="history-error" role="alert">{historyError}<button onClick={() => void refreshHistory()}>重试读取</button></div>}
        <div className="sidebar-footer"><span className="visitor-avatar">访</span><div><strong>访客工作区</strong><span>无需注册 · 此浏览器专属</span></div><ShieldCheck size={16} /></div>
      </aside>

      <main className="main-shell">
        <header className="workspace-header">
          <div className="workspace-breadcrumb"><button className="icon-button mobile-history-button" aria-label="打开项目历史" onClick={() => setHistoryOpen(true)}><PanelLeftClose size={19} /></button><span className="breadcrumb-home">工作区</span><ChevronRight size={14} /><h1>{project?.title || '把想法变成应用'}</h1></div>
          <div className="header-meta"><span className={`connection-dot ${connecting || connectionError ? 'connection-dot--off' : ''}`} /><span>{connecting ? '正在连接' : connectionError ? '连接异常' : '工作区已连接'}</span><span className="mvp-badge">MVP</span></div>
        </header>
        <div className="mobile-panel-tabs" role="tablist" aria-label="工作台区域"><button role="tab" aria-selected={mobilePanel === 'demand'} onClick={() => setMobilePanel('demand')}><Command size={16} />需求与进度{busy && <span className="tab-busy-dot" />}</button><button role="tab" aria-selected={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}><Monitor size={16} />应用预览</button></div>

        <div className="workspace-grid">
          <section className={`demand-panel ${mobilePanel === 'demand' ? 'panel--mobile-visible' : ''}`} aria-label="需求与执行">
            <div className="demand-scroll">
              <div className="panel-eyebrow"><span className="eyebrow-dot" />YOUR NEXT IDEA</div>
              <h2 className="demand-title">一句话，<br />让想法开始运行<span>。</span></h2>
              <p className="demand-description">描述你需要的小工具。生成、交互、保存，<br className="desktop-break" />都在同一个工作台里完成。</p>

              <form className="prompt-form" onSubmit={event => { event.preventDefault(); if (!aiDisabled) void generate('ai'); }}>
                <label className="prompt-label" htmlFor="app-prompt">你想做一个什么应用？</label>
                <div className={`prompt-box ${busy ? 'prompt-box--working' : ''}`}><textarea ref={promptRef} id="app-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：做一个可以新增任务、设置优先级并自动保存的待办看板…" maxLength={4000} rows={5} aria-describedby="prompt-help" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!aiDisabled) void generate('ai'); } }} /><div className="prompt-box-footer"><span><Command size={12} /> Enter 生成</span><span>{prompt.length.toLocaleString()} / 4,000</span></div></div>
                <p id="prompt-help" className="input-help">说清功能和交互，结果会更贴近你的想法。</p>
                <button className="generate-button" type="submit" disabled={aiDisabled}>{busy && runMode === 'ai' ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}<span>{busy && runMode === 'ai' ? '正在生成应用' : project ? '用 AI 更新应用' : '用 AI 生成应用'}</span>{!busy && <ArrowRight size={17} />}</button>
                <div className="generation-footnote"><span>真实 AI 生成 · 按需调用</span><span>每日上限 {config?.dailyLimit ?? session?.dailyLimit ?? '—'} 次</span></div>
                {config && !config.aiConfigured && <p className="config-notice"><CircleAlert size={14} />AI 服务尚未配置。你仍可体验明确标记的示例模式。</p>}
                <button className="example-button" type="button" disabled={formDisabled || !prompt.trim() || Boolean(failedStart)} onClick={() => void generate('example')}><Play size={14} /><span>{busy && runMode === 'example' ? '正在加载示例' : '使用示例模式'}</span><span className="example-button-tag">不调用 AI</span></button>
              </form>

              {connectionError && <div className="error-notice" role="alert"><CircleAlert size={17} /><div><strong>暂时无法连接工作区</strong><p>{connectionError}</p><button className="text-button" onClick={() => setConnectionAttempt(value => value + 1)}>重新连接 <RefreshCw size={12} /></button></div></div>}
              {taskError && <div className="error-notice" role="alert"><CircleAlert size={17} /><div><strong>这一步没有完成</strong><p>{taskError}</p>{failedStart && <><p className="retry-note">重试将复用原请求，不会重复创建同一次生成。</p><button className="text-button" disabled={formDisabled} onClick={() => void generate(failedStart.mode, failedStart)}>重试这次请求 <RefreshCw size={12} /></button></>}</div></div>}

              {!run && !busy && !submittedPrompt && <section className="examples-section" aria-label="示例需求"><div className="section-heading"><h3>没想好？从一个小想法开始</h3><span>03 IDEAS</span></div>{EXAMPLE_PROMPTS.map((example, index) => <button className="example-card" key={example.title} disabled={formDisabled} onClick={() => { setPrompt(example.prompt); promptRef.current?.focus(); }}><span className="example-number">0{index + 1}</span><span><strong>{example.title}</strong><span>{example.tag} · 可交互 · 可保存</span></span><ArrowRight size={15} /></button>)}<p className="example-disclosure">选择需求后，可用真实 AI 生成，或明确进入示例模式。</p></section>}

              {(run || busy || submittedPrompt) && <section className="execution-section" aria-label="后端执行记录"><div className="section-heading"><h3>执行记录</h3><span className={runMode === 'example' ? 'mode-tag mode-tag--example' : 'mode-tag'}>{runMode === 'example' ? '示例模式 · 非 AI' : '真实 AI'}</span></div><div className="submitted-prompt"><Send size={13} /><p>{submittedPrompt || prompt}</p></div><div className="execution-status" role="status">{busy ? <LoaderCircle size={16} className="spin" /> : run?.status === 'succeeded' ? <CheckCheck size={16} /> : <CircleAlert size={16} />}<span>{submitting ? '正在提交请求…' : run ? STAGES[run.status] || run.status : '等待后端执行记录'}</span>{run?.model && <span className="model-label">{run.model}</span>}</div>{run?.events.length ? <ol className="event-list">{run.events.map((event, index) => <li key={`${event.at}-${index}`}><span className="event-dot" /><div><span className="event-stage">{STAGES[event.stage] || event.stage}</span><p>{event.message}</p></div><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol> : <p className="events-empty">只展示后端实际返回的进度，不模拟生成步骤。</p>}{pollError && <p className="poll-error" role="alert">{pollError} 正在每 1.5 秒重新读取；不会重复提交生成。</p>}<div ref={eventEnd} /></section>}
            </div>
            <div className="demand-bottom"><ShieldCheck size={14} /><span>应用在隔离环境运行，业务数据保存到数据库。</span></div>
          </section>

          <section className={`output-panel ${mobilePanel === 'preview' ? 'panel--mobile-visible' : ''}`} aria-label="应用与代码">
            <div className="output-toolbar"><div className="view-tabs" role="tablist" aria-label="输出视图"><button role="tab" aria-selected={view === 'preview'} className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}><Monitor size={15} />预览</button><button role="tab" aria-selected={view === 'code'} className={view === 'code' ? 'active' : ''} onClick={() => setView('code')} disabled={!hasPreview}><Code2 size={15} />代码<span className="read-only-badge">只读</span></button></div><div className="output-actions"><div className="device-toggle" aria-label="预览宽度"><button className={device === 'desktop' ? 'active' : ''} aria-label="桌面宽度" title="桌面宽度" aria-pressed={device === 'desktop'} disabled={view === 'code'} onClick={() => setDevice('desktop')}><Monitor size={16} /></button><button className={device === 'mobile' ? 'active' : ''} aria-label="手机宽度" title="手机宽度" aria-pressed={device === 'mobile'} disabled={view === 'code'} onClick={() => setDevice('mobile')}><Smartphone size={16} /></button></div><span className="toolbar-divider" /><button className="export-button" disabled={!hasPreview || exporting} onClick={() => void exportHtml()}>{exporting ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}<span>导出 HTML</span></button></div></div>
            <div className="preview-addressbar"><div className="browser-dots" aria-hidden="true"><i /><i /><i /></div><div className="preview-address"><ShieldCheck size={12} /><span>{hasPreview ? `${project!.mode === 'example' ? 'example' : 'app'} / ${project!.title}` : '你的应用将在这里运行'}</span></div>{hasPreview && <button className="icon-button" aria-label="刷新预览并重新读取已保存的数据" title="刷新预览并重新读取已保存的数据" onClick={() => setPreviewRevision(value => value + 1)}><RefreshCw size={13} /></button>}</div>

            {!hasPreview ? <div className="preview-empty"><div className="preview-empty-icon"><AppMark /></div><span className="preview-empty-kicker">A LITTLE IDEA. A REAL APP.</span><h2>想法的下一站，是这里。</h2><p>在左侧描述你的需求，<br />生成后即可点击、输入，真正使用你的应用。</p><div className="empty-flow"><span><Sparkles size={14} />自然语言</span><ChevronRight size={13} /><span><Code2 size={14} />生成代码</span><ChevronRight size={13} /><span><Play size={13} />交互预览</span></div><button className="mobile-start-button" onClick={() => setMobilePanel('demand')}><ArrowLeft size={14} />去描述我的想法</button><div className="preview-empty-footer"><Leaf size={14} /><span>保持轻量。先解决一个真实的小问题。</span></div></div> : <>
              {project!.mode === 'example' && <div className="example-preview-banner"><Play size={12} /><strong>示例模式</strong><span>此应用为预置示例，不是 AI 生成结果。</span></div>}
              {runtimeError && <div className="preview-alert" role="alert"><CircleAlert size={14} /><span>应用运行异常：{runtimeError}</span></div>}
              {sync === 'unsynced' && <div className="preview-alert" role="alert"><CircleAlert size={14} /><span>数据未同步：{syncDetail || '保存尚未完成。'}</span><button onClick={() => setPreviewRevision(value => value + 1)}>读取已存数据</button></div>}
              <div className={`preview-container ${view === 'code' ? 'preview-container--hidden' : ''}`} aria-hidden={view !== 'preview'}><PreviewFrame key={`${project!.artifactId}:${previewRevision}`} artifactId={project!.artifactId!} html={project!.html!} title={project!.title} width={device} onSyncChange={onSyncChange} onRuntimeError={setRuntimeError} /></div>
              {view === 'code' && <div className="code-view"><div className="code-heading"><span><Code2 size={14} />index.html <span>只读 · {project!.html!.split('\n').length} 行</span></span><button onClick={() => void copyCode()}>{copied ? <Check size={13} /> : <Code2 size={13} />}{copied ? '已复制' : '复制代码'}</button></div><pre tabIndex={0} aria-label="生成的 HTML 源代码，只读"><code>{project!.html}</code></pre><p className="code-export-note">导出 HTML 可在本地查看；工作区业务数据需通过本工作区的保存接口同步。</p></div>}
            </>}
            <footer className="output-footer"><span><ShieldCheck size={12} />隔离预览 · 无宿主权限</span>{hasPreview ? <span className={`sync-status sync-status--${sync}`} title={syncDetail}>{sync === 'saving' || sync === 'loading' ? <LoaderCircle size={12} className="spin" /> : sync === 'unsynced' ? <CircleAlert size={12} /> : <Check size={12} />}{SYNC_LABELS[sync]}</span> : <span>准备就绪，等待你的想法</span>}</footer>
          </section>
        </div>
      </main>
    </div>
  );
}
