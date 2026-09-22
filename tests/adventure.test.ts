// Adventure mode, tested through the turn pipeline: the api and generate(),
// against an in-memory database, with the network replaced by a script.
import 'fake-indexeddb/auto';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterCard } from '../web/types.ts';
import { api, generate } from '../web/api.ts';
import * as store from '../web/core/db.ts';

const card = (over: Partial<CharacterCard> = {}): CharacterCard => ({
  name: 'Elara',
  description: 'A ranger who knows the old forest.',
  personality: '',
  scenario: 'The two of you travel the Greywood.',
  first_mes: 'Elara waves you over to the fire.',
  mes_example: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  creator_notes: '',
  creator: '',
  tags: [],
  ...over,
});

interface Sent {
  model: string;
  stream: boolean;
  temperature: number;
  messages: { role: string; content: string }[];
}

/** What the fake provider received and what it will answer next. */
const net = {
  sent: [] as Sent[],
  /** Replies to non-streaming (Director) calls, in order. A string, or an HTTP status to fail with. */
  director: [] as (string | number)[],
  /** Replies to streaming (Narrator) calls, in order. A string, or an HTTP status to fail with. */
  narrator: [] as (string | number)[],
};

const realFetch = globalThis.fetch;

function sse(text: string): Response {
  const chunks = [
    `data: ${JSON.stringify({ model: 'narrator-model', choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(async () => {
  await store.resetDatabase();
  net.sent = [];
  net.director = [];
  net.narrator = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw new DOMException('The user pressed Stop', 'AbortError');
    const body = JSON.parse(String(init.body)) as Sent;
    net.sent.push(body);
    if (body.stream) {
      const reply = net.narrator.shift() ?? 'The forest is quiet.';
      if (typeof reply === 'number') return new Response('{"error":{"message":"boom"}}', { status: reply });
      return sse(reply);
    }
    const next = net.director.shift() ?? '<direction>Nothing to add.</direction>';
    if (typeof next === 'number') return new Response('{"error":{"message":"boom"}}', { status: next });
    return Response.json({ model: body.model, choices: [{ message: { content: next }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  await store.saveSettings({ model: 'narrator-model', apiBase: 'http://127.0.0.1/v1' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const handlers = () => ({ onDelta: () => {}, signal: new AbortController().signal });

/** A chat with Elara, already greeted, with adventure mode as asked. */
async function startChat({ adventure = true } = {}) {
  const character = await api.createCharacter(card());
  const chat = await api.createChat(character.id);
  if (adventure) await api.updateAdventure(chat.id, { adventure: true });
  return chat;
}

const narratorCalls = () => net.sent.filter((s) => s.stream);
const directorCalls = () => net.sent.filter((s) => !s.stream);
const promptText = (s: Sent) => s.messages.map((m) => m.content).join('\n\n');

test('in adventure mode the Direction reaches the Narrator', async () => {
  const chat = await startChat();
  net.director.push('<direction>The lock holds. A guard is coming.</direction>');
  await api.sendMessage(chat.id, 'I pick the lock.');
  await generate(chat.id, 'new', handlers());

  assert.equal(directorCalls().length, 1);
  assert.equal(narratorCalls().length, 1);
  assert.match(promptText(narratorCalls()[0]), /The lock holds\. A guard is coming\./);
});

test('with adventure mode off, a turn is one request, as before', async () => {
  const chat = await startChat({ adventure: false });
  await api.sendMessage(chat.id, 'I pick the lock.');
  await generate(chat.id, 'new', handlers());

  assert.equal(net.sent.length, 1);
  assert.equal(narratorCalls().length, 1);
  assert.doesNotMatch(promptText(narratorCalls()[0]), /<direction>/);
});

test('a Director Note goes to the Director and never to the Narrator', async () => {
  const chat = await startChat();
  const note = await api.sendMessage(chat.id, '/d just then they heard something behind the bushes');
  assert.equal(note.role, 'note');
  assert.equal(note.swipes[0], 'just then they heard something behind the bushes');

  net.director.push('<direction>A fox bursts out of the bushes.</direction>');
  const reply = await generate(chat.id, 'new', handlers());

  assert.match(promptText(directorCalls()[0]), /something behind the bushes/);
  const narrator = promptText(narratorCalls()[0]);
  assert.doesNotMatch(narrator, /something behind the bushes/);
  assert.match(narrator, /A fox bursts out of the bushes\./);
  assert.equal(reply?.role, 'assistant');
});

test('a Director Note is refused when adventure mode is off', async () => {
  const chat = await startChat({ adventure: false });
  await assert.rejects(api.sendMessage(chat.id, '/d a storm rolls in'), /Adventure mode is off/);
  assert.equal((await api.listMessages(chat.id)).length, 1); // just the greeting
});

test('Director Notes stay out of the Narrator prompt on later turns too', async () => {
  const chat = await startChat();
  await api.sendMessage(chat.id, '/d a storm rolls in');
  await generate(chat.id, 'new', handlers());
  await api.sendMessage(chat.id, 'I look for shelter.');
  await generate(chat.id, 'new', handlers());

  assert.doesNotMatch(promptText(narratorCalls()[1]), /a storm rolls in/);
});

test('a swipe keeps the Direction and only rewrites the prose', async () => {
  const chat = await startChat();
  net.director.push('<direction>The lock holds.</direction>');
  await api.sendMessage(chat.id, 'I pick the lock.');
  const first = await generate(chat.id, 'new', handlers());
  const swiped = await generate(chat.id, 'swipe', handlers());

  assert.equal(directorCalls().length, 1);
  assert.match(promptText(narratorCalls()[1]), /The lock holds\./);
  assert.equal(swiped?.id, first?.id);
  assert.equal(swiped?.swipes.length, 2);
  assert.equal((await api.getMessageMeta(swiped!.id, 1)).direction, 'The lock holds.');
});

test('re-rolling the Direction asks the Director again and adds a version', async () => {
  const chat = await startChat();
  net.director.push('<direction>The lock holds.</direction>', '<direction>The lock clicks open.</direction>');
  await api.sendMessage(chat.id, 'I pick the lock.');
  const first = await generate(chat.id, 'new', handlers());
  const rerolled = await generate(chat.id, 'redirect', handlers(), first!.id);

  assert.equal(directorCalls().length, 2);
  assert.match(promptText(narratorCalls()[1]), /The lock clicks open\./);
  assert.doesNotMatch(promptText(narratorCalls()[1]), /The lock holds\./);
  assert.equal(rerolled?.swipes.length, 2);
  assert.equal(rerolled?.swipe_index, 1);
  assert.equal((await api.getMessageMeta(rerolled!.id, 1)).direction, 'The lock clicks open.');
});

test('the Direction behind a reply can be looked up', async () => {
  const chat = await startChat();
  await api.saveSettings({ directorModel: 'director-model', directorTemperature: 0.3 });
  net.director.push('Sure! <direction>A guard is coming.</direction> Hope that helps.');
  await api.sendMessage(chat.id, 'I wait.');
  const reply = await generate(chat.id, 'new', handlers());

  const meta = await api.getMessageMeta(reply!.id, 0);
  assert.equal(meta.direction, 'A guard is coming.');
  assert.equal(meta.directorModel, 'director-model');
  assert.equal(directorCalls()[0].model, 'director-model');
  assert.equal(directorCalls()[0].temperature, 0.3);
  assert.equal(narratorCalls()[0].model, 'narrator-model');
  // Kept apart from the chat log, like the prompt.
  assert.equal((await api.listMessages(chat.id)).at(-1)!.meta[0]?.direction, undefined);
});

test('when the Director fails on a message, the Narrator still replies, marked', async () => {
  const chat = await startChat();
  net.director.push(500);
  await api.sendMessage(chat.id, 'I pick the lock.');
  const reply = await generate(chat.id, 'new', handlers());

  assert.equal(narratorCalls().length, 1);
  assert.doesNotMatch(promptText(narratorCalls()[0]), /<direction>/);
  assert.match(reply!.meta[0]!.directorError!, /500/);
});

test('a Director reply without a Direction counts as a failure', async () => {
  const chat = await startChat();
  net.director.push('I think the lock should hold.');
  await api.sendMessage(chat.id, 'I pick the lock.');
  const reply = await generate(chat.id, 'new', handlers());

  assert.match(reply!.meta[0]!.directorError!, /direction/i);
});

test('when the Director fails on a Director Note, the turn stops', async () => {
  const chat = await startChat();
  net.director.push(500);
  await api.sendMessage(chat.id, '/d a storm rolls in');

  await assert.rejects(generate(chat.id, 'new', handlers()), /Director could not answer your note/);
  assert.equal(narratorCalls().length, 0);
  const log = await api.listMessages(chat.id);
  assert.equal(log.at(-1)!.role, 'note'); // the note stays
});

test('Stop while the Director is deciding ends the turn with nothing written', async () => {
  const chat = await startChat();
  await api.sendMessage(chat.id, 'I pick the lock.');
  const stop = new AbortController();
  stop.abort();
  const reply = await generate(chat.id, 'new', { onDelta: () => {}, signal: stop.signal });

  assert.equal(reply, undefined);
  assert.equal(narratorCalls().length, 0);
  assert.equal((await api.listMessages(chat.id)).at(-1)!.role, 'user');
});

const STATE = `Cast:
- Brann: a hooded stranger watching from the treeline
Threads:
- Brann is secretly hunting Elara; he strikes at the river
Rules:
- magic is rare and feared`;

test('the Director keeps the Adventure State, and the Narrator sees only the cast', async () => {
  const chat = await startChat();
  assert.equal((await api.getAdventureState(chat.id)).text, ''); // starts empty
  net.director.push(`<direction>Brann steps out of the trees.</direction>\n<state>\n${STATE}\n</state>`);
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());

  assert.equal((await api.getAdventureState(chat.id)).text, STATE);
  const narrator = promptText(narratorCalls()[0]);
  assert.match(narrator, /Brann: a hooded stranger/);
  assert.doesNotMatch(narrator, /secretly hunting/);
  assert.doesNotMatch(narrator, /magic is rare/);
});

test('a Director reply without a state leaves the Adventure State alone', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  net.director.push('<direction>Nothing to add.</direction>');
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());

  assert.equal((await api.getAdventureState(chat.id)).text, STATE);
});

test('the Director reads the Adventure State as the user left it', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());

  assert.match(promptText(directorCalls()[0]), /secretly hunting Elara/);
});

test('the Director sees its own recent Directions, so its plans carry through', async () => {
  const chat = await startChat();
  net.director.push('<direction>A raven circles overhead.</direction>');
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());
  await api.sendMessage(chat.id, 'I keep walking.');
  await generate(chat.id, 'new', handlers());

  assert.match(promptText(directorCalls()[1]), /A raven circles overhead\./);
});

test('the Director Style changes what the Director is told', async () => {
  const chat = await startChat();
  await api.updateAdventure(chat.id, { directorStyle: 'referee' });
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());

  assert.equal((await api.listChats((await store.getChat(chat.id))!.character_id))[0].directorStyle, 'referee');
  assert.match(promptText(directorCalls()[0]), /Style: referee/);
});

test('impersonate writes your message without asking the Director', async () => {
  const chat = await startChat();
  await generate(chat.id, 'impersonate', handlers());

  assert.equal(directorCalls().length, 0);
  assert.equal(narratorCalls().length, 1);
});

test('chat memory never sees a Director Note', async () => {
  const chat = await startChat();
  await api.sendMessage(chat.id, '/d a storm rolls in');
  await generate(chat.id, 'new', handlers());
  await api.sendMessage(chat.id, 'I look for shelter.');
  await generate(chat.id, 'new', handlers());

  net.director.push('Elara and User looked for shelter.'); // the summariser's answer
  await api.foldMemory(chat.id);
  const summariser = directorCalls().at(-1)!;
  assert.match(promptText(summariser), /Summary so far|no summary yet/);
  assert.doesNotMatch(promptText(summariser), /a storm rolls in/);
});

test('a branch carries on the same adventure', async () => {
  const chat = await startChat();
  await api.updateAdventure(chat.id, { directorStyle: 'active' });
  await api.saveAdventureState(chat.id, STATE);
  const greeting = (await api.listMessages(chat.id))[0];
  const branch = await api.branchChat(chat.id, greeting.id);

  assert.equal(branch.adventure, true);
  assert.equal(branch.directorStyle, 'active');
  assert.equal((await api.getAdventureState(branch.id)).text, STATE);
});

test('a backup restores the Adventure State and the chat settings', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  const backup = await api.exportBackup();
  await store.resetDatabase();
  await api.importBackup(new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));

  assert.equal((await api.getAdventureState(chat.id)).text, STATE);
  assert.equal((await store.getChat(chat.id))?.adventure, true);
});

test('switching adventure mode off goes back to one request, keeping the state', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  await api.updateAdventure(chat.id, { adventure: false });
  await api.sendMessage(chat.id, 'I look around.');
  await generate(chat.id, 'new', handlers());

  assert.equal(net.sent.length, 1);
  assert.equal((await api.getAdventureState(chat.id)).text, STATE);
});

test('re-rolling the Direction starts from the state before the rejected one', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, 'Cast:\n- Elara: your guide');
  net.director.push('<direction>Brann attacks.</direction>\n<state>Cast:\n- Brann: an enemy, now wounded</state>');
  await api.sendMessage(chat.id, 'I look around.');
  const reply = await generate(chat.id, 'new', handlers());
  await generate(chat.id, 'redirect', handlers(), reply!.id);

  const rerolled = promptText(directorCalls()[1]);
  assert.match(rerolled, /Elara: your guide/);
  assert.doesNotMatch(rerolled, /now wounded/);
});

test('when the Narrator writes nothing, the Adventure State does not move', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  net.director.push('<direction>Brann attacks.</direction>\n<state>Cast:\n- Brann: dead</state>');
  net.narrator.push(500);
  await api.sendMessage(chat.id, 'I look around.');
  await assert.rejects(generate(chat.id, 'new', handlers()));

  assert.equal((await api.getAdventureState(chat.id)).text, STATE);
});

test('the newest message reaches the Director even when it is over its budget', async () => {
  const chat = await startChat();
  await api.saveSettings({ directorTokens: 20 });
  await api.sendMessage(chat.id, `I tell Elara the whole story of the siege. ${'And then the walls fell. '.repeat(20)}`);
  await generate(chat.id, 'new', handlers());

  assert.match(promptText(directorCalls()[0]), /the whole story of the siege/);
});

test('the Adventure State can be cleared', async () => {
  const chat = await startChat();
  await api.saveAdventureState(chat.id, STATE);
  assert.equal((await api.clearAdventureState(chat.id)).text, '');
  assert.equal((await api.getAdventureState(chat.id)).text, '');
});
