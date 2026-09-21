export interface CharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  creator_notes: string;
  creator: string;
  tags: string[];
}

export interface Character {
  id: number;
  name: string;
  /** Id of the picture in the browser's image store. */
  avatar: string | null;
  /**
   * Full-size pictures for sprite mode, by expression. Only `neutral` is used
   * for now; the others are room for expressions later.
   */
  sprites: Record<string, string>;
  card: CharacterCard;
  created_at?: number;
  /** How many chats you have with them. */
  chats?: number;
  /** Only on import: the lorebook that came inside the card, if any. */
  lorebook?: { name: string; entries: number };
}

export interface Chat {
  id: number;
  character_id: number;
  title: string;
  created_at: number;
  message_count?: number;
  branched_from?: number;
}

export interface VisionCheck {
  vision: boolean;
  reason?: string;
}

export interface ConnectionTest {
  model?: string;
  reply: string;
  usage?: TokenUsage;
  finishReason?: string;
  ms: number;
}

export type EntryMode = 'constant' | 'selective';
export type SecondaryLogic = 'and_any' | 'and_all' | 'not_any' | 'not_all';
export type EntryPosition = 'before_char' | 'after_char' | 'at_depth';
export type EntryRole = 'system' | 'user' | 'assistant';

export interface LoreEntry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  mode: EntryMode;
  keys: string[];
  secondaryKeys: string[];
  logic: SecondaryLogic;
  position: EntryPosition;
  depth: number;
  role: EntryRole;
  order: number;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  scanDepth: number | null;
  probability: number;
  group: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
}

export interface Lorebook {
  id: number;
  name: string;
  enabled: boolean;
  characterIds: number[];
  scanDepth: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  maxRecursionSteps: number;
  budget: number;
  entries: LoreEntry[];
  created_at: number;
}

export interface ChatMemory {
  version: 1;
  summary: string;
  coveredThrough: number;
  folds: number;
  updatedAt: number;
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * What happened when one reply was generated, kept per swipe.
 * `prompt` is only present on records fetched with api.getMessageMeta().
 */
export interface GenerationMeta {
  status: 'ok' | 'stopped' | 'error';
  error?: string;
  createdAt: number;
  edited?: boolean;

  provider: string;
  modelRequested: string;
  modelReported?: string;
  temperature: number;
  maxTokens: number;
  contextSize: number;
  thinkingLevel: ThinkingLevel;
  extrasDropped?: boolean;
  promptFormat?: PromptFormat;
  memoryTokens?: number;
  loreTokens?: number;
  loreEntries?: number;
  loreTitles?: string[];

  prompt?: PromptMessage[];
  systemSource: 'card' | 'default';
  usedOriginalMacro: boolean;
  hasPostHistory: boolean;
  historyTotal: number;
  historySent: number;
  historyBudget: number;
  estimatedPromptTokens: number;

  finishReason?: string;
  usage?: TokenUsage;
  /** Only present on a record fetched with api.getMessageMeta(). */
  reasoning?: string;
  reasoningChars?: number;
  outputChars: number;
  estimatedCompletionTokens: number;
  msToFirstToken?: number;
  msTotal: number;
}

export interface Message {
  id: number;
  chat_id: number;
  role: 'user' | 'assistant';
  swipes: string[];
  /** Parallel to swipes; null for greetings and anything not generated here. */
  meta: (GenerationMeta | null)[];
  swipe_index: number;
  created_at: number;
}

export type ThinkingLevel = 'default' | 'low' | 'medium' | 'high';
export type PromptFormat = 'none' | 'merge' | 'semi' | 'strict' | 'single';

export interface Settings {
  apiBase: string;
  model: string;
  userName: string;
  userDescription: string;
  userAvatar: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  contextSize: number;
  thinkingLevel: ThinkingLevel;
  promptFormat: PromptFormat;
  memoryTokens: number;
  messageBubbles: boolean;
  chatBackground: string;
  chatBackgroundDim: number;
  /** Show the character's sprite large, with the chat in a panel below it. */
  spriteMode: boolean;
  /** Kept in this browser only, and sent nowhere but the provider. */
  apiKey: string;
}
