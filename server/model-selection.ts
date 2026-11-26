// Reviewed in the project catalog on 2026-11-26: fast, low-cost text generation.
// The runtime still requires this exact ID to be present and available in its live catalog.
export const PREFERRED_MODEL_ID: string | null = 'gemini-3.5-flash-lite';

export interface ModelInfo {
  id: string;
  description: string;
  capabilities: string[];
  pricing: Record<string, number> | null;
  deprecated: boolean;
  available: boolean;
}

function cost(model: ModelInfo): number {
  if (!model.pricing) return Infinity;
  const input = model.pricing.input ?? model.pricing.prompt ?? (model.pricing.input_per_million === undefined ? undefined : model.pricing.input_per_million / 1000000);
  const output = model.pricing.output ?? model.pricing.completion ?? (model.pricing.output_per_million === undefined ? undefined : model.pricing.output_per_million / 1000000);
  if (input === undefined || output === undefined) return Infinity;
  return input + output;
}

export function supportsCoding(model: ModelInfo): boolean {
  const summary = `${model.id} ${model.description} ${model.capabilities.join(' ')}`.toLowerCase();
  if (/embedding|image-generation|text-to-image|speech|transcription|\btts\b/.test(summary)) return false;
  return /cod(e|ing|er|ex)|programming|编程|代码/.test(summary)
    || model.capabilities.some(capability => /^(text|chat|text-generation|chat-completion|reasoning)$/.test(capability.toLowerCase()))
    // General-purpose chat families can write code; the exact ID always comes from the live catalog.
    || /\b(gpt|gemini|claude|deepseek|qwen)\b/.test(summary);
}

export function selectModel(catalog: ModelInfo[], preferred: string | null = PREFERRED_MODEL_ID): ModelInfo {
  const candidates = catalog.filter(model => model.available && !model.deprecated && supportsCoding(model));
  if (preferred) {
    const selected = candidates.find(model => model.id === preferred);
    if (!selected) throw new Error('Preferred model is not available for coding in the live catalog');
    return selected;
  }
  candidates.sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id));
  const selected = candidates[0];
  if (!selected) throw new Error('No available coding model in the live catalog');
  // Never infer a low price from a remembered model ID. An explicitly reviewed preference may bypass missing prices.
  if (!Number.isFinite(cost(selected))) throw new Error('Catalog has no comparable pricing; set PREFERRED_MODEL_ID after reviewing the live catalog');
  return selected;
}

export function tokenCap(modelId: string): Record<string, number> {
  return /(^|[\/:-])(gpt|o[134])([-.\/]|$)/i.test(modelId)
    ? { max_completion_tokens: 3500 }
    : { max_tokens: 3500 };
}
