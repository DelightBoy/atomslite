export interface PreviewRequest {
  type: 'atoms:request';
  channel: string;
  id: string;
  operation: 'load' | 'save';
  data?: unknown;
}

export type PreviewMessage = PreviewRequest
  | { type: 'atoms:ready'; channel: string }
  | { type: 'atoms:runtime-error'; channel: string; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function parsePreviewMessage(value: unknown, channel: string): PreviewMessage | null {
  if (!isRecord(value) || value.channel !== channel) return null;
  if (value.type === 'atoms:ready') {
    return Object.keys(value).every(key => ['type', 'channel'].includes(key))
      ? { type: 'atoms:ready', channel } : null;
  }
  if (value.type === 'atoms:runtime-error') {
    if (!Object.keys(value).every(key => ['type', 'channel', 'error'].includes(key))
      || typeof value.error !== 'string' || !value.error.length || value.error.length > 4000) return null;
    return { type: 'atoms:runtime-error', channel, error: value.error };
  }
  if (value.type !== 'atoms:request'
    || !Object.keys(value).every(key => ['type', 'channel', 'id', 'operation', 'data'].includes(key))
    || typeof value.id !== 'string' || !value.id.length || value.id.length > 128
    || (value.operation !== 'load' && value.operation !== 'save')) return null;
  return { type: 'atoms:request', channel, id: value.id, operation: value.operation, data: value.data };
}

// Structured-clone messages can contain Maps, cycles or other non-JSON values.
// Only JSON objects suitable for the state REST API are accepted.
export function isStateData(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  let entries = 0;
  const visiting = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++entries > 20000 || depth > 32) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || (!Array.isArray(item) && !isRecord(item)) || visiting.has(item)) return false;
    visiting.add(item);
    const valid = Object.values(item).every(child => visit(child, depth + 1));
    visiting.delete(item);
    return valid;
  };
  if (!visit(value, 0)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= 256000;
}
