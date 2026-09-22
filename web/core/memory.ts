// Chat memory: a rolling summary, folded in the background.
//
// This never runs before a reply - it runs after one is saved, on the messages
// that have just fallen out of the context window. If it fails, the chat is
// unaffected; the next fold picks up the same messages again.
import type { CharacterCard, ChatMemory, Message, Settings } from '../types.ts';
import { applyMacros } from './prompt.ts';
import { completeChat } from './llm.ts';
import { getMemory, saveMemory } from './db.ts';

const MAX_SUMMARY_CHARS = 2000;
/** Never send an unbounded transcript to the summariser. */
const MAX_FOLD_CHARS = 24_000;

const INSTRUCTIONS = `You keep the memory of an ongoing roleplay so it can continue after older messages are forgotten.

Rewrite the running summary so it also covers the new messages below.

Rules:
- Past tense, third person, at most 250 words.
- Keep what still matters later: what happened, how the characters changed towards each other, what was promised or decided, and anything left unresolved. Keep concrete details that stay true - injuries, names, places, possessions.
- Drop small talk and anything already superseded.
- Use only what is written below. Never invent anything, and never continue the story.
- Reply with the summary text and nothing else. No preamble, no headings, no quotes.`;

/** Strip the padding a model puts around a summary it was asked to write bare. */
export function cleanSummary(raw: string): string {
  let text = raw.trim();
  // A fenced block, or one the model wrapped in quotes.
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  const quoted = /^"([\s\S]+)"$/.exec(text);
  if (quoted) text = quoted[1].trim();
  // Some models answer in JSON even when asked not to.
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.summary === 'string') text = parsed.summary.trim();
    } catch {
      /* not JSON after all; keep the text as it is */
    }
  }
  text = text.replace(/^(?:here(?:'s| is)[^:]*:|summary:)\s*/i, '').trim();
  return text.slice(0, MAX_SUMMARY_CHARS);
}

/** The transcript handed to the summariser, oldest first and length-capped. */
function transcript(messages: Message[], charName: string, userName: string): string {
  const lines = messages.map((m) => {
    const who = m.role === 'user' ? userName : charName;
    return `[${who}]: ${applyMacros(m.swipes[m.swipe_index] ?? '', charName, userName)}`;
  });
  const out = lines.join('\n\n');
  return out.length > MAX_FOLD_CHARS ? `...\n\n${out.slice(out.length - MAX_FOLD_CHARS)}` : out; // keep the most recent
}

const inFlight = new Set<number>();

/**
 * Fold `messages` into the chat's memory. Returns the new memory, or null when
 * there was nothing to do. Only one fold per chat runs at a time.
 */
export async function foldMemory(
  chatId: number,
  card: CharacterCard,
  settings: Settings,
  messages: Message[],
): Promise<ChatMemory | null> {
  if (inFlight.has(chatId)) return null;

  const current = await getMemory(chatId);
  // Director Notes are not part of the story as told, so they are never remembered.
  const fresh = messages.filter(
    (m) => m.role !== 'note' && m.id > current.coveredThrough && (m.swipes[m.swipe_index] ?? '').trim(),
  );
  if (!fresh.length) return null;

  inFlight.add(chatId);
  try {
    const result = await completeChat(
      settings,
      [
        { role: 'system', content: applyMacros(INSTRUCTIONS, card.name, settings.userName) },
        {
          role: 'user',
          content: [
            current.summary ? `Summary so far:\n${current.summary}` : 'There is no summary yet.',
            `New messages to fold in:\n${transcript(fresh, card.name, settings.userName)}`,
          ].join('\n\n'),
        },
      ],
      { maxTokens: 700, temperature: 0.3, timeoutMs: 60_000 },
    );

    const summary = cleanSummary(result.reply);
    if (!summary) throw new Error('the model returned an empty summary');

    const updated: ChatMemory = {
      ...current,
      summary,
      coveredThrough: Math.max(current.coveredThrough, fresh.at(-1)!.id),
      folds: current.folds + 1,
      updatedAt: Date.now(),
    };
    await saveMemory(chatId, updated);
    return updated;
  } finally {
    inFlight.delete(chatId);
  }
}
