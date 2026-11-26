import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { getExampleHtml } from '../shared/examples';
import { validateGeneratedHtml } from '../shared/validation';
import { buildPreviewDocument, buildExportDocument } from '../shared/preview';
import { EXAMPLE_PROMPTS } from '../shared/types';

for (const example of EXAMPLE_PROMPTS) {
  test(`${example.title}包含交互与持久化协议`, () => {
    const result = validateGeneratedHtml(getExampleHtml(example.prompt));
    assert.ok(result.html.includes('atoms.loadState'));
    assert.ok(result.html.includes('atoms.saveState'));
    assert.ok(load(result.html)('button').length > 0);
  });
}

test('拒绝截断HTML和外部脚本', () => {
  assert.throws(() => validateGeneratedHtml('<html><head></head><body>test'));
  assert.throws(() => validateGeneratedHtml('<html><head><script src="https://bad.test/a.js"></script></head><body><button>x</button></body></html>'));
});

test('拒绝语法错误和未接入状态协议的产物', () => {
  assert.throws(() => validateGeneratedHtml('<html><head></head><body><button>x</button><script>const = ;</script></body></html>'));
  assert.throws(() => validateGeneratedHtml('<html><head></head><body><button>x</button><script>const x = 1;</script></body></html>'));
});

test('预览策略在所有生成代码之前生效，通信不包含凭据', () => {
  const html = validateGeneratedHtml(getExampleHtml(EXAMPLE_PROMPTS[0].prompt)).html;
  const doc = buildPreviewDocument(html, 'preview-instance', 'https://host.test');
  const $ = load(doc);
  assert.equal($('head').children().first().attr('http-equiv'), 'Content-Security-Policy');
  assert.ok(doc.indexOf("Object.defineProperty(window, 'atoms'") < doc.indexOf('let state ='));
  assert.ok(doc.includes('event.source !== window.parent'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(!doc.includes('MANUS_API_KEY'));
});

test('导出嵌入状态不会关闭SDK脚本，不携带宿主通信和Key', () => {
  const html = validateGeneratedHtml(getExampleHtml(EXAMPLE_PROMPTS[0].prompt)).html;
  const doc = buildExportDocument(html, {name:'</script><script>bad()</script>'}, '看板');
  const $ = load(doc);
  assert.equal($('script').length, 2);
  assert.ok(doc.includes('\\u003c/script>'));
  assert.ok(!doc.includes('window.parent.postMessage'));
  assert.ok(!doc.includes('MANUS_API_KEY'));
});


test('独立导出使用项目标识隔离存储，不依赖尚未解析的标题', async () => {
  const { runInNewContext } = await import('node:vm');
  const storage = new Map<string, string>();
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) };
  const create = (id: string, initial: Record<string, unknown>) => {
    const html = '<!doctype html><html><head><title>相同标题</title></head><body></body></html>';
    const sdk = load(buildExportDocument(html, initial, id))('head script').first().html()!;
    const window: { atoms?: { loadState(): Promise<Record<string, unknown>>; saveState(data: Record<string, unknown>): Promise<unknown> } } = {};
    runInNewContext(sdk, { window, document: { title: '' }, localStorage });
    return window.atoms!;
  };
  const first = create('project-a', { value: 'A' });
  await first.saveState({ value: 'saved-A' });
  const second = create('project-b', { value: 'B' });
  assert.equal((await second.loadState()).value, 'B');
  await second.saveState({ value: 'saved-B' });
  assert.equal((await first.loadState()).value, 'saved-A');
  assert.deepEqual([...storage.keys()], ['atoms-export:project-a', 'atoms-export:project-b']);
});
