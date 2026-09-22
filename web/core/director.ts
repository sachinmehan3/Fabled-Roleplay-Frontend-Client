// The Director: in adventure mode, the model that decides what happens before
// the Narrator writes it. It rules on what the user's action can achieve,
// brings in characters and events, and keeps the Adventure State.
//
// It answers once per turn, not streamed, in tagged plain text - many roleplay
// models cannot be trusted to write valid JSON.
import type { AdventureState, CharacterCard, ChatMemory, DirectorStyle, MessageRole, Settings } from '../types.ts';
import { applyMacros, estimateTokens, type ChatMessage } from './prompt.ts';

export const DIRECTOR_STYLES: DirectorStyle[] = ['referee', 'balanced', 'active'];

export const DEFAULT_DIRECTOR_PROMPT = `You are the Director of an interactive story between {{user}} and {{char}}. You never write the story yourself. Another model, the Narrator, writes it; you tell the Narrator what happens next, in a Direction it will follow.

Each turn:
1. Rule on {{user}}'s latest action. Decide what it can really achieve given the world, the scene and what {{user}} can know and do. {{user}} cannot succeed at the impossible: an impossible attempt fails, or, when the intent is clear, becomes the nearest thing that could work. Never refuse or rewrite what {{user}} said - only decide how it turns out.
2. Decide whether anything new should happen: a character arriving, an event, a complication, a consequence of something earlier. Follow up threads you set up before rather than starting new ones every turn.
3. Keep the Adventure State: the cast you have introduced, open threads and your plans for them, and rules of the world established in play.

When {{user}} writes a note addressed to you, it is a suggestion for what happens next. Build the next Direction from it.

Answer in exactly this shape, and nothing else:

<direction>
A few short lines for the Narrator: how {{user}}'s action turns out, and what else happens. Plain instructions, not prose. If there is nothing to add, say so.
</direction>
<state>
Cast:
- Name: one line on who they are and where they stand
Threads:
- one line per open thread, with your plans for it
Rules:
- one line per rule of the world established so far
</state>

Leave out <state> when nothing in it has changed.`;

const STYLE: Record<DirectorStyle, string> = {
  referee:
    'Style: referee. Only rule on what actions achieve. Never introduce characters or events of your own; leave the story where the players take it.',
  balanced:
    'Style: balanced. Let quiet scenes breathe. Introduce a character or event when the scene stalls or the story needs a push, not every turn.',
  active:
    'Style: active. Keep the pressure on. Something should move almost every turn: new arrivals, complications, consequences catching up.',
};

export interface DirectorReply {
  direction: string;
  /** The whole revised Adventure State, when the Director sent one. */
  state?: string;
}

/** The text inside the last `<tag>…</tag>`, or inside an unclosed one that runs to the end. */
function tagged(raw: string, tag: string): string | undefined {
  const closed = [...raw.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))];
  if (closed.length) return closed.at(-1)![1].trim();
  const open = new RegExp(`<${tag}>([\\s\\S]*)$`, 'i').exec(raw);
  return open ? open[1].trim() : undefined;
}

/**
 * Pull the Direction and the optional state out of a Director reply, ignoring
 * anything said around them. Null when there is no Direction at all.
 */
export function parseDirectorReply(raw: string): DirectorReply | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Set the state aside first, so an unclosed <direction> stops where it begins.
  const direction = tagged(text.replace(/<state>[\s\S]*?(?:<\/state>|$)/gi, ''), 'direction');
  if (!direction) return null;
  const state = tagged(text, 'state');
  return state ? { direction, state } : { direction };
}

const HEADING = /^\s*(?:#+\s*)?(cast|threads|rules)\s*:?\s*$/i;

/**
 * The part of the Adventure State the Narrator may see: the cast. Plans and
 * open threads stay with the Director, so characters don't act on them early.
 */
export function castOf(state: string): string {
  const lines = state.split('\n');
  const out: string[] = [];
  let inCast = false;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      inCast = heading[1].toLowerCase() === 'cast';
      continue;
    }
    if (inCast) out.push(line);
  }
  return out.join('\n').trim();
}

export interface DirectorTurn {
  card: CharacterCard;
  settings: Settings;
  style: DirectorStyle;
  state: AdventureState;
  memory: ChatMemory;
  lore: string[];
  /** The story so far, oldest first, Director Notes included. */
  history: { role: MessageRole; content: string }[];
  /** The Director's most recent Directions, oldest first. */
  recentDirections: string[];
}

/** The messages sent to the Director for one turn. */
export function buildDirectorPrompt(t: DirectorTurn): ChatMessage[] {
  const { card, settings } = t;
  const m = (text: string) => applyMacros(text, card.name, settings.userName).trim();
  const who = (role: MessageRole) =>
    role === 'user' ? settings.userName : role === 'note' ? `Note from ${settings.userName} to you` : card.name;

  const context = [
    m(settings.directorPrompt.trim() || DEFAULT_DIRECTOR_PROMPT),
    STYLE[t.style],
    card.description && `<character name="${card.name}">\n${m(card.description)}\n</character>`,
    card.personality && `${card.name}'s personality: ${m(card.personality)}`,
    settings.userDescription.trim() && `<user name="${settings.userName}">\n${m(settings.userDescription)}\n</user>`,
    card.scenario && `Scenario: ${m(card.scenario)}`,
    ...t.lore.map((l) => `<lore>\n${m(l)}\n</lore>`),
    t.memory.summary.trim() && `<memory>\nEarlier in this story:\n\n${m(t.memory.summary)}\n</memory>`,
    `<adventure_state>\n${t.state.text.trim() || '(empty - nothing established yet)'}\n</adventure_state>`,
    t.recentDirections.length &&
      `Your most recent Directions, oldest first:\n${t.recentDirections.map((d) => `---\n${d.trim()}`).join('\n')}`,
  ].filter(Boolean);

  // The newest messages that fit the Director's own budget.
  const lines: string[] = [];
  let budget = settings.directorTokens;
  for (let i = t.history.length - 1; i >= 0; i--) {
    const line = `[${who(t.history[i].role)}]: ${m(t.history[i].content)}`;
    const cost = estimateTokens(line);
    if (cost > budget) break;
    budget -= cost;
    lines.unshift(line);
  }

  const last = t.history.at(-1);
  const ask =
    last?.role === 'note'
      ? `${settings.userName} has left you a note, the last line above. Write the next Direction from it.`
      : last?.role === 'user'
        ? `Rule on ${settings.userName}'s latest action, the last line above, and write the next Direction.`
        : `${settings.userName} has not acted since the last reply. Write the next Direction to continue the scene.`;

  return [
    { role: 'system', content: context.join('\n\n') },
    { role: 'user', content: `The story so far:\n\n${lines.join('\n\n') || '(nothing yet)'}\n\n${ask}` },
  ];
}
