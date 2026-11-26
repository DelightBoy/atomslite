import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertState, HttpError } from '../server/errors';
import { poolOptions, tokenHash } from '../server/db';
import { normalizeCatalog, complete, ProviderError } from '../server/provider';
import { selectModel, tokenCap, type ModelInfo } from '../server/model-selection';

const model = (id: string, input: number, output: number, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, description: 'coding assistant', capabilities: ['coding'], pricing: { input, output }, available: true, deprecated: false, ...extra });

test('visitor credentials are hashed, never stored as plaintext', () => {
  const hash = tokenHash('private-test-token');
  assert.equal(hash.length, 64); assert.notEqual(hash, 'private-test-token');
  assert.equal(hash, tokenHash('private-test-token'));
});

test('state must be an object and UTF-8 serialized data is limited to 100KB', () => {
  assertState({ tasks: [], unicode: '中文' });
  for (const invalid of [null, [], 'text', 1]) assert.throws(() => assertState(invalid), HttpError);
  assert.throws(() => assertState({ text: '中'.repeat(40000) }), (error: unknown) => error instanceof HttpError && error.status === 413);
});

test('MySQL DSN respects explicit TLS parameters and decodes credentials', () => {
  const options = poolOptions('mysql://visitor:p%40ss@db.example:3307/atoms?ssl=true');
  assert.equal(options.password, 'p@ss'); assert.equal(options.port, 3307);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true }); assert.equal(options.multipleStatements, false);
  assert.deepEqual(poolOptions('mysql://a:b@localhost/db?sslmode=require&rejectUnauthorized=false').ssl, { rejectUnauthorized: false });
  assert.equal(poolOptions('mysql://a:b@localhost/db?sslmode=disable').ssl, undefined);
  assert.throws(() => poolOptions('postgres://a:b@localhost/db'));
});

test('live model selection excludes retired models and selects known cheapest coding cost', () => {
  const selected = selectModel([model('catalog-expensive', 2, 8), model('catalog-cheap', 0.1, 0.2), model('catalog-retired', 0, 0, { deprecated: true }), model('catalog-disabled', 0, 0, { available: false })], null);
  assert.equal(selected.id, 'catalog-cheap');
  assert.equal(selectModel([model('one', 1, 2), model('two', 2, 3)], 'two').id, 'two');
  assert.throws(() => selectModel([model('one', 1, 2)], 'missing'));
});

test('model catalog is sanitized and pricing can be numeric strings', () => {
  const catalog = normalizeCatalog({ data: [{ id: 'live-coder', description: 'Coding', capabilities: ['coding'], pricing: { input: '0.1', output: '0.2' }, api_key: 'never-expose' }, { id: 'retired', deprecated: true }] });
  assert.equal(catalog[0].pricing?.input, 0.1);
  assert.equal(catalog[1].deprecated, true);
  assert.equal(JSON.stringify(catalog).includes('never-expose'), false);
});

test('output caps use family-appropriate parameter without guessed model IDs', () => {
  assert.deepEqual(tokenCap('gemini-current-catalog'), { max_tokens: 3500 });
  assert.deepEqual(tokenCap('gpt-current-catalog'), { max_completion_tokens: 3500 });
  assert.deepEqual(tokenCap('provider/gpt-5-test'), { max_completion_tokens: 3500 });
});

test('provider uses explicit model, strips fences, records usage, and rejects body.error', async () => {
  const oldFetch = globalThis.fetch; const oldUrl = process.env.MANUS_API_URL; const oldKey = process.env.MANUS_API_KEY;
  process.env.MANUS_API_URL = 'https://provider.example/v1'; process.env.MANUS_API_KEY = 'unit-test-not-a-real-key';
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://provider.example/v1/chat/completions');
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'catalog-coder'); assert.equal(body.max_tokens, 3500); assert.equal(body.response_format, undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: '```html\n<!doctype html><html></html>\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200 });
    };
    const response = await complete('catalog-coder', 'Build a useful tool', new AbortController().signal);
    assert.equal(response.html, '<!doctype html><html></html>'); assert.equal(response.usage.totalTokens, 30);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'raw provider secret' } }), { status: 200 });
    await assert.rejects(complete('catalog-coder', 'test', new AbortController().signal), (error: unknown) => error instanceof ProviderError && !error.message.includes('secret'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.MANUS_API_URL; else process.env.MANUS_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.MANUS_API_KEY; else process.env.MANUS_API_KEY = oldKey;
  }
});

test('unknown pricing requires a reviewed preference and per-million units normalize', () => {
  const unknown = model('live-unknown', 1, 2, { pricing: null });
  assert.throws(() => selectModel([unknown], null), /pricing/);
  assert.equal(selectModel([unknown], 'live-unknown').id, 'live-unknown');
  const perMillion = model('live-per-million', 1, 2, { pricing: { input_per_million: 0.1, output_per_million: 0.2 } });
  assert.equal(selectModel([model('live-per-token', 0.000002, 0.000008), perMillion], null).id, 'live-per-million');
  const capabilities = normalizeCatalog({ data: [{ id: 'live-coder', capabilities: { coding: true, image_generation: false }, pricing: { input: 1, output: 2 } }] });
  assert.deepEqual(capabilities[0].capabilities, ['coding']);
});

test('TLS strict flags enable encryption and contradictory parameters fail closed', () => {
  assert.deepEqual(poolOptions('mysql://a:b@localhost/db?sslaccept=strict').ssl, { rejectUnauthorized: true });
  assert.throws(() => poolOptions('mysql://a:b@localhost/db?sslmode=disable&ssl=true'));
  assert.equal(poolOptions('mysql://a:b@[::1]:3306/db').host, '::1');
});

test('delivered migration and runtime migration are equivalent and additive', async () => {
  const { readFile } = await import('node:fs/promises');
  const { migrations } = await import('../server/migrations');
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const sql = await readFile(new URL('../drizzle/0000_atoms.sql', import.meta.url), 'utf8');
  const delivered = sql.replace(/^--.*$/gm, '').split(';').map(normalize).filter(Boolean);
  assert.deepEqual(delivered, migrations.map(normalize));
  assert.equal(delivered.length, 6);
  assert.equal(delivered.every(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS atoms_')), true);
});
