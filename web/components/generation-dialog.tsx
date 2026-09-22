import { useEffect, useState, type ReactNode } from 'react';
import { Check, CircleAlert, CircleCheck, Compass, Copy, LoaderCircle, Pencil, Scissors } from 'lucide-react';
import { api } from '@/api';
import type { GenerationMeta } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: number;
  swipeIndex: number;
  swipeCount: number;
  /** The record without its prompt, as the message list carries it. */
  meta: GenerationMeta | null;
}

const num = (n: number) => n.toLocaleString();

function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm font-medium break-words">{value}</div>
      {sub && <div className="text-muted-foreground text-xs break-words">{sub}</div>}
    </div>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad';
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'ok' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        tone === 'bad' && 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {children && <div className="text-foreground/80 mt-0.5 break-words">{children}</div>}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** A meter, not a chart: one fill against a known ceiling, with every number also written out. */
function ContextMeter({ used, contextSize, reserved }: { used: number; contextSize: number; reserved: number }) {
  const pct = Math.min(100, (used / contextSize) * 100);
  const reservedAt = Math.max(0, Math.min(100, ((contextSize - reserved) / contextSize) * 100));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">Context used</span>
        <span className="text-muted-foreground text-sm">
          {num(used)} of {num(contextSize)} tokens
        </span>
      </div>
      <div className="bg-muted relative h-2 w-full overflow-hidden rounded-full">
        <div className="bg-primary absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%` }} />
        <div className="bg-background absolute inset-y-0 w-0.5" style={{ left: `calc(${reservedAt}% - 1px)` }} />
      </div>
      <p className="text-muted-foreground text-xs">
        {Math.round(pct)}% of the window. The marker at {Math.round(reservedAt)}% is where the {num(reserved)} tokens
        reserved for the reply begin.
      </p>
    </div>
  );
}

export function GenerationDialog({ open, onOpenChange, messageId, swipeIndex, swipeCount, meta }: Props) {
  const [full, setFull] = useState<GenerationMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The prompt is fetched separately — it is far too large to ride along with every message.
  useEffect(() => {
    if (!open || !meta) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    setFull(null);
    api
      .getMessageMeta(messageId, swipeIndex)
      .then((m) => live && setFull(m))
      .catch((e: Error) => live && setLoadError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, meta, messageId, swipeIndex]);

  const promptTokens = meta?.usage?.prompt_tokens ?? meta?.estimatedPromptTokens ?? 0;
  const replyTokens = meta?.usage?.completion_tokens ?? meta?.estimatedCompletionTokens ?? 0;
  const measured = !!meta?.usage?.prompt_tokens;
  const genMs = meta ? (meta.msToFirstToken ? meta.msTotal - meta.msToFirstToken : meta.msTotal) : 0;
  const speed = meta && genMs > 0 && replyTokens ? (replyTokens / genMs) * 1000 : null;
  const dropped = meta ? meta.historyTotal - meta.historySent : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>Generation details</DialogTitle>
          <DialogDescription>
            {meta
              ? `Version ${swipeIndex + 1} of ${swipeCount} · ${new Date(meta.createdAt).toLocaleString()}`
              : 'Where this message came from.'}
          </DialogDescription>
        </DialogHeader>

        {!meta ? (
          <div className="px-6 py-8">
            <p className="text-sm">
              This message wasn't generated here, so there's nothing to report. It's either the character card's
              greeting (or one of its alternate greetings), or it predates generation records being kept.
            </p>
          </div>
        ) : (
          <Tabs defaultValue="overview" className="max-h-[65vh] gap-0 overflow-y-auto">
            <div className="px-6 pt-4">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="prompt">Prompt</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="space-y-5 px-6 py-5">
              {meta.status === 'error' && (
                <Callout tone="bad" icon={<CircleAlert />} title="The generation failed partway">
                  {meta.error}
                </Callout>
              )}
              {meta.status === 'stopped' && (
                <Callout tone="warn" icon={<Scissors />} title="You stopped this reply">
                  The text above is what had arrived when you pressed Stop.
                </Callout>
              )}
              {meta.status === 'ok' && meta.finishReason === 'length' && (
                <Callout tone="warn" icon={<Scissors />} title="Cut off at the reply limit">
                  The model was still writing when it hit {num(meta.maxTokens)} tokens. Raise "Max reply tokens" in
                  Settings to let replies run longer.
                </Callout>
              )}
              {meta.status === 'ok' && meta.finishReason !== 'length' && (
                <Callout tone="ok" icon={<CircleCheck />} title="Finished normally" />
              )}
              {meta.edited && (
                <Callout tone="warn" icon={<Pencil />} title="Edited after generation">
                  The text shown in the chat no longer matches what the model produced, so the counts below describe
                  the original reply.
                </Callout>
              )}

              {meta.directorError && (
                <Callout tone="warn" icon={<Compass />} title="The Director could not answer">
                  {meta.directorError}. This reply was written without a Direction.
                </Callout>
              )}
              {full?.direction && (
                <div className="grid gap-1.5">
                  <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
                    <Compass className="size-3.5" />
                    Direction
                  </div>
                  <div className="bg-muted/40 rounded-lg border px-3 py-2.5 text-sm whitespace-pre-wrap">{full.direction}</div>
                  <div className="text-muted-foreground text-xs">
                    {meta.directionReused
                      ? 'Kept from the version this one rewrites.'
                      : `From ${meta.directorModel ?? 'the Director'}${meta.directorMs ? ` in ${duration(meta.directorMs)}` : ''}. The Narrator followed it; you never see it in the chat.`}
                  </div>
                </div>
              )}

              <ContextMeter used={promptTokens} contextSize={meta.contextSize} reserved={meta.maxTokens} />

              <div className="bg-muted/40 rounded-lg border border-dashed px-3 py-2.5 text-sm">
                Sent <span className="font-medium">{meta.historySent}</span> of {meta.historyTotal} earlier messages
                {dropped > 0 ? (
                  <>
                    {' '}
                    — the <span className="font-medium">{dropped} oldest</span>{' '}
                    {dropped === 1 ? 'was' : 'were'} dropped to fit the {num(meta.historyBudget)}-token history budget.
                    Anything older is outside the character's memory.
                  </>
                ) : (
                  <> — the whole conversation fit in the window.</>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Stat
                  label="Model"
                  value={meta.modelRequested || '—'}
                  sub={
                    meta.modelReported && meta.modelReported !== meta.modelRequested
                      ? `served as ${meta.modelReported}`
                      : undefined
                  }
                />
                <Stat label="Provider" value={meta.provider} />
                <Stat label="Finish reason" value={meta.finishReason ?? 'not reported'} />
                <Stat
                  label="Memory"
                  value={meta.memoryTokens ? `${num(meta.memoryTokens)} tokens` : 'none sent'}
                  sub={meta.memoryTokens ? 'summary of older messages' : undefined}
                />
                <Stat
                  label="Lorebook"
                  value={meta.loreEntries ? `${meta.loreEntries} entries, ${num(meta.loreTokens ?? 0)} tokens` : 'nothing matched'}
                  sub={meta.loreTitles?.length ? meta.loreTitles.join(', ') : undefined}
                />
                <Stat
                  label="Thinking"
                  value={meta.thinkingLevel === 'default' ? 'provider default' : meta.thinkingLevel}
                  sub={meta.extrasDropped ? 'the provider refused the option and it was sent without it' : undefined}
                />
                <Stat label="Temperature" value={meta.temperature} />
                <Stat label="Max reply tokens" value={num(meta.maxTokens)} />
                <Stat label="Context size" value={num(meta.contextSize)} />
                <Stat
                  label="Prompt tokens"
                  value={num(promptTokens)}
                  sub={
                    measured
                      ? `reported by the provider · estimate was ${num(meta.estimatedPromptTokens)}`
                      : 'estimated — the provider reported no usage'
                  }
                />
                <Stat
                  label="Reply tokens"
                  value={num(replyTokens)}
                  sub={meta.usage?.completion_tokens ? 'reported by the provider' : 'estimated'}
                />
                <Stat label="Reply characters" value={num(meta.outputChars)} />
                <Stat
                  label="Thought before replying"
                  value={meta.reasoningChars ? `${num(meta.reasoningChars)} characters` : 'no'}
                  sub={meta.reasoningChars ? 'shown above the message' : undefined}
                />
                <Stat
                  label="Time to first token"
                  value={meta.msToFirstToken ? duration(meta.msToFirstToken) : '—'}
                  sub="how long the model took to start"
                />
                <Stat label="Total time" value={duration(meta.msTotal)} />
                <Stat label="Speed" value={speed ? `${speed.toFixed(1)} tok/s` : '—'} sub="while writing" />
              </div>
            </TabsContent>

            <TabsContent value="prompt" className="space-y-4 px-6 py-5">
              <div className="grid gap-2 text-sm">
                <div>
                  System prompt came from{' '}
                  <span className="font-medium">
                    {meta.systemSource === 'card' ? "the character card's override" : 'your default in Settings'}
                  </span>
                  {meta.systemSource === 'card' && meta.usedOriginalMacro && ', with {{original}} expanded into it'}.
                </div>
                <div className="text-muted-foreground">
                  {meta.hasPostHistory
                    ? 'The card also sends post-history instructions after the conversation.'
                    : 'The card sends no post-history instructions.'}
                </div>
              </div>

              {loading && (
                <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                  <LoaderCircle className="size-4 animate-spin" />
                  Loading the prompt…
                </div>
              )}
              {loadError && <Callout tone="bad" icon={<CircleAlert />} title="Could not load the prompt">{loadError}</Callout>}

              {full?.prompt && (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-xs">
                      {full.prompt.length} messages, exactly as they were sent
                    </span>
                    <CopyButton
                      label="Copy prompt"
                      text={full.prompt.map((m) => `### ${m.role}\n${m.content}`).join('\n\n')}
                    />
                  </div>
                  <div className="space-y-2">
                    {full.prompt.map((m, i) => (
                      <div key={i} className="rounded-lg border">
                        <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1.5 text-xs">
                          <span className="font-medium tracking-wide uppercase">{m.role}</span>
                          <span className="tabular-nums">{num(m.content.length)} chars</span>
                        </div>
                        <pre className="max-h-64 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap">{m.content}</pre>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="json" className="space-y-3 px-6 py-5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">The stored record for this version.</span>
                <CopyButton label="Copy JSON" text={JSON.stringify(full ?? meta, null, 2)} />
              </div>
              <pre className="bg-muted/40 max-h-[45vh] overflow-auto rounded-lg border p-3 text-xs">
                {JSON.stringify(full ?? meta, null, 2)}
              </pre>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
