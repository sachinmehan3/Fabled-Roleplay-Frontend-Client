// Everything the UI asks for, answered inside the browser.
//
// There is no server: data lives in IndexedDB (core/db.ts) and generation goes
// straight from this tab to the provider the user chose, with their own key.
import type {
  AdventureState,
  Character,
  CharacterCard,
  Chat,
  ChatMemory,
  ConnectionTest,
  DirectorStyle,
  GenerationMeta,
  Lorebook,
  Message,
  Settings,
  VisionCheck,
} from './types.ts';
import * as db from './core/db.ts';
import type { CharacterRow } from './core/db.ts';
import { foldMemory } from './core/memory.ts';
import { activateLore, EMPTY_ENTRY } from './core/lorebook.ts';
import { importLorebook as parseLorebook } from './core/lorebook-import.ts';
import { isPng, normalizeCard, parseCardFile } from './core/cards.ts';
import { chubCardUrl, chubPath } from './core/chub.ts';
import { applyMacros, buildPrompt, estimateTokens, type Adventure } from './core/prompt.ts';
import { buildDirectorPrompt, castOf, DIRECTOR_STYLES, parseDirectorReply } from './core/director.ts';
import { postProcess } from './core/post-process.ts';
import { completeChat, describeImage, listModels, streamChat, testChat, type StreamReport } from './core/llm.ts';
import starterCard from '../samples/sable.card.json' with { type: 'json' };

const MAX_UPLOAD = 20 * 1024 * 1024;
const TOO_LARGE = 'That file is too large (20 MB at most).';

// ---------- start-up ----------

let ready: Promise<void> | null = null;

/**
 * Runs once per page load, before anything is read: adds the starter character
 * to a brand-new database, and asks the browser to keep our data.
 */
function whenReady(): Promise<void> {
  ready ??= (async () => {
    if (!(await db.getFlag('seeded'))) {
      await db.setFlag('seeded', true); // first, so a failure below never repeats on every load
      try {
        const card = normalizeCard(starterCard);
        await db.insertCharacter(card.name, card);
      } catch (e) {
        console.error('Could not add the starter character:', (e as Error).message);
      }
    }
    // Without this, a browser short on space may clear the site's data.
    navigator.storage?.persist?.().catch(() => {});
  })();
  return ready;
}

// ---------- helpers ----------

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} not found`);
  return value;
}

const requireCharacter = async (id: number) => required(await db.getCharacter(id), 'Character');
const requireChat = async (id: number) => required(await db.getChat(id), 'Chat');
const requireLorebook = async (id: number) => required(await db.getLorebook(id), 'Lorebook');
const requireMessage = async (id: number) => required(await db.getMessage(id), 'Message');

/** A message starting with this goes to the Director only. */
const NOTE_PREFIX = /^\/d(?:\s+|$)/i;

function characterOut(row: CharacterRow, counts: Record<number, number>): Character {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    sprites: row.sprites ?? {},
    card: row.card,
    created_at: row.created_at,
    chats: counts[row.id] ?? 0,
  };
}

async function oneCharacter(id: number): Promise<Character> {
  return characterOut(await requireCharacter(id), await db.chatCounts());
}

async function readFile(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (file.size > MAX_UPLOAD) throw new Error(TOO_LARGE);
  return new Uint8Array(await file.arrayBuffer());
}

/** The image type, from the bytes rather than the file name; null if it is not one we show. */
function imageType(buf: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (isPng(buf)) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && ascii(0, 3) === 'GIF') return 'image/gif';
  return null;
}

/** Store a picture, and drop the one it replaces. */
async function saveImage(file: Blob, previous: string | null | undefined): Promise<string> {
  const bytes = await readFile(file);
  const type = imageType(bytes);
  if (!type) throw new Error('Pictures must be PNG, JPEG, WebP or GIF.');
  const id = await db.putImage(new Blob([bytes], { type }));
  await db.deleteImage(previous);
  return id;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture'));
    reader.readAsDataURL(blob);
  });
}

// ---------- describing your picture ----------

const DESCRIBE_PROMPT = `Write how the person in this picture would look to someone meeting them for the first time.

- Third person, present tense, at most 60 words.
- Cover build, hair, eyes, clothing and bearing. Keep it concrete.
- Write it as a character description for a roleplay, not as a photo caption. Do not mention photographs, cameras, backgrounds or image quality.
- Do not guess at names, jobs, ethnicity, health or exact age. An age range is fine if it is obvious.
- Reply with the description alone.`;

async function userPictureDataUrl(settings: Settings): Promise<string> {
  if (!settings.userAvatar) throw new Error('Upload a picture first.');
  const blob = await db.getImage(settings.userAvatar);
  if (!blob) throw new Error('That picture is no longer saved.');
  return blobToDataUrl(blob);
}

/** Whether a given provider+model can read images. Forgotten on reload. */
const visionCache = new Map<string, VisionCheck>();
const visionKey = (s: Settings) => `${s.apiBase}|${s.model}`;

// ---------- lorebooks ----------

const NEW_BOOK: Omit<Lorebook, 'id' | 'created_at'> = {
  name: 'New lorebook',
  enabled: true,
  characterIds: [],
  scanDepth: 4,
  caseSensitive: false,
  matchWholeWords: true,
  maxRecursionSteps: 2,
  budget: 1024,
  entries: [],
};

/** A PNG or JSON card. A PNG is also kept as the avatar, and an embedded lorebook as a lorebook. */
async function importCard(bytes: Uint8Array<ArrayBuffer>): Promise<Character> {
  let parsed;
  try {
    parsed = parseCardFile(bytes);
  } catch (e) {
    throw new Error(`Could not read card: ${(e as Error).message}`);
  }
  const avatar = parsed.png ? await db.putImage(new Blob([bytes], { type: 'image/png' })) : null;
  const row = await db.insertCharacter(parsed.card.name, parsed.card, avatar);

  let lorebook: Character['lorebook'];
  if (parsed.book) {
    try {
      const book = await db.insertLorebook({
        ...parseLorebook(parsed.book, `${row.name} lorebook`),
        characterIds: [row.id],
      });
      lorebook = { name: book.name, entries: book.entries.length };
    } catch (e) {
      console.error(`Card lorebook for ${row.name} could not be read:`, (e as Error).message);
    }
  }
  return { ...(await oneCharacter(row.id)), lorebook };
}

// ---------- the API ----------

export const api = {
  getSettings: async (): Promise<Settings> => {
    await whenReady();
    return db.getSettings();
  },
  saveSettings: (s: Partial<Settings>) => db.saveSettings(s),
  listModels: async () => ({ models: await listModels(await db.getSettings()) }),

  /** Spends a handful of tokens to prove the whole chain works, not just /models. */
  testConnection: async (): Promise<ConnectionTest> => {
    const settings = await db.getSettings();
    if (!settings.apiBase.trim()) throw new Error('Set an API base URL first.');
    if (!settings.model) throw new Error('Choose a model first.');
    const started = Date.now();
    const result = await testChat(settings);
    return { ...result, ms: Date.now() - started };
  },

  uploadUserAvatar: async (file: File) => {
    const current = await db.getSettings();
    return db.saveSettings({ userAvatar: await saveImage(file, current.userAvatar) });
  },
  removeUserAvatar: async () => {
    await db.deleteImage((await db.getSettings()).userAvatar);
    return db.saveSettings({ userAvatar: '' });
  },
  uploadChatBackground: async (file: File) => {
    const current = await db.getSettings();
    return db.saveSettings({ chatBackground: await saveImage(file, current.chatBackground) });
  },
  removeChatBackground: async () => {
    await db.deleteImage((await db.getSettings()).chatBackground);
    return db.saveSettings({ chatBackground: '' });
  },

  /** Asks the model to look at the picture and say one word, to learn whether it can. */
  checkVision: async (): Promise<VisionCheck> => {
    const settings = await db.getSettings();
    if (!settings.model) return { vision: false, reason: 'Choose a model first.' };
    if (!settings.userAvatar) return { vision: false, reason: 'Upload a picture first.' };
    const cached = visionCache.get(visionKey(settings));
    if (cached) return cached;
    try {
      await describeImage(settings, await userPictureDataUrl(settings), 'Reply with the single word: ok', 1);
      const result = { vision: true };
      visionCache.set(visionKey(settings), result);
      return result;
    } catch (e) {
      const reason = (e as Error).message;
      const result = { vision: false, reason };
      // A key or network problem says nothing about the model, so don't remember it as a verdict.
      if (!/could not reach|no response|401|403|429|timed out/i.test(reason)) visionCache.set(visionKey(settings), result);
      return result;
    }
  },

  describeMe: async () => {
    const settings = await db.getSettings();
    if (!settings.model) throw new Error('Choose a model first.');
    const result = await describeImage(settings, await userPictureDataUrl(settings), DESCRIBE_PROMPT, 220);
    const text = result.reply.trim();
    if (!text) throw new Error('The model looked at the picture but said nothing.');
    visionCache.set(visionKey(settings), { vision: true }); // it plainly can
    return { text };
  },

  // ---------- characters ----------

  listCharacters: async (): Promise<Character[]> => {
    await whenReady();
    const counts = await db.chatCounts();
    return (await db.listCharacters()).map((row) => characterOut(row, counts));
  },

  importCharacter: async (file: File): Promise<Character> => importCard(await readFile(file)),

  /** A character page on chub.ai or characterhub.org, fetched as its PNG card. */
  importCharacterFromUrl: async (link: string): Promise<Character> => {
    const path = chubPath(link);
    if (!path) {
      throw new Error('Paste a character link from chub.ai or characterhub.org, like https://chub.ai/characters/creator/name');
    }
    let res: Response;
    try {
      res = await fetch(chubCardUrl(path));
    } catch {
      throw new Error('Could not reach Chub. Check your connection and try again.');
    }
    if (res.status === 404) {
      throw new Error('Chub has no card at that link. Check it, or download the card from Chub and import the file.');
    }
    if (!res.ok) throw new Error(`Chub could not send the card (error ${res.status}). Try again later.`);
    if (Number(res.headers.get('content-length')) > MAX_UPLOAD) throw new Error(TOO_LARGE);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_UPLOAD) throw new Error(TOO_LARGE);
    return importCard(bytes);
  },

  createCharacter: async (input: CharacterCard) => {
    let card: CharacterCard;
    try {
      card = normalizeCard(input);
    } catch (e) {
      throw new Error(`Could not save card: ${(e as Error).message}`);
    }
    return oneCharacter((await db.insertCharacter(card.name, card)).id);
  },

  updateCharacter: async (id: number, patch: CharacterCard) => {
    const current = await requireCharacter(id);
    const card = normalizeCard({ ...current.card, ...patch });
    await db.updateCharacter(id, { name: card.name, card });
    return oneCharacter(id);
  },

  uploadCharacterAvatar: async (id: number, file: File) => {
    const c = await requireCharacter(id);
    await db.updateCharacter(id, { avatar: await saveImage(file, c.avatar) });
    return oneCharacter(id);
  },

  removeCharacterAvatar: async (id: number) => {
    const c = await requireCharacter(id);
    await db.deleteImage(c.avatar);
    await db.updateCharacter(id, { avatar: null });
    return oneCharacter(id);
  },

  uploadCharacterSprite: async (id: number, file: File, expression = 'neutral') => {
    const c = await requireCharacter(id);
    const sprites = c.sprites ?? {};
    await db.updateCharacter(id, { sprites: { ...sprites, [expression]: await saveImage(file, sprites[expression]) } });
    return oneCharacter(id);
  },

  removeCharacterSprite: async (id: number, expression = 'neutral') => {
    const c = await requireCharacter(id);
    const { [expression]: gone, ...rest } = c.sprites ?? {};
    await db.deleteImage(gone);
    await db.updateCharacter(id, { sprites: rest });
    return oneCharacter(id);
  },

  deleteCharacter: async (id: number) => {
    const c = await requireCharacter(id);
    await db.deleteCharacter(id);
    await db.deleteImage(c.avatar);
    for (const sprite of Object.values(c.sprites ?? {})) await db.deleteImage(sprite);
    return { ok: true };
  },

  // ---------- chats ----------

  listChats: (charId: number): Promise<Chat[]> => db.listChats(charId),

  createChat: async (charId: number): Promise<Chat> => {
    const c = await requireCharacter(charId);
    const chat = await db.insertChat(c.id, '');
    // Greeting + alternate greetings become swipes of the first message.
    const greetings = [c.card.first_mes, ...c.card.alternate_greetings].filter((g) => g.trim());
    if (greetings.length) await db.insertMessage(chat.id, 'assistant', greetings);
    return requireChat(chat.id);
  },

  /** Naming a chat is the only thing worth editing about it. */
  renameChat: async (id: number, title: string): Promise<Chat> => {
    await requireChat(id);
    await db.updateChat(id, { title: title.trim().slice(0, 120) });
    return requireChat(id);
  },

  deleteChat: async (id: number) => {
    await db.deleteChat(id);
    return { ok: true };
  },

  /**
   * Split a chat in two at a message: the new one holds everything up to and
   * including it, and the original is left exactly as it was.
   */
  branchChat: async (chatId: number, messageId: number): Promise<Chat> => {
    const chat = await requireChat(chatId);
    const messages = await db.listMessages(chat.id);
    const at = messages.findIndex((m) => m.id === messageId);
    if (at === -1) throw new Error('That message is not in this chat');

    const branch = await db.insertChat(
      chat.character_id,
      chat.title.trim() ? `${chat.title} (branched)` : '',
      Date.now(),
      chat.id,
      { adventure: chat.adventure, directorStyle: chat.directorStyle },
    );

    // Copy the messages, carrying their prompts and thinking across so the
    // generation details of an old reply still work in the branch.
    const newIdOf = new Map<number, number>();
    for (const m of messages.slice(0, at + 1)) {
      const meta = await Promise.all(
        m.meta.map(async (entry, i) => (entry ? { ...entry, ...(await db.getRecord(m.id, i)) } : null)),
      );
      const copy = await db.insertMessage(branch.id, m.role, [...m.swipes], meta, m.created_at, m.swipe_index);
      newIdOf.set(m.id, copy.id);
    }

    // The branch inherits what was remembered, pointed at the copied messages.
    const memory = await db.getMemory(chat.id);
    if (memory.summary.trim()) {
      const covered = [...newIdOf.entries()].filter(([old]) => old <= memory.coveredThrough).map(([, id]) => id);
      await db.saveMemory(branch.id, { ...memory, coveredThrough: covered.length ? Math.max(...covered) : 0 });
    }
    // The same adventure carries on in the branch.
    const state = await db.getAdventureState(chat.id);
    if (state.text.trim()) await db.saveAdventureState(branch.id, state.text);
    // Lorebook timers are counted in messages, so they would be wrong here. The
    // branch starts with none and they re-establish themselves as it goes.
    return requireChat(branch.id);
  },

  // ---------- adventure mode ----------

  /** Switch adventure mode on or off for a chat, or change its Director Style. */
  updateAdventure: async (chatId: number, patch: { adventure?: boolean; directorStyle?: DirectorStyle }) => {
    await requireChat(chatId);
    const next: { adventure?: boolean; directorStyle?: DirectorStyle } = {};
    if (typeof patch.adventure === 'boolean') next.adventure = patch.adventure;
    if (patch.directorStyle && DIRECTOR_STYLES.includes(patch.directorStyle)) next.directorStyle = patch.directorStyle;
    await db.updateChat(chatId, next);
    return requireChat(chatId);
  },

  getAdventureState: (chatId: number): Promise<AdventureState> => db.getAdventureState(chatId),

  saveAdventureState: async (chatId: number, text: string): Promise<AdventureState> => {
    await requireChat(chatId);
    await db.saveAdventureState(chatId, text);
    return db.getAdventureState(chatId);
  },

  // ---------- lorebooks ----------

  listLorebooks: () => db.listLorebooks(),

  createLorebook: (name?: string) => db.insertLorebook({ ...NEW_BOOK, name: name?.trim() || NEW_BOOK.name }),

  saveLorebook: async (id: number, patch: Partial<Omit<Lorebook, 'id'>>) => {
    const book = await requireLorebook(id);
    const entries = Array.isArray(patch.entries)
      ? patch.entries.map((e, i) => ({ ...EMPTY_ENTRY, ...e, id: e.id || `e-${Date.now().toString(36)}-${i}` }))
      : book.entries;
    const { created_at: _created, ...rest } = patch;
    await db.updateLorebook(id, { ...rest, entries });
    return requireLorebook(id);
  },

  deleteLorebook: async (id: number) => {
    await db.deleteLorebook(id);
    return { ok: true };
  },

  /** Ours, or a SillyTavern World Info export. */
  importLorebook: async (file: File) => {
    let parsed;
    try {
      parsed = parseLorebook(JSON.parse(new TextDecoder().decode(await readFile(file))), 'Imported lorebook');
    } catch (e) {
      throw new Error(`Could not read that lorebook: ${(e as Error).message}`);
    }
    return db.insertLorebook(parsed);
  },

  // ---------- chat memory ----------

  getMemory: (chatId: number): Promise<ChatMemory> => db.getMemory(chatId),

  saveMemory: async (chatId: number, patch: { summary: string }) => {
    const current = await db.getMemory(chatId);
    await db.saveMemory(chatId, { ...current, summary: patch.summary });
    return db.getMemory(chatId);
  },

  /** Summarise now, rather than waiting for messages to fall out of the window. */
  foldMemory: async (chatId: number): Promise<ChatMemory> => {
    const chat = await requireChat(chatId);
    const character = await requireCharacter(chat.character_id);
    const settings = await db.getSettings();
    if (!settings.model) throw new Error('No model selected - open Settings first.');
    const messages = await db.listMessages(chat.id);
    const updated = await foldMemory(chat.id, character.card, settings, messages.slice(0, -1));
    if (!updated) throw new Error('Nothing new to remember yet.');
    return updated;
  },

  clearMemory: (chatId: number) => db.clearMemory(chatId),

  // ---------- messages ----------

  listMessages: (chatId: number): Promise<Message[]> => db.listMessages(chatId),

  /** Your next message, or a Director Note when it starts with `/d `. */
  sendMessage: async (chatId: number, content: string): Promise<Message> => {
    if (!content.trim()) throw new Error('Empty message');
    const chat = await requireChat(chatId);
    const note = NOTE_PREFIX.exec(content.trimStart());
    if (note) {
      if (!chat.adventure) throw new Error('Adventure mode is off');
      const text = content.trimStart().slice(note[0].length);
      if (!text.trim()) throw new Error('Empty message');
      return db.insertMessage(chatId, 'note', [text]);
    }
    return db.insertMessage(chatId, 'user', [content]);
  },

  /** Edit the active swipe's text, or change which swipe is active. */
  updateMessage: async (id: number, patch: { content?: string; swipe_index?: number }): Promise<Message> => {
    const msg = await requireMessage(id);
    if (typeof patch.swipe_index === 'number') {
      if (patch.swipe_index < 0 || patch.swipe_index >= msg.swipes.length) throw new Error('Bad swipe index');
      msg.swipe_index = patch.swipe_index;
    }
    if (typeof patch.content === 'string') {
      msg.swipes[msg.swipe_index] = patch.content;
      // Keep the record, but say the text no longer matches what the model produced.
      const record = msg.meta[msg.swipe_index];
      if (record) msg.meta[msg.swipe_index] = { ...record, edited: true };
    }
    await db.saveSwipes(msg.id, msg.swipes, msg.meta, msg.swipe_index);
    return requireMessage(id);
  },

  deleteMessage: async (id: number) => {
    await db.deleteMessage(id);
    return { ok: true };
  },

  /** Used by the delete mode, which removes a message and everything after it in one go. */
  deleteMessages: async (chatId: number, ids: number[]) => {
    if (!ids.length) throw new Error('No messages were selected');
    return { removed: await db.deleteMessages(chatId, ids) };
  },

  /** The full record for one swipe, including the prompt as it was sent. */
  getMessageMeta: async (id: number, swipe: number): Promise<GenerationMeta> => {
    const msg = await requireMessage(id);
    const meta = msg.meta[swipe];
    if (!meta) throw new Error('No generation record for this version');
    return { ...meta, ...(await db.getRecord(id, swipe)) };
  },

  // ---------- this browser's data ----------

  getImage: (id: string) => db.getImage(id),

  exportBackup: (opts: { includeApiKey?: boolean } = {}) => db.exportBackup(opts),

  /** Replaces everything. */
  importBackup: async (file: File) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error('This is not a Fabled backup file.');
    }
    await db.importBackup(raw);
    visionCache.clear();
  },

  /** Deletes everything, the key included. The page should reload afterwards. */
  clearAllData: async () => {
    await db.resetDatabase();
    ready = null;
    visionCache.clear();
  },

  storageInfo: async () => {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    return { used: estimate?.usage, quota: estimate?.quota, persisted: Boolean(persisted) };
  },
};

// ---------- generation ----------

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** In adventure mode: the Director is deciding, or the Narrator is writing. */
  onPhase?: (phase: 'director' | 'narrator') => void;
  signal: AbortSignal;
}

/**
 * Generate a message, streaming it to the handlers, and save it.
 *
 *   new:         append a reply
 *   swipe:       add a version to a reply (the last, or `messageId`)
 *   redo:        replace a reply, versions and all
 *   impersonate: write your next message, or rewrite `messageId` if it is yours
 *   redirect:    add a version to a reply with a fresh Direction (adventure mode)
 *
 * In adventure mode the Director decides what happens before the Narrator
 * writes: for new replies and redirects it is asked afresh, while swipe and
 * redo keep the Direction of the version they rewrite.
 *
 * Every mode but 'new' writes from what came before the target, and leaves
 * anything after it alone. Stopping keeps whatever arrived.
 */
export async function generate(
  chatId: number,
  mode: 'new' | 'swipe' | 'redo' | 'impersonate' | 'redirect',
  { onDelta, onReasoning, onPhase, signal }: StreamHandlers,
  messageId?: number,
): Promise<Message | undefined> {
  const chat = await requireChat(chatId);
  const character = await requireCharacter(chat.character_id);
  const settings = await db.getSettings();
  if (!settings.model) throw new Error('No model selected — open Settings first.');

  let all = await db.listMessages(chat.id);
  let target: Message | undefined;
  const impersonate = mode === 'impersonate';
  const rewrites = mode !== 'new' && !(impersonate && messageId === undefined);
  const replace = mode === 'redo' || (impersonate && rewrites);
  if (rewrites) {
    const at = typeof messageId === 'number' ? all.findIndex((m) => m.id === messageId) : all.length - 1;
    if (at < 0) throw new Error('That message is not in this chat');
    target = all[at];
    const wanted = impersonate ? 'user' : 'assistant'; // Director Notes are never rewritten
    if (!target || target.role !== wanted) {
      throw new Error(impersonate ? 'Only your own message can be written for you' : 'Only a reply can be regenerated');
    }
    all = all.slice(0, at);
  }

  // Director Notes are for the Director alone; the story is everything else.
  const story = all.filter((m) => m.role !== 'note');
  const history = story.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.swipes[m.swipe_index] ?? '' }));

  // Lorebooks look at the conversation and decide what the model needs to know.
  const lore = activateLore({
    books: await db.listLorebooks(),
    messages: history,
    characterId: character.id,
    state: await db.getLoreState(chat.id),
    estimateTokens,
  });
  await db.saveLoreState(chat.id, lore.state); // sticky and cooldown are remembered per chat

  const memory = await db.getMemory(chat.id);

  const adventure: Adventure = {};
  let directed: Partial<GenerationMeta> = {};
  if (chat.adventure && !impersonate) {
    const state = await db.getAdventureState(chat.id);
    adventure.cast = castOf(state.text);
    if (target && (mode === 'swipe' || mode === 'redo')) {
      // A new version rewrites the prose, not what happened.
      const direction = (await db.getRecord(target.id, target.swipe_index))?.direction;
      if (direction) {
        adventure.direction = direction;
        directed = { direction, directionReused: true };
      }
    } else {
      onPhase?.('director');
      const directorModel = settings.directorModel.trim() || settings.model;
      const started = Date.now();
      try {
        const recentDirections: string[] = [];
        for (const m of all.filter((x) => x.role === 'assistant').slice(-3)) {
          const direction = (await db.getRecord(m.id, m.swipe_index))?.direction;
          if (direction) recentDirections.push(direction);
        }
        const result = await completeChat(
          { ...settings, model: directorModel },
          buildDirectorPrompt({
            card: character.card,
            settings,
            style: chat.directorStyle ?? 'balanced',
            state,
            memory,
            lore: lore.entries.map((l) => l.entry.content),
            history: all.map((m) => ({ role: m.role, content: m.swipes[m.swipe_index] ?? '' })),
            recentDirections,
          }),
          { maxTokens: 1000, temperature: settings.directorTemperature, timeoutMs: 90_000, signal },
        );
        const reply = parseDirectorReply(result.reply);
        if (!reply) throw new Error('the Director answered without a <direction>');
        if (reply.state !== undefined) {
          await db.saveAdventureState(chat.id, reply.state);
          adventure.cast = castOf(reply.state);
        }
        adventure.direction = reply.direction;
        directed = { direction: reply.direction, directorModel, directorMs: Date.now() - started, directorUsage: result.usage };
      } catch (e) {
        if (signal.aborted) return undefined; // Stop, before a word was written
        const reason = (e as Error).message;
        // A note means nothing without the Director, so say so rather than carry on.
        if (all.at(-1)?.role === 'note') throw new Error(`The Director could not answer your note: ${reason}`);
        directed = { directorModel, directorMs: Date.now() - started, directorError: reason };
      }
    }
    onPhase?.('narrator');
  }

  const built = buildPrompt(character.card, settings, history, memory, lore.entries, adventure);
  // Asking for the other half of the conversation: same prompt, a last word on
  // whose turn it is.
  if (impersonate) {
    built.messages.push({
      role: 'system',
      content: applyMacros(
        `Write the next message as {{user}}, in their voice and from their point of view. Do not write as {{char}}, do not narrate what {{char}} says or does, and stop when {{user}}'s turn is over.`,
        character.card.name,
        settings.userName,
      ),
    });
  }
  // Reshaped before it is sent and before it is recorded, so the details panel
  // shows what the provider actually received.
  const messages = postProcess(built.messages, settings.promptFormat);

  const report: StreamReport = {};
  const startedAt = Date.now();
  let firstTokenAt: number | undefined;
  let text = '';
  let reasoning = '';
  let error: string | null = null;
  try {
    for await (const part of streamChat(settings, messages, signal, report)) {
      if (part.reasoning) {
        reasoning += part.text;
        onReasoning?.(part.text);
        continue;
      }
      firstTokenAt ??= Date.now(); // the clock starts at the first word of the reply
      text += part.text;
      onDelta(part.text);
    }
  } catch (e) {
    if (!signal.aborted) error = (e as Error).message;
  }

  // Everything worth knowing about this reply, kept next to the text itself.
  const meta: GenerationMeta = {
    status: error ? 'error' : signal.aborted ? 'stopped' : 'ok',
    error: error ?? undefined,
    createdAt: Date.now(),
    provider: settings.apiBase,
    modelRequested: settings.model,
    modelReported: report.modelReported,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    contextSize: settings.contextSize,
    thinkingLevel: settings.thinkingLevel,
    promptFormat: settings.promptFormat,
    extrasDropped: report.extrasDropped,
    prompt: messages,
    systemSource: built.systemSource,
    usedOriginalMacro: built.usedOriginalMacro,
    hasPostHistory: built.hasPostHistory,
    historyTotal: history.length,
    historySent: built.usedHistory,
    historyBudget: built.historyBudget,
    memoryTokens: built.memoryTokens,
    loreTokens: built.loreTokens || undefined,
    loreEntries: built.loreTitles.length || undefined,
    loreTitles: built.loreTitles.length ? built.loreTitles : undefined,
    estimatedPromptTokens: built.estimatedTokens,
    finishReason: report.finishReason,
    usage: report.usage,
    reasoning: reasoning.trim() || undefined,
    reasoningChars: reasoning.trim().length || undefined,
    outputChars: text.length,
    estimatedCompletionTokens: estimateTokens(text),
    msToFirstToken: firstTokenAt && firstTokenAt - startedAt,
    msTotal: Date.now() - startedAt,
    ...directed,
  };

  // Save whatever we got, including partial output after Stop.
  let saved: Message | undefined;
  if (text.trim()) {
    if (target) {
      if (replace) {
        // Only now that the new text exists, so a failure leaves the old one in place.
        await db.saveSwipes(target.id, [text], [meta], 0);
      } else {
        await db.saveSwipes(target.id, [...target.swipes, text], [...target.meta, meta], target.swipes.length);
      }
      saved = await db.getMessage(target.id);
    } else {
      saved = await db.insertMessage(chat.id, impersonate ? 'user' : 'assistant', [text], [meta]);
    }
  }

  // Remember whatever just fell out of the window, in the background, so a slow
  // or failing summariser never delays the roleplay.
  if (settings.memoryTokens > 0 && built.usedHistory < story.length) {
    const forgotten = story.slice(0, story.length - built.usedHistory);
    foldMemory(chat.id, character.card, settings, forgotten).catch((e: Error) =>
      console.error(`Memory fold failed for chat ${chat.id}:`, e.message),
    );
  }

  if (error) {
    const err = new Error(error) as Error & { saved?: Message };
    err.saved = saved;
    throw err;
  }
  return saved;
}
