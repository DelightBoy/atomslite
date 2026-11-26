const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function injectIntoHead(html: string, injection: string) {
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('网页缺少 head，无法建立安全运行环境');
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + injection);
}

function inlineScript(source: string) {
  return '<script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>';
}

export function buildPreviewDocument(html: string, channel: string, hostOrigin: string): string {
  const sdk = `(() => {
    const channel = ${JSON.stringify(channel)};
    const hostOrigin = ${JSON.stringify(hostOrigin)};
    let sequence = 0;
    const pending = new Map();
    function request(operation, data) {
      return new Promise((resolve, reject) => {
        const id = channel + ':' + (++sequence);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('保存服务未响应，请在工作台检查连接')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        window.parent.postMessage({ type: 'atoms:request', channel, id, operation, data }, hostOrigin);
      });
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      const message = event.data;
      if (!message || message.type !== 'atoms:response' || message.channel !== channel || typeof message.id !== 'string') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : '保存失败'));
    });
    let saveQueue = Promise.resolve();
    Object.defineProperty(window, 'atoms', { configurable: false, writable: false, value: Object.freeze({
      loadState: async () => (await request('load')).data,
      saveState: (data) => {
        const copied = JSON.parse(JSON.stringify(data));
        const task = saveQueue.then(() => request('save', copied));
        saveQueue = task.catch(() => {});
        return task.then(result => result.data);
      }
    }) });
    const report = (error) => window.parent.postMessage({type:'atoms:runtime-error',channel,error:String(error).slice(0,300)}, hostOrigin);
    window.addEventListener('error', event => report(event.message || '预览发生错误'));
    window.addEventListener('unhandledrejection', event => report(event.reason && event.reason.message || event.reason || '应用操作未完成'));
    window.addEventListener('DOMContentLoaded', () => window.parent.postMessage({type:'atoms:ready',channel}, hostOrigin), {once:true});
  })();`;
  return injectIntoHead(html, `<meta http-equiv="Content-Security-Policy" content="${CSP}">` + inlineScript(sdk));
}

export function buildExportDocument(html: string, state: Record<string, unknown>, exportId: string): string {
  // Escape less-than signs so user-controlled state cannot close the trusted script.
  const serialized = JSON.stringify(state).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const storageKey = JSON.stringify('atoms-export:' + exportId).replace(/</g, '\\u003c');
  const sdk = `(() => {
    const initial = ${serialized};
    const key = ${storageKey};
    let memory = initial;
    Object.defineProperty(window,'atoms',{configurable:false,writable:false,value:Object.freeze({
      loadState: async () => { try { const value=localStorage.getItem(key); return value ? JSON.parse(value) : memory; } catch { return memory; } },
      saveState: async (data) => { const next=JSON.parse(JSON.stringify(data)); try { localStorage.setItem(key,JSON.stringify(next)); memory=next; return next; } catch { memory=next; throw new Error('浏览器本地存储不可用：本次变更未持久保存'); } }
    })});
  })();`;
  return injectIntoHead(html, `<meta http-equiv="Content-Security-Policy" content="${CSP}">` + inlineScript(sdk));
}
