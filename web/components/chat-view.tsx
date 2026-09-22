import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Brain, Compass, Ellipsis, PanelLeft, PersonStanding, Square, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, generate } from '@/api';
import type { Character, Chat, GenerationMeta, Message, Settings } from '@/types';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/hooks/use-confirm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CharacterAvatar } from '@/components/character-avatar';
import { useImageUrl } from '@/hooks/use-image-url';
import { MessageItem } from '@/components/message-item';
import { ProfileDialog } from '@/components/profile-dialog';
import { GenerationDialog } from '@/components/generation-dialog';
import { MemoryDialog } from '@/components/memory-dialog';
import { AdventureDialog } from '@/components/adventure-dialog';

interface Props {
  chatId: number;
  character: Character;
  settings: Settings;
  onMessagesChanged: () => void;
  onOpenSidebar: () => void;
  /** When the sidebar is collapsed the button that reopens it is shown at every width. */
  sidebarCollapsed: boolean;
  onEditCharacter: () => void;
  onEditUser: () => void;
  onBranched: (chatId: number) => void;
  onToggleSpriteMode: () => void;
}

type Mode = 'new' | 'swipe' | 'redo' | 'impersonate' | 'redirect';
type Streaming = {
  mode: Mode;
  text: string;
  reasoning: string;
  targetId?: number;
  /** Adventure mode: the Director is still deciding what happens. */
  directing?: boolean;
} | null;

/** A message that starts like this goes to the Director only. */
const NOTE_PREFIX = /^\s*\/d(?:\s|$)/i;

type Details = { messageId: number; swipeIndex: number; swipeCount: number; meta: GenerationMeta | null };

const applyMacros = (text: string, char: string, user: string) =>
  text.replace(/\{\{char\}\}|<BOT>/gi, char).replace(/\{\{user\}\}|<USER>/gi, user);

const errorToast = (e: unknown) => toast.error((e as Error).message);

export function ChatView({
  chatId,
  character,
  settings,
  onMessagesChanged,
  onOpenSidebar,
  sidebarCollapsed,
  onEditCharacter,
  onEditUser,
  onBranched,
  onToggleSpriteMode,
}: Props) {
  const confirm = useConfirm();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<Streaming>(null);
  const [input, setInput] = useState('');
  const [profile, setProfile] = useState<'character' | 'user' | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [adventureOpen, setAdventureOpen] = useState(false);
  const [chat, setChat] = useState<Chat | null>(null);
  /** Ids to delete, or null when not in delete mode. */
  const [selection, setSelection] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  // Phones only: the header slides away while you scroll down and comes back
  // as soon as you scroll up, so reading gets the whole screen.
  const [headerHidden, setHeaderHidden] = useState(false);
  const lastScrollTop = useRef(0);

  const reload = useCallback(async () => {
    setMessages(await api.listMessages(chatId));
  }, [chatId]);

  useEffect(() => {
    setChat(null);
    api.getChat(chatId).then(setChat).catch(errorToast);
  }, [chatId]);

  useEffect(() => {
    reload().catch(errorToast);
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, [reload]);

  // The box is one line until it needs more, for browsers that lack field-sizing.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    // Only scroll once it has actually grown as far as it may. Otherwise a
    // placeholder that wraps on a narrow screen leaves a scrollbar sitting in
    // an empty box.
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [input]);

  // Keep the view pinned to the newest message unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const runGeneration = async (mode: Mode, targetId?: number) => {
    const controller = new AbortController();
    abortRef.current = controller;
    // Rewriting something further up should not drag the view to the bottom.
    if (!targetId) stickToBottom.current = true;
    setStreaming({ mode, text: '', reasoning: '', targetId });
    try {
      const saved = await generate(
        chatId,
        mode,
        {
          signal: controller.signal,
          onDelta: (d) => setStreaming((s) => (s ? { ...s, text: s.text + d } : s)),
          onReasoning: (d) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + d } : s)),
          onPhase: (phase) => setStreaming((s) => (s ? { ...s, directing: phase === 'director' } : s)),
        },
        targetId,
      );
      const failed = saved?.meta[saved.swipe_index]?.directorError;
      if (failed) toast.warning('The Director could not answer', { description: `Written without a Direction: ${failed}` });
    } catch (e) {
      if (!controller.signal.aborted) errorToast(e);
    } finally {
      abortRef.current = null;
      await reload().catch(() => {});
      setStreaming(null);
      onMessagesChanged();
    }
  };

  const send = async () => {
    if (streaming) return;
    const text = input.trim();
    if (text && noteBlocked) return;
    try {
      if (text) {
        const msg = await api.sendMessage(chatId, text);
        setInput('');
        setMessages((m) => [...m, msg]);
      } else if (messages.at(-1)?.role === 'assistant' || !messages.length) {
        return; // nothing to reply to
      }
      await runGeneration('new');
    } catch (e) {
      errorToast(e);
    }
  };

  const swipe = async (msg: Message, dir: -1 | 1) => {
    const next = msg.swipe_index + dir;
    if (next < 0) return;
    if (next >= msg.swipes.length) {
      // Past the last version of any reply: ask for another beside it.
      if (msg.role === 'assistant') await runGeneration('swipe', msg.id);
      return;
    }
    const updated = await api.updateMessage(msg.id, { swipe_index: next });
    setMessages((ms) => ms.map((m) => (m.id === msg.id ? updated : m)));
  };

  const edit = async (msg: Message, content: string) => {
    const updated = await api.updateMessage(msg.id, { content });
    setMessages((ms) => ms.map((m) => (m.id === msg.id ? updated : m)));
  };

  /**
   * Throw the last reply away and answer again, rather than adding a version
   * beside it. With no reply to replace - it was deleted, or never came - this
   * simply answers the message that is waiting.
   */
  const regenerate = async (msg?: Message) => {
    if (streaming) return;
    const target = msg ?? messages.at(-1);
    if (!target) return;
    // A reply is rewritten in place; a message of yours is simply answered.
    if (target.role === 'assistant') await runGeneration('redo', target.id);
    else if (target.id === messages.at(-1)?.id) await runGeneration('new');
  };

  /**
   * Picking a message takes it and everything after it: a reply only makes
   * sense in the light of what came before, so leaving the tail behind would
   * leave the conversation talking about something that no longer happened.
   */
  const selectFrom = (msg: Message) => {
    const at = messages.findIndex((m) => m.id === msg.id);
    if (at === -1) return;
    setSelection((current) => (current?.[0] === msg.id ? [] : messages.slice(at).map((m) => m.id)));
  };

  const deleteSelected = async () => {
    const ids = selection ?? [];
    if (!ids.length) return;
    const ok = await confirm({
      title: ids.length === 1 ? 'Delete this message?' : `Delete ${ids.length} messages?`,
      description:
        ids.length === 1
          ? 'It is the last message in the chat.'
          : 'This message and everything after it will be permanently removed, along with every other version of them.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteMessages(chatId, ids);
    setSelection(null);
    await reload();
    onMessagesChanged();
  };

  const remove = async (msg: Message) => {
    const ok = await confirm({
      title: 'Delete this message?',
      description: msg.swipes.length > 1 ? `All ${msg.swipes.length} versions of this message will be removed.` : undefined,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteMessage(msg.id);
    setMessages((ms) => ms.filter((m) => m.id !== msg.id));
    onMessagesChanged();
  };

  const safe =
    <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
    (...a: A) => {
      fn(...a).catch(errorToast);
    };

  const last = messages.at(-1);
  // Either there is a reply to replace, or a message of yours waiting for one.
  const canRegenerate = !streaming && messages.length > 0;

  // Ctrl/Cmd + Enter regenerates the last reply. The composer handles its own
  // keydown; this covers the rest of the page without stealing the shortcut
  // from a message being edited, or from anything open in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="alertdialog"]')) return;
      if (!canRegenerate) return;
      e.preventDefault();
      safe(regenerate)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const macros = (t: string) => applyMacros(t, character.name, settings.userName);
  const { card } = character;
  const userAvatar = settings.userAvatar || null;
  const background = useImageUrl(settings.chatBackground);
  const sprite = useImageUrl(character.sprites.neutral);
  // Decided by whether a sprite exists rather than whether it has loaded, so
  // the layout doesn't jump once the picture arrives.
  const spriteMode = settings.spriteMode && !!character.sprites.neutral;
  const adventure = !!chat?.adventure;
  const isNote = NOTE_PREFIX.test(input);
  const noteBlocked = isNote && !adventure;
  const canSend = (!!input.trim() && !noteBlocked) || (!!last && last.role !== 'assistant');
  const directingStatus = streaming?.directing ? 'The Director is deciding what happens…' : undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {background && (
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
          <img src={background} alt="" className="size-full object-cover" />
          <div className="bg-background absolute inset-0" style={{ opacity: settings.chatBackgroundDim / 100 }} />
        </div>
      )}
      {spriteMode && sprite && (
        // Stands on the bottom edge; the chat panel covers the lower part of it,
        // the way a visual novel's text box does.
        <div className="pointer-events-none absolute inset-x-0 top-12 bottom-0 z-0 flex justify-center" aria-hidden>
          <img src={sprite} alt="" className="animate-in fade-in size-full object-contain object-bottom duration-300" />
        </div>
      )}
      <header
        className={cn(
          'bg-background/85 border-border/60 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur',
          'max-md:absolute max-md:inset-x-0 max-md:top-0 transition-transform duration-200 motion-reduce:transition-none',
          headerHidden && 'max-md:-translate-y-full',
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('text-muted-foreground', !sidebarCollapsed && 'md:hidden')}
          onClick={onOpenSidebar}
          aria-label="Open sidebar"
        >
          <PanelLeft />
        </Button>
        <button
          type="button"
          onClick={() => setProfile('character')}
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 outline-none hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <CharacterAvatar name={character.name} file={character.avatar} className="size-7" />
          <span className="truncate text-sm font-semibold">{character.name}</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className={cn('text-muted-foreground ml-auto', spriteMode && 'bg-accent text-accent-foreground')}
          aria-pressed={spriteMode}
          onClick={() => {
            if (character.sprites.neutral) return onToggleSpriteMode();
            toast.info(`Give ${character.name} a sprite first`, {
              description: 'Upload one on the Profile tab of their card.',
            });
            onEditCharacter();
          }}
          aria-label="Sprite mode"
        >
          <PersonStanding />
          <span className="max-sm:hidden">Sprite</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn('text-muted-foreground', adventure && 'bg-accent text-accent-foreground')}
          aria-pressed={adventure}
          onClick={() => setAdventureOpen(true)}
          disabled={!chat}
          aria-label="Adventure"
        >
          <Compass />
          <span className="max-sm:hidden">Adventure</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setMemoryOpen(true)}
          aria-label="Chat memory"
        >
          <Brain />
          <span className="max-sm:hidden">Memory</span>
        </Button>
      </header>

      {/* Sprite mode leaves the upper part of the screen to the sprite. */}
      {spriteMode && <div className="pointer-events-none flex-1" />}

      {/* Normally this wrapper does nothing to the layout; in sprite mode it is the panel at the bottom. */}
      <div
        className={cn(
          spriteMode
            ? 'bg-background/80 relative z-10 mx-auto flex h-[42%] min-h-0 w-full max-w-[48rem] flex-col rounded-t-2xl border border-b-0 shadow-lg backdrop-blur-md max-md:h-[50%]'
            : 'contents',
        )}
      >
        {/* Messages */}
        <div
          ref={scrollRef}
          className="relative z-10 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            const delta = el.scrollTop - lastScrollTop.current;
            lastScrollTop.current = el.scrollTop;
            if (el.scrollTop < 48) setHeaderHidden(false);
            else if (delta > 4) setHeaderHidden(true);
            else if (delta < -4) setHeaderHidden(false);
          }}
        >
          <div className={cn('mx-auto w-full max-w-[46rem] px-4 pb-6', spriteMode ? 'pt-3' : 'pt-16 md:pt-6')}>
            {card.scenario && (
              <section aria-label="Scenario" className="pt-4 pb-6">
                <p className="rp-epigraph">{macros(card.scenario)}</p>
                <div className="rp-dinkus mt-5" aria-hidden />
              </section>
            )}
            <div className={cn(settings.messageBubbles ? 'space-y-1' : 'divide-border/60 divide-y')}>
              {messages.map((m) => {
                // Only a message that was actually named is being rewritten. The
                // old fallback to the last message made impersonation, which names
                // nothing, look like it was overwriting the reply above it.
                const isStreamTarget = !!streaming?.targetId && m.id === streaming.targetId;
                // A Director Note is yours too, just addressed elsewhere.
                const isUser = m.role === 'user' || m.role === 'note';
                const name = m.role === 'note' ? `${settings.userName}, to the Director` : isUser ? settings.userName : character.name;
                return (
                  <MessageItem
                    key={m.id}
                    message={m}
                    name={name}
                    avatar={isUser ? userAvatar : character.avatar}
                    text={isStreamTarget ? streaming.text : macros(m.swipes[m.swipe_index] ?? '')}
                    streaming={isStreamTarget}
                    status={isStreamTarget ? directingStatus : undefined}
                    isLast={m.id === last?.id}
                    busy={streaming !== null}
                    bubble={settings.messageBubbles}
                    selecting={selection !== null}
                    selected={selection?.includes(m.id)}
                    onSelect={() => selectFrom(m)}
                    onSwipe={safe((dir: -1 | 1) => swipe(m, dir))}
                    onRegenerate={safe(() => regenerate(m))}
                    onEdit={safe((content: string) => edit(m, content))}
                    onDelete={safe(() => remove(m))}
                    reasoning={isStreamTarget ? streaming.reasoning : undefined}
                    reasoningChars={m.meta?.[m.swipe_index]?.reasoningChars}
                    onLoadReasoning={() =>
                      api.getMessageMeta(m.id, m.swipe_index).then((full) => full.reasoning ?? '')
                    }
                    onImpersonate={safe(() => runGeneration('impersonate', m.id))}
                    onRedirect={adventure ? safe(() => runGeneration('redirect', m.id)) : undefined}
                    onBranch={safe(async () => {
                      const branch = await api.branchChat(chatId, m.id);
                      toast.success('Branched into a new chat');
                      onBranched(branch.id);
                    })}
                    onOpenProfile={() => setProfile(isUser ? 'user' : 'character')}
                    onOpenDetails={() =>
                      setDetails({
                        messageId: m.id,
                        swipeIndex: m.swipe_index,
                        swipeCount: m.swipes.length,
                        meta: m.meta?.[m.swipe_index] ?? null,
                      })
                    }
                  />
                );
              })}
              {streaming && !streaming.targetId && (
                <MessageItem
                  role={streaming.mode === 'impersonate' ? 'user' : 'assistant'}
                  name={streaming.mode === 'impersonate' ? settings.userName : character.name}
                  avatar={streaming.mode === 'impersonate' ? userAvatar : character.avatar}
                  text={streaming.text}
                  reasoning={streaming.reasoning}
                  status={directingStatus}
                  streaming
                  isLast
                  busy
                  bubble={settings.messageBubbles}
                  onOpenProfile={() => setProfile(streaming.mode === 'impersonate' ? 'user' : 'character')}
                />
              )}
            </div>
          </div>
        </div>

        {/* Composer: one line until what you write needs more. */}
        <div className="relative z-10 mx-auto w-full max-w-[46rem] px-4 pb-4">
          {isNote && (
            <div
              role="status"
              className={cn(
                'mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
                noteBlocked
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-primary/30 bg-primary/5 text-primary',
              )}
            >
              <Compass className="size-3.5" />
              {noteBlocked ? 'Adventure mode is off' : `To the Director - ${character.name} won't see this`}
            </div>
          )}
          {selection !== null && (
            <div className="bg-card mb-2 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 shadow-sm">
              <span className="min-w-0 flex-1 text-sm">
                {selection.length
                  ? `${selection.length} message${selection.length === 1 ? '' : 's'} selected, from the one you picked to the end.`
                  : 'Pick a message. It and everything after it will go.'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setSelection(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!selection.length}
                onClick={() => deleteSelected().catch(errorToast)}
              >
                <Trash2 />
                Delete
              </Button>
            </div>
          )}
          <form
            className="bg-card focus-within:border-ring focus-within:ring-ring/30 flex items-center gap-1 rounded-2xl border px-2 py-1.5 shadow-sm transition-[box-shadow,border-color] focus-within:ring-[3px]"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  // A ring here reads as a box inside a box. Focus shows as a fill instead.
                  className="text-muted-foreground data-[state=open]:bg-accent focus-visible:bg-accent shrink-0 focus-visible:ring-0"
                  aria-label="Chat tools"
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48">
                <DropdownMenuItem
                  // If your turn is already there, rewrite it rather than adding a
                  // second one beside it.
                  onSelect={() =>
                    safe(() => runGeneration('impersonate', last?.role === 'user' ? last.id : undefined))()
                  }
                  disabled={!!streaming || !messages.length}
                >
                  <Wand2 />
                  Impersonate
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSelection([])} disabled={!messages.length}>
                  <Trash2 />
                  Delete messages
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Textarea
              ref={inputRef}
              value={input}
              placeholder={adventure ? `Message ${character.name}, or /d to suggest to the Director…` : `Message ${character.name}…`}
              aria-label="Message"
              rows={1}
              // Your turn is written in the same face as the story it joins.
              className="max-h-60 min-h-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 font-serif text-base leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                if (e.ctrlKey || e.metaKey) {
                  // Regenerate without losing whatever is half-typed in the box.
                  if (!canRegenerate) return;
                  e.preventDefault();
                  safe(regenerate)();
                } else if (!e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />

            {streaming ? (
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="shrink-0 rounded-full"
                aria-label="Stop"
                onClick={() => abortRef.current?.abort()}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" className="shrink-0 rounded-full" aria-label="Send" disabled={!canSend}>
                <ArrowUp />
              </Button>
            )}
          </form>
        </div>
      </div>

      {chat && (
        <AdventureDialog open={adventureOpen} onOpenChange={setAdventureOpen} chat={chat} onChatChanged={setChat} />
      )}

      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} chatId={chatId} characterName={character.name} />

      {details && (
        <GenerationDialog open onOpenChange={(o) => !o && setDetails(null)} {...details} />
      )}

      <ProfileDialog
        open={profile === 'character'}
        onOpenChange={(o) => setProfile(o ? 'character' : null)}
        name={character.name}
        avatar={character.avatar}
        subtitle={card.creator ? `Character card by ${card.creator}` : 'Character card'}
        tags={card.tags}
        fields={[
          { label: 'Description', text: macros(card.description) },
          { label: 'Personality', text: macros(card.personality) },
          { label: 'Scenario', text: macros(card.scenario) },
          { label: 'First message', text: macros(card.first_mes) },
          { label: 'Creator notes', text: card.creator_notes },
        ]}
        editLabel="Edit character"
        onEdit={() => {
          setProfile(null);
          onEditCharacter();
        }}
      />

      <ProfileDialog
        open={profile === 'user'}
        onOpenChange={(o) => setProfile(o ? 'user' : null)}
        name={settings.userName}
        avatar={userAvatar}
        subtitle="Your user card"
        fields={[{ label: 'About you', text: settings.userDescription }]}
        editLabel="Edit user card"
        onEdit={() => {
          setProfile(null);
          onEditUser();
        }}
      />
    </div>
  );
}
