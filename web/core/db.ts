// Storage: IndexedDB, in the visitor's own browser. Nothing here ever leaves it.
//
//   kv          settings, and a flag for the one-time starter character
//   characters  card and avatar image id
//   chats       title, branched_from           (index: character_id)
//   messages    swipes, light meta             (index: chat_id)
//   records     prompt and reasoning per swipe (key: [message_id, swipe])
//   memory      rolling summary per chat
//   lore_state  sticky and cooldown timers per chat
//   adventure   the Director's Adventure State per chat
//   lorebooks   books and their entries
//   images      picture bytes, by random id
//
// Prompts are kept apart from messages: they are by far the largest thing we
// keep, and messages are read whenever a chat opens.
import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  AdventureState,
  CharacterCard,
  Chat,
  ChatMemory,
  GenerationMeta,
  Lorebook,
  Message,
  MessageRole,
  PromptMessage,
  Settings,
} from '../types.ts';
import type { LoreState } from './lorebook.ts';

const DB_NAME = 'fabled';
const DB_VERSION = 2;

export interface CharacterRow {
  id: number;
  name: string;
  avatar: string | null;
  /** Missing on characters saved before sprites existed. */
  sprites?: Record<string, string>;
  card: CharacterCard;
  created_at: number;
}

export type ChatRow = Omit<Chat, 'message_count'>;

export interface RecordRow {
  message_id: number;
  swipe: number;
  chat_id: number;
  prompt?: PromptMessage[];
  reasoning?: string;
  direction?: string;
}

export interface ImageRow {
  id: string;
  type: string;
  data: ArrayBuffer;
}

interface FabledDB extends DBSchema {
  kv: { key: string; value: unknown };
  characters: { key: number; value: CharacterRow };
  chats: { key: number; value: ChatRow; indexes: { character_id: number } };
  messages: { key: number; value: Message; indexes: { chat_id: number } };
  records: { key: [number, number]; value: RecordRow; indexes: { message_id: number; chat_id: number } };
  memory: { key: number; value: ChatMemory & { chat_id: number } };
  lore_state: { key: number; value: { chat_id: number; state: LoreState } };
  adventure: { key: number; value: AdventureState & { chat_id: number } };
  lorebooks: { key: number; value: Lorebook };
  images: { key: string; value: ImageRow };
}

type StoreName =
  | 'kv'
  | 'characters'
  | 'chats'
  | 'messages'
  | 'records'
  | 'memory'
  | 'lore_state'
  | 'adventure'
  | 'lorebooks'
  | 'images';
const STORES: StoreName[] = [
  'kv',
  'characters',
  'chats',
  'messages',
  'records',
  'memory',
  'lore_state',
  'adventure',
  'lorebooks',
  'images',
];
/** Everything that belongs to one chat. */
const CHAT_STORES: StoreName[] = ['chats', 'messages', 'records', 'memory', 'lore_state', 'adventure'];

let opening: Promise<IDBPDatabase<FabledDB>> | null = null;

export function db(): Promise<IDBPDatabase<FabledDB>> {
  opening ??= openDB<FabledDB>(DB_NAME, DB_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 2) d.createObjectStore('adventure', { keyPath: 'chat_id' });
      if (oldVersion >= 1) return;
      d.createObjectStore('kv');
      d.createObjectStore('characters', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('chats', { keyPath: 'id', autoIncrement: true }).createIndex('character_id', 'character_id');
      d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true }).createIndex('chat_id', 'chat_id');
      const records = d.createObjectStore('records', { keyPath: ['message_id', 'swipe'] });
      records.createIndex('message_id', 'message_id');
      records.createIndex('chat_id', 'chat_id');
      d.createObjectStore('memory', { keyPath: 'chat_id' });
      d.createObjectStore('lore_state', { keyPath: 'chat_id' });
      d.createObjectStore('lorebooks', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('images', { keyPath: 'id' });
    },
    blocking() {
      // Another tab wants a newer version: step aside rather than hold it up.
      opening?.then((d) => d.close());
      opening = null;
    },
  });
  return opening;
}

/** Close and delete everything. Used by "Clear all data" and by tests. */
export async function resetDatabase() {
  if (opening) (await opening).close();
  opening = null;
  await deleteDB(DB_NAME);
}

/** Leave out undefined id so autoIncrement assigns one. */
function withoutId<T extends { id?: number }>(row: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = row;
  return rest;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// ---------- settings ----------

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://openrouter.ai/api/v1',
  model: '',
  userName: 'User',
  userDescription: '',
  userAvatar: '',
  systemPrompt:
    "You are {{char}} in an ongoing roleplay with {{user}}. Stay in character, write vivid prose, and never speak or act for {{user}}.",
  temperature: 0.9,
  maxTokens: 400,
  contextSize: 8192,
  thinkingLevel: 'default',
  promptFormat: 'none',
  memoryTokens: 800,
  messageBubbles: true,
  chatBackground: '',
  chatBackgroundDim: 60,
  spriteMode: false,
  directorModel: '',
  directorTemperature: 0.4,
  directorTokens: 4000,
  directorPrompt: '',
  apiKey: '',
};

/** Only known keys of the right type survive, so a stale or hand-edited record cannot break anything. */
function cleanSettings(base: Settings, patch: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k in DEFAULT_SETTINGS && v !== undefined && typeof v === typeof DEFAULT_SETTINGS[k as keyof Settings]) out[k] = v;
  }
  return out as unknown as Settings;
}

export async function getSettings(): Promise<Settings> {
  const saved = (await (await db()).get('kv', 'settings')) as Record<string, unknown> | undefined;
  return cleanSettings(DEFAULT_SETTINGS, saved ?? {});
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const d = await db();
  const tx = d.transaction('kv', 'readwrite');
  const saved = (await tx.store.get('settings')) as Record<string, unknown> | undefined;
  const next = cleanSettings(cleanSettings(DEFAULT_SETTINGS, saved ?? {}), patch as Record<string, unknown>);
  await tx.store.put(next, 'settings');
  await tx.done;
  return next;
}

export async function getFlag(key: string): Promise<unknown> {
  return (await db()).get('kv', key);
}

export async function setFlag(key: string, value: unknown) {
  await (await db()).put('kv', value, key);
}

// ---------- characters ----------

export async function listCharacters(): Promise<CharacterRow[]> {
  return (await (await db()).getAll('characters')).sort(byName);
}

export async function getCharacter(id: number): Promise<CharacterRow | undefined> {
  return (await db()).get('characters', id);
}

export async function insertCharacter(
  name: string,
  card: CharacterCard,
  avatar: string | null = null,
  createdAt = Date.now(),
): Promise<CharacterRow> {
  const row = { name, avatar, card, created_at: createdAt };
  const id = await (await db()).add('characters', row as CharacterRow);
  return { ...row, id };
}

export async function updateCharacter(
  id: number,
  patch: Partial<Omit<CharacterRow, 'id'>>,
): Promise<CharacterRow | undefined> {
  const d = await db();
  const tx = d.transaction('characters', 'readwrite');
  const row = await tx.store.get(id);
  if (!row) return undefined;
  const next = { ...row, ...patch, id };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** The character, their chats and everything in them. Images are left to the caller. */
export async function deleteCharacter(id: number) {
  const d = await db();
  const chatIds = await d.getAllKeysFromIndex('chats', 'character_id', id);
  const tx = d.transaction(['characters', ...CHAT_STORES], 'readwrite');
  await tx.objectStore('characters').delete(id);
  for (const chatId of chatIds) await dropChat(tx as unknown as ChatTx, chatId);
  await tx.done;
}

// ---------- chats ----------

type ChatTx = IDBPTransaction<FabledDB, StoreName[], 'readwrite'>;

/** Delete one chat and all that hangs off it, inside an open transaction. */
async function dropChat(tx: ChatTx, chatId: number) {
  await tx.objectStore('chats').delete(chatId);
  const messages = tx.objectStore('messages');
  for (const key of await messages.index('chat_id').getAllKeys(chatId)) await messages.delete(key);
  const records = tx.objectStore('records');
  for (const key of await records.index('chat_id').getAllKeys(chatId)) await records.delete(key);
  await tx.objectStore('memory').delete(chatId);
  await tx.objectStore('lore_state').delete(chatId);
  await tx.objectStore('adventure').delete(chatId);
}

async function withCount(chat: ChatRow): Promise<Chat> {
  return { ...chat, message_count: await (await db()).countFromIndex('messages', 'chat_id', chat.id) };
}

/** Chats for one character, newest first. */
export async function listChats(characterId: number): Promise<Chat[]> {
  const rows = await (await db()).getAllFromIndex('chats', 'character_id', characterId);
  rows.sort((a, b) => b.id - a.id);
  return Promise.all(rows.map(withCount));
}

/** How many chats each character has. */
export async function chatCounts(): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  for (const chat of await (await db()).getAll('chats')) {
    counts[chat.character_id] = (counts[chat.character_id] ?? 0) + 1;
  }
  return counts;
}

export async function getChat(id: number): Promise<Chat | undefined> {
  const row = await (await db()).get('chats', id);
  return row && withCount(row);
}

export async function updateChat(id: number, patch: Partial<Omit<ChatRow, 'id'>>): Promise<Chat | undefined> {
  const d = await db();
  const tx = d.transaction('chats', 'readwrite');
  const row = await tx.store.get(id);
  if (!row) return undefined;
  const next = { ...row, ...patch, id };
  await tx.store.put(next);
  await tx.done;
  return withCount(next);
}

export async function insertChat(
  characterId: number,
  title: string,
  createdAt = Date.now(),
  branchedFrom?: number,
  extra: Pick<ChatRow, 'adventure' | 'directorStyle'> = {},
): Promise<Chat> {
  const row = {
    character_id: characterId,
    title,
    created_at: createdAt,
    ...(branchedFrom ? { branched_from: branchedFrom } : {}),
    ...extra,
  };
  const id = await (await db()).add('chats', row as ChatRow);
  return { ...row, id, message_count: 0 };
}

export async function deleteChat(id: number) {
  const d = await db();
  const tx = d.transaction(CHAT_STORES, 'readwrite');
  await dropChat(tx as unknown as ChatTx, id);
  await tx.done;
}

// ---------- chat memory ----------

export const EMPTY_MEMORY: ChatMemory = { version: 1, summary: '', coveredThrough: 0, folds: 0, updatedAt: 0 };

/** Built field by field, so anything stale in an older record is dropped on the next save. */
export async function getMemory(chatId: number): Promise<ChatMemory> {
  const saved: Partial<ChatMemory> = (await (await db()).get('memory', chatId)) ?? {};
  return {
    version: 1,
    summary: typeof saved.summary === 'string' ? saved.summary : '',
    coveredThrough: typeof saved.coveredThrough === 'number' ? saved.coveredThrough : 0,
    folds: typeof saved.folds === 'number' ? saved.folds : 0,
    updatedAt: typeof saved.updatedAt === 'number' ? saved.updatedAt : 0,
  };
}

export async function saveMemory(chatId: number, memory: ChatMemory) {
  const { summary, coveredThrough, folds } = memory;
  await (await db()).put('memory', { chat_id: chatId, version: 1, summary, coveredThrough, folds, updatedAt: Date.now() });
}

export async function clearMemory(chatId: number): Promise<ChatMemory> {
  await (await db()).delete('memory', chatId);
  return getMemory(chatId);
}

// ---------- adventure state ----------

export async function getAdventureState(chatId: number): Promise<AdventureState> {
  const saved: Partial<AdventureState> = (await (await db()).get('adventure', chatId)) ?? {};
  return {
    text: typeof saved.text === 'string' ? saved.text : '',
    updatedAt: typeof saved.updatedAt === 'number' ? saved.updatedAt : 0,
  };
}

export async function saveAdventureState(chatId: number, text: string) {
  await (await db()).put('adventure', { chat_id: chatId, text, updatedAt: Date.now() });
}

// ---------- lorebooks ----------

export async function listLorebooks(): Promise<Lorebook[]> {
  return (await (await db()).getAll('lorebooks')).sort(byName);
}

export async function getLorebook(id: number): Promise<Lorebook | undefined> {
  return (await db()).get('lorebooks', id);
}

export async function insertLorebook(book: Omit<Lorebook, 'id' | 'created_at'>): Promise<Lorebook> {
  const row = { ...withoutId(book as Lorebook), created_at: Date.now() };
  const id = await (await db()).add('lorebooks', row as Lorebook);
  return { ...row, id };
}

export async function updateLorebook(id: number, patch: Partial<Omit<Lorebook, 'id'>>): Promise<Lorebook | undefined> {
  const d = await db();
  const tx = d.transaction('lorebooks', 'readwrite');
  const row = await tx.store.get(id);
  if (!row) return undefined;
  const next = { ...row, ...patch, id };
  await tx.store.put(next);
  await tx.done;
  return next;
}

export async function deleteLorebook(id: number) {
  await (await db()).delete('lorebooks', id);
}

/** Timed lorebook state for one chat: which entries are sticky or cooling down. */
export async function getLoreState(chatId: number): Promise<LoreState> {
  return (await (await db()).get('lore_state', chatId))?.state ?? {};
}

export async function saveLoreState(chatId: number, state: LoreState) {
  await (await db()).put('lore_state', { chat_id: chatId, state });
}

// ---------- generation records ----------

/** The prompt and reasoning behind one swipe, or undefined if nothing was kept. */
export async function getRecord(
  messageId: number,
  swipe: number,
): Promise<Pick<RecordRow, 'prompt' | 'reasoning' | 'direction'> | undefined> {
  const row = await (await db()).get('records', [messageId, swipe]);
  return row && { prompt: row.prompt, reasoning: row.reasoning, direction: row.direction };
}

/** The meta as it is kept on the message: everything except the bulky fields. */
function withoutBulk(meta: GenerationMeta | null | undefined): GenerationMeta | null {
  if (!meta) return null;
  const { prompt: _prompt, reasoning: _reasoning, direction: _direction, ...rest } = meta;
  return rest;
}

/** The bulky fields of a meta, or null when it has none to keep. */
function recordOf(meta: GenerationMeta | null | undefined) {
  if (!meta?.prompt && !meta?.reasoning && !meta?.direction) return null;
  return { prompt: meta.prompt, reasoning: meta.reasoning, direction: meta.direction };
}

// ---------- messages ----------

function alignMeta(row: Message): Message {
  const meta = Array.isArray(row.meta) ? row.meta : [];
  return { ...row, meta: row.swipes.map((_, i) => meta[i] ?? null) };
}

/** Oldest first: ids only ever grow. */
export async function listMessages(chatId: number): Promise<Message[]> {
  return (await (await db()).getAllFromIndex('messages', 'chat_id', chatId)).map(alignMeta);
}

export async function getMessage(id: number): Promise<Message | undefined> {
  const row = await (await db()).get('messages', id);
  return row && alignMeta(row);
}

export async function insertMessage(
  chatId: number,
  role: MessageRole,
  swipes: string[],
  meta: (GenerationMeta | null)[] = [],
  createdAt = Date.now(),
  swipeIndex = 0,
): Promise<Message> {
  const d = await db();
  const tx = d.transaction(['messages', 'records'], 'readwrite');
  const row = {
    chat_id: chatId,
    role,
    swipes,
    meta: swipes.map((_, i) => withoutBulk(meta[i])),
    swipe_index: Math.min(Math.max(0, swipeIndex), Math.max(0, swipes.length - 1)),
    created_at: createdAt,
  };
  const id = await tx.objectStore('messages').add(row as Message);
  for (const [i, m] of meta.entries()) {
    const record = recordOf(m);
    if (record) await tx.objectStore('records').put({ message_id: id, swipe: i, chat_id: chatId, ...record });
  }
  await tx.done;
  return alignMeta({ ...row, id });
}

/** Replace a message's texts, and the records of any swipe that carries fresh ones. */
export async function saveSwipes(id: number, swipes: string[], meta: (GenerationMeta | null)[], swipeIndex: number) {
  const d = await db();
  const tx = d.transaction(['messages', 'records'], 'readwrite');
  const row = await tx.objectStore('messages').get(id);
  if (!row) return;
  await tx.objectStore('messages').put({
    ...row,
    swipes,
    meta: swipes.map((_, i) => withoutBulk(meta[i])),
    swipe_index: swipeIndex,
  });
  const records = tx.objectStore('records');
  for (const key of await records.index('message_id').getAllKeys(id)) {
    if (key[1] >= swipes.length) await records.delete(key); // swipes that no longer exist
  }
  for (const [i, m] of meta.entries()) {
    const record = recordOf(m);
    if (record) await records.put({ message_id: id, swipe: i, chat_id: row.chat_id, ...record });
  }
  await tx.done;
}

/** Remove several messages from one chat at once. Returns how many went. */
export async function deleteMessages(chatId: number, ids: number[]): Promise<number> {
  const d = await db();
  const tx = d.transaction(['messages', 'records'], 'readwrite');
  let removed = 0;
  for (const id of new Set(ids)) {
    const row = await tx.objectStore('messages').get(id);
    if (!row || row.chat_id !== chatId) continue;
    await tx.objectStore('messages').delete(id);
    for (const key of await tx.objectStore('records').index('message_id').getAllKeys(id)) {
      await tx.objectStore('records').delete(key);
    }
    removed++;
  }
  await tx.done;
  return removed;
}

export async function deleteMessage(id: number) {
  const row = await getMessage(id);
  if (row) await deleteMessages(row.chat_id, [id]);
}

// ---------- images ----------

export async function putImage(blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await (await db()).put('images', { id, type: blob.type || 'application/octet-stream', data: await blob.arrayBuffer() });
  return id;
}

export async function getImage(id: string): Promise<Blob | undefined> {
  const row = await (await db()).get('images', id);
  return row && new Blob([row.data], { type: row.type });
}

export async function deleteImage(id: string | null | undefined) {
  if (id) await (await db()).delete('images', id);
}

// ---------- backups ----------

export const BACKUP_FORMAT = 'fabled-backup';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: number;
  settings: Partial<Settings>;
  characters: CharacterRow[];
  chats: ChatRow[];
  messages: Message[];
  records: RecordRow[];
  memory: (ChatMemory & { chat_id: number })[];
  lore_state: { chat_id: number; state: LoreState }[];
  /** Missing from backups made before adventure mode. */
  adventure?: (AdventureState & { chat_id: number })[];
  lorebooks: Lorebook[];
  images: { id: string; type: string; base64: string }[];
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Everything, as one plain object. The API key is left out unless asked for. */
export async function exportBackup({ includeApiKey = false } = {}): Promise<Backup> {
  const d = await db();
  const settings: Partial<Settings> = await getSettings();
  if (!includeApiKey) delete settings.apiKey;
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: Date.now(),
    settings,
    characters: await d.getAll('characters'),
    chats: await d.getAll('chats'),
    messages: await d.getAll('messages'),
    records: await d.getAll('records'),
    memory: await d.getAll('memory'),
    lore_state: await d.getAll('lore_state'),
    adventure: await d.getAll('adventure'),
    lorebooks: await d.getAll('lorebooks'),
    images: (await d.getAll('images')).map((img) => ({ id: img.id, type: img.type, base64: toBase64(img.data) })),
  };
}

/**
 * Replace everything with a backup, in one transaction: it all lands or none of
 * it does. A backup without a key keeps the key this browser already has.
 */
export async function importBackup(raw: unknown) {
  const b = raw as Partial<Backup>;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('This is not a Fabled backup file.');
  if (b.version !== 1) throw new Error('This backup comes from a newer version of Fabled.');
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);

  const current = await getSettings();
  const settings = cleanSettings(DEFAULT_SETTINGS, (b.settings ?? {}) as Record<string, unknown>);
  if (!b.settings?.apiKey) settings.apiKey = current.apiKey;

  const d = await db();
  const tx = d.transaction(STORES, 'readwrite');
  for (const name of STORES) await tx.objectStore(name).clear();
  await tx.objectStore('kv').put(settings, 'settings');
  await tx.objectStore('kv').put(true, 'seeded');
  for (const row of list(b.characters)) await tx.objectStore('characters').put(row);
  for (const row of list(b.chats)) await tx.objectStore('chats').put(row);
  for (const row of list(b.messages)) await tx.objectStore('messages').put(row);
  for (const row of list(b.records)) await tx.objectStore('records').put(row);
  for (const row of list(b.memory)) await tx.objectStore('memory').put(row);
  for (const row of list(b.lore_state)) await tx.objectStore('lore_state').put(row);
  for (const row of list(b.adventure)) await tx.objectStore('adventure').put(row);
  for (const row of list(b.lorebooks)) await tx.objectStore('lorebooks').put(row);
  for (const img of list(b.images)) {
    await tx.objectStore('images').put({ id: img.id, type: img.type, data: fromBase64(img.base64) });
  }
  await tx.done;
}
