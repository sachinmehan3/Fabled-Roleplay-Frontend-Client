# Fabled

A local-first roleplay chat frontend: the user chats with a character from a Tavern character card, optionally with lorebooks and chat memory.

## Adventure mode

**Adventure mode**:
A per-chat mode where two models share each turn: the Director decides what happens, then the Narrator writes it.
_Avoid_: Game mode, dual-model mode

**Narrator**:
The model that writes the story prose in an adventure, voicing the chat's character card. It is the only model whose output the user reads as story.
_Avoid_: Roleplayer, RP model

**Director**:
The model that keeps an adventure consistent and moving: it rules on what the user's actions can achieve, introduces new characters, and advances the plot. It never writes story prose itself.
_Avoid_: Manager, GM, Game Master

**Direction**:
The Director's hidden instructions for one Narrator reply: the outcome of the user's action and anything new that should happen. Kept with the reply it steered and never shown in the chat.
_Avoid_: Directive, hint, guidance

**Adventure State**:
The Director's per-chat notes on the story so far: the cast it has introduced, open threads and plans, and world rules established in play. The user can read and edit it; the Narrator sees only the cast.
_Avoid_: World state, story ledger, director memory (chat memory is a different thing)

**Director Style**:
How much the Director intervenes in a chat: Referee (only rules on what actions can achieve), Balanced (adds events when the scene stalls), or Active (keeps pressure on).
_Avoid_: Intensity, pacing, difficulty

**Director Note**:
A message the user addresses only to the Director (typed with a `/d ` prefix) to suggest a turn of events. It is visible in the chat but never shown to the Narrator.
_Avoid_: Suggestion, OOC message, manager message
