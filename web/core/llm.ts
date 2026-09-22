// Streaming client for any OpenAI-compatible /chat/completions endpoint
// (OpenRouter, Ollama, llama.cpp, KoboldCpp, LM Studio, vLLM, OpenAI, ...).
import type { Settings, TokenUsage } from '../types.ts';
import type { ChatMessage } from './prompt.ts';

function baseUrl(s: Settings) {
  return s.apiBase.replace(/\/+$/, '');
}

/** fetch() with a friendlier error when the server can't be reached at all. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw err; // the user pressed Stop
    if (err.name === 'TimeoutError') throw new Error(`No response from ${url} within 20 seconds.`);
    throw new Error(
      `Could not reach ${url}. Check the URL, and that the server is running. ` +
        'If it is, it may not allow requests from a browser (CORS) - local servers such as Ollama need that switched on.',
    );
  }
}

/**
 * Turn a failed response into something a person can act on: what the status
 * usually means, followed by whatever the provider itself said.
 */
async function failure(res: Response): Promise<Error> {
  const raw = (await res.text().catch(() => '')).trim();
  let detail = raw;
  try {
    const json = JSON.parse(raw);
    detail = String(json?.error?.message ?? json?.message ?? json?.error?.code ?? raw);
  } catch {
    if (detail.startsWith('<')) detail = ''; // an HTML error page tells nobody anything
  }
  const hint =
    res.status === 401 || res.status === 403
      ? 'the API key was rejected or is missing'
      : res.status === 404
        ? 'not found - check the base URL ends in /v1, and that the model id exists'
        : res.status === 429
          ? 'rate limited, or the account is out of credit'
          : res.status === 413
            ? 'the request was too large - lower the context size'
            : res.status >= 500
              ? 'the provider is having trouble at their end'
              : res.statusText;
  return new Error(
    [`API error ${res.status}`, hint, detail.slice(0, 300)].filter(Boolean).join(' - '),
  );
}

/** JSON body, with a clear message when the endpoint answers with something else. */
async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The provider answered with ${text.trim().startsWith('<') ? 'an HTML page' : 'something that is not JSON'}. ` +
        'Is the base URL an OpenAI-compatible endpoint ending in /v1?',
    );
  }
}

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
  // OpenRouter attribution. Only sent there: an unexpected header can fail
  // another provider's CORS preflight.
  if (/openrouter\.ai/i.test(s.apiBase)) {
    h['HTTP-Referer'] = typeof location === 'undefined' ? 'https://fabled.local' : location.origin;
    h['X-Title'] = 'Fabled';
  }
  return h;
}

/** One piece of a reply: either prose, or the model thinking out loud. */
export interface StreamDelta {
  text: string;
  reasoning?: boolean;
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** True when `tail` could still grow into `tag`, so it must not be emitted yet. */
function isPartialTag(tail: string, tag: string) {
  return tail.length < tag.length && tag.startsWith(tail);
}

/**
 * Some models mark their reasoning with <think> tags inside the normal content
 * instead of a separate field, and the tags can be split across chunks. This
 * keeps the state needed to pull them apart safely.
 */
export function createThinkSplitter() {
  let inThink = false;
  let pending = '';

  const take = (chunk: string, final: boolean): StreamDelta[] => {
    const out: StreamDelta[] = [];
    let rest = pending + chunk;
    pending = '';

    for (;;) {
      const tag = inThink ? CLOSE : OPEN;
      const at = rest.indexOf(tag);
      if (at !== -1) {
        const before = rest.slice(0, at);
        if (before) out.push(inThink ? { text: before, reasoning: true } : { text: before });
        rest = rest.slice(at + tag.length);
        inThink = !inThink;
        continue;
      }

      // Hold back a tail that might be the start of a tag arriving in pieces.
      if (!final) {
        for (let keep = Math.min(rest.length, tag.length - 1); keep > 0; keep--) {
          if (isPartialTag(rest.slice(rest.length - keep), tag)) {
            pending = rest.slice(rest.length - keep);
            rest = rest.slice(0, rest.length - keep);
            break;
          }
        }
      }
      if (rest) out.push(inThink ? { text: rest, reasoning: true } : { text: rest });
      return out;
    }
  };

  return {
    push: (chunk: string) => take(chunk, false),
    /** Emit whatever was being held back at the end of the stream. */
    flush: () => take('', true),
  };
}

/** Facts about the response that only the stream knows; filled in as it is read. */
export interface StreamReport {
  modelReported?: string;
  finishReason?: string;
  usage?: TokenUsage;
  /** True when the provider rejected the optional fields and we resent without them. */
  extrasDropped?: boolean;
}

/** Providers disagree on where reasoning goes; take whichever field is present. */
function reasoningOf(delta: any): string {
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = delta?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

const EFFORTS = ['low', 'medium', 'high'];

/** Yields prose and reasoning as they arrive. Throws on HTTP/API errors. */
export async function* streamChat(
  settings: Settings,
  messages: ChatMessage[],
  signal: AbortSignal,
  report: StreamReport = {},
): AsyncGenerator<StreamDelta> {
  const url = `${baseUrl(settings)}/chat/completions`;

  // Fields beyond the bare minimum. Most servers ignore what they don't know;
  // the few that reject unknown fields with a 400 get one plain retry below.
  const extras = () => {
    const effort = EFFORTS.includes(settings.thinkingLevel) ? settings.thinkingLevel : null;
    return {
      stream_options: { include_usage: true }, // real token counts in a final chunk
      // Two spellings of the same request: OpenAI-style and OpenRouter-style.
      ...(effort ? { reasoning_effort: effort, reasoning: { effort } } : {}),
    };
  };

  const body = (withExtras: boolean) =>
    JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      ...(withExtras ? extras() : {}),
    });

  const send = (withExtras: boolean) =>
    request(url, { method: 'POST', headers: headers(settings), signal, body: body(withExtras) });

  let res = await send(true);
  if (res.status === 400) {
    await res.body?.cancel().catch(() => {});
    report.extrasDropped = true;
    res = await send(false);
  }

  if (!res.ok) throw await failure(res);
  if (!res.body) throw new Error('The provider sent no response body.');

  const decoder = new TextDecoder();
  const think = createThinkSplitter();
  let buffer = '';
  // A reader rather than `for await`, which Safari cannot do over a stream.
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        yield* think.flush();
        return;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore keep-alive / partial junk
      }
      if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
      if (typeof json.model === 'string' && json.model) report.modelReported = json.model;
      const choice = json.choices?.[0];
      if (choice?.finish_reason) report.finishReason = choice.finish_reason;
      // Arrives in a final chunk (usually with no choices) when include_usage worked.
      if (json.usage && typeof json.usage === 'object') {
        const u = json.usage;
        report.usage = {
          prompt_tokens: u.prompt_tokens ?? undefined,
          completion_tokens: u.completion_tokens ?? undefined,
          total_tokens: u.total_tokens ?? undefined,
        };
      }
      const reasoning = reasoningOf(choice?.delta);
      if (reasoning) yield { text: reasoning, reasoning: true };
      const content = choice?.delta?.content;
      if (typeof content === 'string' && content) yield* think.push(content);
    }
  }
  yield* think.flush(); // the stream ended without a [DONE] line
}

export interface ConnectionTest {
  model?: string;
  reply: string;
  usage?: TokenUsage;
  finishReason?: string;
}

/**
 * One plain, non-streaming completion. Used for the connection test and for
 * background jobs like folding memory - never for the roleplay itself.
 * Deliberately sends no stream_options and no thinking parameter.
 */
export async function completeChat(
  settings: Settings,
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<ConnectionTest> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000); // never hang forever
  const res = await request(`${baseUrl(settings)}/chat/completions`, {
    method: 'POST',
    headers: headers(settings),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    body: JSON.stringify({
      model: settings.model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      stream: false,
    }),
  });
  if (!res.ok) throw await failure(res);
  const json: any = await readJson(res);
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  const choice = json.choices?.[0];
  return {
    model: typeof json.model === 'string' ? json.model : undefined,
    reply: String(choice?.message?.content ?? '').trim(),
    usage: json.usage,
    finishReason: choice?.finish_reason,
  };
}

/**
 * A completion with one image attached, in the shape every OpenAI-compatible
 * vision model expects. A model without vision rejects this, which is the only
 * dependable way to find out whether it has any.
 */
export async function describeImage(
  settings: Settings,
  imageDataUrl: string,
  instruction: string,
  maxTokens: number,
): Promise<ConnectionTest> {
  const res = await request(`${baseUrl(settings)}/chat/completions`, {
    method: 'POST',
    headers: headers(settings),
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
      stream: false,
    }),
  });
  if (!res.ok) throw await failure(res);
  const json: any = await readJson(res);
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  const choice = json.choices?.[0];
  return {
    model: typeof json.model === 'string' ? json.model : undefined,
    reply: String(choice?.message?.content ?? '').trim(),
    usage: json.usage,
    finishReason: choice?.finish_reason,
  };
}

/** The smallest real request there is: enough to prove URL, key and model work together. */
export function testChat(settings: Settings): Promise<ConnectionTest> {
  return completeChat(settings, [{ role: 'user', content: 'Reply with the single word: ok' }], {
    maxTokens: 4,
    temperature: 0,
  });
}

export async function listModels(settings: Settings): Promise<string[]> {
  const res = await request(`${baseUrl(settings)}/models`, {
    headers: headers(settings),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure(res);
  const json: any = await readJson(res);
  const list: any[] = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
  return list.map((m) => m.id ?? m.name).filter(Boolean).sort();
}
