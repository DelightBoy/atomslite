export class HttpError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求必须为 JSON 对象。', 'INVALID_INPUT');
  }
}

export function assertState(value: unknown): asserts value is Record<string, unknown> {
  assertObject(value);
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new HttpError(400, '状态必须为有效 JSON。', 'INVALID_STATE'); }
  if (Buffer.byteLength(text, 'utf8') > 100 * 1024) {
    throw new HttpError(413, '状态不能超过 100KB。', 'STATE_TOO_LARGE');
  }
}

export function positiveInteger(raw: string | undefined, fallback: number, maximum = 100000): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function safeRunError(error: unknown): string {
  return error instanceof HttpError ? error.message : '生成暂时失败，请稍后重试；已有版本未被覆盖。';
}
