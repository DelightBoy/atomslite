import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPreviewDocument } from '../../shared/preview';
import type { SavedState } from '../../shared/types';
import { api, ApiRequestError, errorMessage } from './api';
import { isStateData, parsePreviewMessage } from './previewMessages';

export type SyncStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'unsynced';

interface PreviewFrameProps {
  artifactId: string;
  html: string;
  title: string;
  width: 'desktop' | 'mobile';
  onSyncChange: (status: SyncStatus, detail?: string) => void;
  onRuntimeError: (error: string | null) => void;
}

interface FrameDocument { channel: string; srcDoc: string; }
interface StateResponse {
  type: 'atoms:response';
  channel: string;
  id: string;
  ok: boolean;
  data?: SavedState;
  error?: string;
}

export default function PreviewFrame({ artifactId, html, title, width, onSyncChange, onRuntimeError }: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onSyncChange, onRuntimeError });
  const [document, setDocument] = useState<FrameDocument | null>(null);
  const identity = useMemo(() => ({ channel: crypto.randomUUID(), html, artifactId }), [artifactId, html]);

  useEffect(() => { callbacks.current = { onSyncChange, onRuntimeError }; }, [onSyncChange, onRuntimeError]);

  useEffect(() => {
    let disposed = false;
    let knownState: SavedState | null = null;
    let unsynced = false;
    let mustReload = false;
    const controller = new AbortController();
    const { channel } = identity;
    const responses = new Map<string, StateResponse>();
    const pending = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    const report = (status: SyncStatus, detail?: string) => {
      if (!disposed) callbacks.current.onSyncChange(status, detail);
    };
    const respond = (message: StateResponse) => {
      if (disposed) return;
      // Opaque sandbox origin requires '*'. This payload contains only current
      // artifact state/errors: never an auth token, keys or other projects.
      frameRef.current?.contentWindow?.postMessage(message, '*');
    };
    const remember = (message: StateResponse) => {
      responses.set(message.id, message);
      if (responses.size > 128) responses.delete(responses.keys().next().value!);
      respond(message);
    };
    const load = async () => {
      knownState = await api.loadState(identity.artifactId, controller.signal);
      mustReload = false;
      if (!unsynced) report('ready');
      return knownState;
    };

    const listener = (event: MessageEvent<unknown>) => {
      if (disposed || !frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parsePreviewMessage(event.data, channel);
      if (!message) return;
      if (message.type === 'atoms:ready') return;
      if (message.type === 'atoms:runtime-error') {
        callbacks.current.onRuntimeError(message.error);
        return;
      }
      const id = message.id;
      const cached = responses.get(id);
      if (cached) { respond(cached); return; }
      if (pending.has(id)) return;
      const operation = message.operation;
      if ((operation === 'load' && message.data !== undefined) || (operation === 'save' && !isStateData(message.data))) {
        remember({ type: 'atoms:response', channel, id, ok: false, error: '状态格式无效或数据过大，未保存。' });
        if (operation === 'save') { unsynced = true; report('unsynced', '应用发送的状态格式无效，未保存。'); }
        return;
      }
      const data = message.data as Record<string, unknown>;
      pending.add(id);
      queue = queue.then(async () => {
        if (disposed) return;
        try {
          let state: SavedState;
          if (operation === 'load') {
            state = await load();
          } else {
            if (mustReload) throw new ApiRequestError('请先重新读取最新状态，再操作和保存。', 409);
            if (!knownState) await load();
            report('saving');
            state = await api.saveState(identity.artifactId, { data, version: knownState!.version }, controller.signal);
            knownState = state;
            unsynced = false;
          }
          remember({ type: 'atoms:response', channel, id, ok: true, data: state });
          // ACK only follows a successful database API response.
          if (operation === 'save') report('saved');
        } catch (error) {
          if (disposed) return;
          const detail = errorMessage(error);
          if (operation === 'save') {
            unsynced = true;
            if (error instanceof ApiRequestError && error.status === 409) mustReload = true;
          }
          report('unsynced', detail);
          remember({ type: 'atoms:response', channel, id, ok: false, error: detail });
        } finally {
          pending.delete(id);
        }
      });
    };

    // Mount the iframe only after registering its message listener. The listener
    // and channel are replaced whenever artifact/html changes, not on state saves.
    window.addEventListener('message', listener);
    callbacks.current.onRuntimeError(null);
    report('loading');
    queue = queue.then(async () => {
      try { await load(); } catch (error) {
        if (!disposed) report('unsynced', errorMessage(error));
      }
    });
    try {
      setDocument({ channel, srcDoc: buildPreviewDocument(identity.html, channel, window.location.origin) });
    } catch (error) {
      callbacks.current.onRuntimeError(errorMessage(error));
      setDocument(null);
    }
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener('message', listener);
    };
  }, [identity]);

  return (
    <div className={`preview-stage preview-stage--${width}`}>
      {document?.channel === identity.channel ? (
        <iframe
          key={document.channel}
          ref={frameRef}
          title={`${title} · 隔离交互预览`}
          srcDoc={document.srcDoc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="preview-iframe"
        />
      ) : <div className="frame-loading" role="status">正在建立隔离预览…</div>}
    </div>
  );
}
