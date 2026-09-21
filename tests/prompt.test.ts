import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMacros, buildPrompt, estimateTokens } from '../web/core/prompt.ts';
import type { Settings } from '../web/types.ts';
import type { CharacterCard } from '../web/core/cards.ts';

const settings = (over: Partial<Settings> = {}): Settings => ({
  apiBase: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'test-model',
  userName: 'Kai',
  userDescription: '',
  userAvatar: '',
  systemPrompt: 'You are {{char}} talking to {{user}}.',
  temperature: 1,
  maxTokens: 100,
  contextSize: 4096,
  thinkingLevel: 'default',
  promptFormat: 'none',
  memoryTokens: 800,
  messageBubbles: true,
  chatBackground: '',
  chatBackgroundDim: 60,
  spriteMode: false,
  ...over,
});

const card = (over: Partial<CharacterCard> = {}): CharacterCard => ({
  name: 'Lyra',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  creator_notes: '',
  creator: '',
  tags: [],
  ...over,
});

// Roughly the length of a real roleplay message, so budget maths is exercised.
const history = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message number ${i}. ${'padding words to make this realistic. '.repeat(3)}`.trim(),
  }));

test('macros replace both the modern and legacy spellings', () => {
  assert.equal(applyMacros('{{char}} and {{user}}', 'Lyra', 'Kai'), 'Lyra and Kai');
  assert.equal(applyMacros('<BOT> and <USER>', 'Lyra', 'Kai'), 'Lyra and Kai');
  assert.equal(applyMacros('{{CHAR}} {{User}}', 'Lyra', 'Kai'), 'Lyra Kai');
});

test('the default system prompt is used, with macros applied', () => {
  const { messages, systemSource } = buildPrompt(card(), settings(), []);
  assert.equal(systemSource, 'default');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'You are Lyra talking to Kai.');
});

test("a card's own system prompt replaces the default", () => {
  const { messages, systemSource, usedOriginalMacro } = buildPrompt(
    card({ system_prompt: 'Card rules for {{char}}.' }),
    settings(),
    [],
  );
  assert.equal(systemSource, 'card');
  assert.equal(usedOriginalMacro, false);
  assert.equal(messages[0].content, 'Card rules for Lyra.');
  assert.ok(!messages[0].content.includes('talking to'), 'the default should be gone');
});

test('{{original}} folds the default prompt into the card prompt', () => {
  const { messages, usedOriginalMacro } = buildPrompt(
    card({ system_prompt: 'Before. {{original}} After.' }),
    settings(),
    [],
  );
  assert.equal(usedOriginalMacro, true);
  assert.equal(messages[0].content, 'Before. You are Lyra talking to Kai. After.');
});

test('the user persona is included only when it is set', () => {
  const without = buildPrompt(card(), settings(), []);
  assert.ok(!without.messages[0].content.includes('<user'), 'no persona, no tag');

  const withPersona = buildPrompt(card(), settings({ userDescription: 'A tired cartographer.' }), []);
  assert.match(withPersona.messages[0].content, /<user name="Kai">\nA tired cartographer\.\n<\/user>/);
});

test('whitespace-only persona counts as empty', () => {
  const { messages } = buildPrompt(card(), settings({ userDescription: '   \n  ' }), []);
  assert.ok(!messages[0].content.includes('<user'));
});

test('post-history instructions come last, after the conversation', () => {
  const { messages, hasPostHistory } = buildPrompt(
    card({ post_history_instructions: 'Stay in character.' }),
    settings(),
    history(2),
  );
  assert.equal(hasPostHistory, true);
  assert.equal(messages.at(-1)?.role, 'system');
  assert.equal(messages.at(-1)?.content, 'Stay in character.');
  assert.ok(messages.at(-2)?.content.startsWith('message number 1.'));
});

test('everything fits when the window is roomy', () => {
  const { usedHistory, messages } = buildPrompt(card(), settings({ contextSize: 100_000 }), history(20));
  assert.equal(usedHistory, 20);
  assert.equal(messages.length, 21); // system + history
});

test('a tight window drops the oldest messages and keeps the newest', () => {
  const all = history(40);
  const { messages, usedHistory, historyBudget } = buildPrompt(card(), settings({ contextSize: 512 }), all);

  assert.ok(usedHistory > 0 && usedHistory < 40, `expected a partial window, kept ${usedHistory}`);
  assert.ok(messages.at(-1)?.content.startsWith('message number 39.'), 'the newest message must survive');
  assert.ok(!messages.some((m) => m.content.startsWith('message number 0.')), 'the oldest must be dropped');

  const kept = messages.slice(1);
  const cost = kept.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.ok(cost <= historyBudget, `kept ${cost} tokens of a ${historyBudget} budget`);
});

test('a system prompt larger than the window keeps no history instead of crashing', () => {
  const { messages, usedHistory, historyBudget } = buildPrompt(
    card({ description: 'x'.repeat(20_000) }),
    settings({ contextSize: 1024 }),
    history(10),
  );
  assert.equal(usedHistory, 0);
  assert.ok(historyBudget < 0);
  assert.equal(messages.length, 1, 'the system message is still sent');
});

const memory = (over: Partial<import('../web/types.ts').ChatMemory> = {}) => ({
  version: 1 as const,
  summary: 'Kai admitted forging the eastern coastline map.',
  coveredThrough: 10,
  folds: 1,
  updatedAt: 0,
  ...over,
});

test('memory is sent as its own block, after the character and before the history', () => {
  const { messages, memoryTokens } = buildPrompt(card(), settings(), history(2), memory());
  assert.equal(messages[1].role, 'system');
  assert.match(messages[1].content, /<memory>[\s\S]*forging the eastern coastline[\s\S]*<\/memory>/);
  assert.ok(memoryTokens > 0);
  assert.ok(messages[2].content.startsWith('message number 0.'), 'history follows the memory block');
});

test('memory is paid for out of the history budget', () => {
  const plain = buildPrompt(card(), settings(), history(40));
  const remembered = buildPrompt(card(), settings(), history(40), memory());

  assert.equal(remembered.historyBudget, plain.historyBudget - remembered.memoryTokens);
  assert.ok(remembered.memoryTokens > 0);
});

test('memory is left out entirely when the budget is zero', () => {
  const { messages, memoryTokens } = buildPrompt(card(), settings({ memoryTokens: 0 }), history(2), memory());
  assert.equal(memoryTokens, 0);
  assert.ok(!messages.some((m) => m.content.includes('<memory>')));
});

test('empty memory sends no block', () => {
  const { messages, memoryTokens } = buildPrompt(card(), settings(), history(2), memory({ summary: '' }));
  assert.equal(memoryTokens, 0);
  assert.ok(!messages.some((m) => m.content.includes('<memory>')));
});

test('a summary larger than its budget is trimmed to fit rather than dropped', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about the map.`).join(' ');
  const { messages, memoryTokens } = buildPrompt(card(), settings({ memoryTokens: 120 }), [], memory({ summary: long }));

  assert.ok(memoryTokens > 0, 'something is still remembered');
  assert.ok(memoryTokens <= 120, `memory used ${memoryTokens} of a 120 budget`);
  const block = messages.find((m) => m.content.includes('<memory>'))!;
  assert.ok(block.content.includes('Sentence number 199'), 'the most recent part is the part kept');
});

test('a budget too small for any block sends none', () => {
  const { messages, memoryTokens } = buildPrompt(card(), settings({ memoryTokens: 8 }), [], memory());
  assert.equal(memoryTokens, 0);
  assert.ok(!messages.some((m) => m.content.includes('<memory>')));
});

test('macros are applied inside remembered text', () => {
  const { messages } = buildPrompt(card(), settings(), [], memory({ summary: '{{user}} lied to {{char}}.' }));
  assert.match(messages[1].content, /Kai lied to Lyra\./);
});

test('card sections appear in a stable order', () => {
  const { messages } = buildPrompt(
    card({ description: 'A mapmaker.', personality: 'Wry.', scenario: 'An archive.', mes_example: 'A: hi' }),
    settings({ userDescription: 'A traveller.' }),
    [],
  );
  const text = messages[0].content;
  const order = ['<character', "Lyra's personality", '<user', 'Scenario:', 'Example dialogue'].map((s) =>
    text.indexOf(s),
  );
  assert.ok(
    order.every((pos, i) => pos > -1 && (i === 0 || pos > order[i - 1])),
    `sections out of order: ${order.join(', ')}`,
  );
});
