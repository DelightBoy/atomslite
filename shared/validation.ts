import { load } from 'cheerio';
import { parse } from 'acorn';

export function validateGeneratedHtml(raw: string): {html: string; title: string} {
  const cleaned = raw.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (Buffer.byteLength(cleaned, 'utf8') > 150_000) throw new Error('生成网页过大，请缩小需求范围');
  if (!/<html[\s>]/i.test(cleaned) || !/<head[\s>]/i.test(cleaned) || !/<body[\s>]/i.test(cleaned) || !/<\/html>\s*$/i.test(cleaned)) {
    throw new Error('模型输出的网页不完整，请重试或缩小需求范围');
  }
  const $ = load(cleaned);
  if ($('iframe,object,embed,base').length) throw new Error('生成网页包含不支持的嵌入资源');
  if ($('script[src],link[href]').length) throw new Error('生成网页依赖外部文件，无法独立运行');
  $('meta[http-equiv]').remove();
  $('form').removeAttr('action').removeAttr('target');
  $('[target]').removeAttr('target');
  $('[href]').each((_i, element) => {
    const href = $(element).attr('href') || '';
    if (!href.startsWith('#')) $(element).removeAttr('href');
  });
  $('[src]').each((_i, element) => {
    const src = $(element).attr('src') || '';
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) $(element).removeAttr('src');
  });
  const scripts = $('script').toArray();
  if (!scripts.length) throw new Error('生成网页没有可运行的交互脚本');
  let source = '';
  for (const element of scripts) {
    const code = $(element).html() || '';
    if ($(element).attr('type') && !['text/javascript','application/javascript'].includes($(element).attr('type')!)) {
      throw new Error('生成网页使用了不支持的脚本格式');
    }
    try { parse(code, {ecmaVersion: 'latest', sourceType: 'script'}); }
    catch { throw new Error('生成网页的 JavaScript 语法有误'); }
    source += code;
  }
  if (!source.includes('atoms.loadState') || !source.includes('atoms.saveState')) {
    throw new Error('生成网页没有接入业务数据保存接口');
  }
  if (/\b(?:localStorage|sessionStorage|fetch|XMLHttpRequest|WebSocket|eval)\b|\b(?:parent|top)\s*\./.test(source)) {
    throw new Error('生成网页使用了沙箱之外的能力，请重试');
  }
  if (!$('button,input,select,textarea').length) throw new Error('生成网页缺少可以操作的控件');
  const title = $('title').text().trim().slice(0,80) || '我的应用';
  return {html: $.html(), title};
}
