import { memo, useMemo, useState } from 'react';
import {
  Activity,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronRight as Caret,
  Copy,
  Ellipsis,
  GitBranch,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import type { Message } from '@/types';
import { renderMarkdown } from '@/markdown';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CharacterAvatar } from '@/components/character-avatar';

interface Props {
  message?: Message; // undefined for the not-yet-saved streaming reply
  /** Whose message it is while it is still being written. */
  role?: 'user' | 'assistant';
  name: string;
  avatar: string | null;
  text: string;
  streaming?: boolean;
  isLast: boolean;
  busy: boolean;
  onSwipe?: (dir: -1 | 1) => void;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onOpenProfile?: () => void;
  onOpenDetails?: () => void;
  onBranch?: () => void;
  onImpersonate?: () => void;
  /** Draw a panel behind the message. Off leaves plain text on the page. */
  bubble?: boolean;
  /** Delete mode: the row becomes a target rather than a conversation. */
  selecting?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** Thinking as it streams in, for the reply being written right now. */
  reasoning?: string;
  /** Size of the saved thinking, so the toggle can appear without fetching it. */
  reasoningChars?: number;
  /** Fetches the saved thinking when the reader opens the panel. */
  onLoadReasoning?: () => Promise<string>;
}

/** What the model worked through before answering, folded away until asked for. */
function Thinking({
  live,
  chars,
  onLoad,
}: {
  live?: string;
  chars?: number;
  onLoad?: () => Promise<string>;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Follows along while it streams, then folds itself away once the reply lands.
  const open = toggled ?? !!live;
  const text = live || loaded;

  const toggle = async () => {
    const next = !open;
    setToggled(next);
    if (!next || live || loaded || !onLoad) return;
    setLoading(true);
    try {
      setLoaded(await onLoad());
    } catch {
      setLoaded('This reply’s thinking could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  const size = live ? live.length : (chars ?? 0);

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs outline-none focus-visible:ring-[3px]"
      >
        {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
        {live ? 'Thinking' : 'Thought'} {size ? `· ${size.toLocaleString()} characters` : ''}
        <Caret className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="border-border/60 text-muted-foreground mt-1 max-h-64 overflow-y-auto border-l-2 pl-3 text-xs whitespace-pre-wrap">
          {text || (loading ? '' : 'Nothing was recorded for this reply.')}
        </div>
      )}
    </div>
  );
}

interface MessageAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  destructive?: boolean;
}

export const MessageItem = memo(function MessageItem(p: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => renderMarkdown(p.text), [p.text]);

  const m = p.message;
  const isUser = (m?.role ?? p.role) === 'user';
  // Every reply can be asked for another version, so every reply shows the count.
  const canSwipe = !!m && m.role === 'assistant';
  const atLastSwipe = !!m && m.swipe_index >= m.swipes.length - 1;
  const total = m?.swipes.length ?? 0;
  const current = m ? m.swipe_index + 1 : 0;
  const time = m ? new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

  const copy = async () => {
    await navigator.clipboard?.writeText(p.text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // What you can do with a message, behind one menu at every width.
  const actions: MessageAction[] =
    m && !editing && !p.busy && !p.selecting
      ? [
          { key: 'copy', label: copied ? 'Copied' : 'Copy', icon: copied ? Check : Copy, onClick: copy },
          {
            key: 'edit',
            label: 'Edit',
            icon: Pencil,
            onClick: () => {
              setDraft(m.swipes[m.swipe_index] ?? '');
              setEditing(true);
            },
          },
          ...(m.role === 'assistant'
            ? [{ key: 'details', label: 'Generation details', icon: Activity, onClick: p.onOpenDetails }]
            : []),
          ...(m.role === 'assistant'
            ? [{ key: 'regenerate', label: 'Regenerate', icon: RefreshCw, onClick: p.onRegenerate }]
            : []),
          ...(isUser && p.onImpersonate
            ? [{ key: 'impersonate', label: 'Write this message for me', icon: Wand2, onClick: p.onImpersonate }]
            : []),
          ...(m.role === 'assistant' && p.onBranch
            ? [{ key: 'branch', label: 'Branch a new chat from here', icon: GitBranch, onClick: p.onBranch }]
            : []),
          { key: 'delete', label: 'Delete', icon: Trash2, onClick: p.onDelete, destructive: true },
        ]
      : [];

  // SillyTavern's own layout: the avatar is always on the left, whoever is
  // speaking, with the name on top of it next to the avatar. The right edge
  // gets only a small fixed inset (SillyTavern uses 30px, regardless of its
  // avatar size) rather than one that mirrors the avatar's width - that was
  // eating into the line length for no reason a real chat line wrap needs.
  return (
    <article
      data-role={m?.role ?? 'assistant'}
      onClick={p.selecting ? p.onSelect : undefined}
      className={cn(
        'group/msg flex gap-3 py-4 sm:gap-4',
        p.selecting && 'cursor-pointer rounded-xl px-2 transition-colors',
        p.selecting && (p.selected ? 'bg-destructive/10' : 'hover:bg-accent/40'),
      )}
    >
      {p.selecting && (
        <span
          aria-hidden
          className={cn(
            'mt-3 flex size-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors',
            p.selected && 'bg-destructive border-destructive text-white',
          )}
        >
          {p.selected && <Check className="size-3.5" />}
        </span>
      )}
      <CharacterAvatar
        name={p.name}
        file={p.avatar}
        className="mt-0.5 size-12 sm:size-14"
        onClick={p.onOpenProfile}
        label={`View ${p.name}'s card`}
      />

      <div className="min-w-0 flex-1 pr-8">
        <div className="flex h-7 min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={p.onOpenProfile}
            disabled={!p.onOpenProfile}
            className={cn(
              'min-w-0 truncate text-sm font-semibold outline-none enabled:hover:underline disabled:cursor-default',
              !isUser && 'text-primary',
            )}
          >
            {p.name}
          </button>
          {time && <span className="text-muted-foreground shrink-0 text-xs">{time}</span>}

          {actions.length > 0 && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Message actions" className="text-muted-foreground">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {actions.map((a) => (
                    <DropdownMenuItem key={a.key} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.onClick}>
                      <a.icon />
                      {a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {!isUser && (p.reasoning || p.reasoningChars) && !editing && (
          <Thinking live={p.reasoning} chars={p.reasoningChars} onLoad={p.onLoadReasoning} />
        )}

        {editing ? (
          <div className="mt-1 space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              aria-label="Edit message"
              className="bg-background max-h-[60vh] font-serif text-base leading-relaxed"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  p.onEdit?.(draft);
                  setEditing(false);
                }
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  p.onEdit?.(draft);
                  setEditing(false);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-1">
            <div className={cn(p.bubble && 'bg-muted/60 rounded-xl px-4 py-3')}>
              {p.streaming && !p.text ? (
                <span className="rp-typing text-muted-foreground inline-flex gap-1 py-2" aria-label="Generating">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <div className="rp-prose" dangerouslySetInnerHTML={{ __html: html }} />
              )}
            </div>
          </div>
        )}

        {canSwipe && !editing && !p.selecting && !p.streaming && (
          <div className="text-muted-foreground mt-1.5 -ml-2 flex items-center gap-0.5 text-xs">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous version"
              disabled={p.busy || m.swipe_index === 0}
              onClick={() => p.onSwipe?.(-1)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-9 text-center tabular-nums">
              {current} / {total}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={atLastSwipe ? 'Generate another version' : 'Next version'}
                  disabled={p.busy}
                  onClick={() => p.onSwipe?.(1)}
                >
                  <ChevronRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{atLastSwipe ? 'Generate another version' : 'Next version'}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </article>
  );
});
