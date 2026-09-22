import { useEffect, useState } from 'react';
import {
  CircleCheck,
  CircleAlert,
  Database,
  Globe,
  KeyRound,
  LoaderCircle,
  Palette,
  PlugZap,
  RefreshCw,
  ScanFace,
  ScrollText,
  SlidersHorizontal,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import type { PromptFormat, Settings, ThinkingLevel } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AvatarPicker } from '@/components/avatar-picker';
import { ModelCombobox } from '@/components/model-combobox';
import { Select } from '@/components/ui/select';
import { BackgroundPicker } from '@/components/background-picker';
import { Checkbox } from '@/components/ui/select';
import { Field } from '@/components/form-field';
import { DataPanel } from '@/components/data-panel';
import { DEFAULT_DIRECTOR_PROMPT } from '@/core/director';

const PRESETS: { label: string; apiBase: string; needsKey?: boolean }[] = [
  { label: 'OpenRouter', apiBase: 'https://openrouter.ai/api/v1', needsKey: true },
  { label: 'Ollama', apiBase: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', apiBase: 'http://127.0.0.1:1234/v1' },
  { label: 'KoboldCpp', apiBase: 'http://127.0.0.1:5001/v1' },
  { label: 'llama.cpp', apiBase: 'http://127.0.0.1:8080/v1' },
  { label: 'OpenAI', apiBase: 'https://api.openai.com/v1', needsKey: true },
];

// The URL you last used under each provider button, so switching away and back
// doesn't throw away a custom endpoint. Anything matching no preset lives under CUSTOM.
const CUSTOM = 'Custom';
const PROVIDER_URLS_KEY = 'rp-provider-urls';

function readProviderUrls(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROVIDER_URLS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeProviderUrls(urls: Record<string, string>) {
  try {
    localStorage.setItem(PROVIDER_URLS_KEY, JSON.stringify(urls));
  } catch {
    /* storage unavailable */
  }
}

/** Which button is pressed for this URL: the preset it belongs to, otherwise Custom. */
function providerFor(apiBase: string, urls: Record<string, string>): string {
  const exact = PRESETS.find((p) => p.apiBase === apiBase);
  if (exact) return exact.label;
  return PRESETS.find((p) => urls[p.label] === apiBase)?.label ?? CUSTOM;
}

const THINKING: { value: ThinkingLevel; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const PROMPT_FORMATS: { value: PromptFormat; label: string; hint: string }[] = [
  { value: 'none', label: 'Send as built', hint: 'What every OpenAI-compatible endpoint accepts.' },
  { value: 'merge', label: 'Merge consecutive roles', hint: 'Folds runs of the same role into one message.' },
  {
    value: 'semi',
    label: 'Alternating roles',
    hint: 'One system block, then strictly alternating turns. Late instructions stay with the newest turn.',
  },
  {
    value: 'strict',
    label: 'Alternating, user first',
    hint: 'As above, and the conversation opens with the user. For Anthropic-style APIs and Bedrock.',
  },
  {
    value: 'single',
    label: 'One user message',
    hint: 'Flattens the whole prompt into a single turn. A last resort: the model can no longer tell who spoke.',
  },
];

export type SettingsTab = 'connection' | 'user' | 'customize' | 'generation' | 'prompt' | 'data';

/** The sections of Settings, in the order the sidebar menu lists them. */
export const SETTINGS_TABS: { value: SettingsTab; label: string; icon: LucideIcon; description: string }[] = [
  {
    value: 'connection',
    label: 'Connection',
    icon: PlugZap,
    description: 'Which provider and model your characters speak through.',
  },
  {
    value: 'user',
    label: 'User',
    icon: UserRound,
    description: 'Who you are in the story: your name, persona and picture.',
  },
  {
    value: 'customize',
    label: 'Customize',
    icon: Palette,
    description: 'How the chat looks.',
  },
  {
    value: 'generation',
    label: 'Generation',
    icon: SlidersHorizontal,
    description: 'How long, how varied, and how hard the model thinks.',
  },
  {
    value: 'prompt',
    label: 'Prompt',
    icon: ScrollText,
    description: 'The instructions sent ahead of every chat.',
  },
  {
    value: 'data',
    label: 'Data',
    icon: Database,
    description: 'Back up, restore or clear what is kept in this browser.',
  },
];

// Fetched model lists are remembered per provider, so they survive a reload
// instead of making you press "Fetch models" again every time.
const MODEL_CACHE_KEY = 'rp-models';

function readModelCache(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // storage unavailable or corrupt
  }
}

const cachedModels = (apiBase: string) => {
  const list = readModelCache()[apiBase];
  return Array.isArray(list) ? list : [];
};

function cacheModels(apiBase: string, models: string[]) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ ...readModelCache(), [apiBase]: models }));
  } catch {
    /* ignore */
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onSaved: (s: Settings) => void;
  /** Which tab to land on when the dialog opens. */
  tab?: SettingsTab;
}

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

function SliderField(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={props.id}>{props.label}</Label>
        <Input
          type="number"
          aria-label={`${props.label} value`}
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step}
          onChange={(e) => props.onChange(Number(e.target.value))}
          className="h-7 w-24 text-right tabular-nums"
        />
      </div>
      <Slider
        id={props.id}
        value={[props.value]}
        min={props.min}
        max={props.max}
        step={props.step}
        onValueChange={([v]) => props.onChange(v)}
      />
      <p className="text-muted-foreground text-xs">{props.hint}</p>
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, settings, onSaved, tab = 'connection' }: Props) {
  const [form, setForm] = useState(settings);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [userAvatar, setUserAvatar] = useState<File | null>(null);
  const [userAvatarCleared, setUserAvatarCleared] = useState(false);
  const [providerUrls, setProviderUrls] = useState<Record<string, string>>(readProviderUrls);
  const [background, setBackground] = useState<File | null>(null);
  const [backgroundCleared, setBackgroundCleared] = useState(false);
  // Whether this model can read images at all. Only a real request can tell us.
  const [vision, setVision] = useState<{ checking: boolean; ok: boolean; reason?: string }>({
    checking: false,
    ok: false,
  });
  const [describing, setDescribing] = useState(false);

  // Reset the form each time the dialog opens (not when settings change while it's open).
  useEffect(() => {
    if (open) {
      setForm(settings);
      setStatus({ kind: 'idle' });
      setUserAvatar(null);
      setUserAvatarCleared(false);
      setBackground(null);
      setBackgroundCleared(false);

      // One cheap look, remembered per model until reload, so the button below
      // knows whether it can work before it is pressed.
      if (settings.model && settings.userAvatar) {
        setVision({ checking: true, ok: false });
        api
          .checkVision()
          .then((v) => setVision({ checking: false, ok: v.vision, reason: v.reason }))
          .catch((e: Error) => setVision({ checking: false, ok: false, reason: e.message }));
      } else {
        setVision({ checking: false, ok: false });
      }

      // Claim the URL in use for whichever button it belongs to, so the first
      // click on another provider can't lose an endpoint you typed yourself.
      const urls = readProviderUrls();
      const owner = providerFor(settings.apiBase, urls);
      if (urls[owner] !== settings.apiBase) {
        urls[owner] = settings.apiBase;
        writeProviderUrls(urls);
      }
      setProviderUrls(urls);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Show the models already known for this provider, on open and when you switch provider.
  useEffect(() => {
    if (open) setModels(cachedModels(form.apiBase));
  }, [open, form.apiBase]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  // The button can only work with a saved picture, a model, and a model that sees.
  const describeBlockedBecause = userAvatar
    ? 'Save your new picture first, then the model can look at it.'
    : !form.userAvatar
      ? 'Upload a picture first.'
      : !form.model
        ? 'Choose a model in Connection settings first.'
        : vision.checking
          ? 'Checking whether this model can read pictures…'
          : !vision.ok
            ? `This model cannot read pictures. ${vision.reason ?? ''}`.trim()
            : null;
  const canDescribe = !describeBlockedBecause;

  const selected = providerFor(form.apiBase, providerUrls);
  const preset = PRESETS.find((p) => p.label === selected);

  /** Switch provider, restoring the URL you last used there. */
  const selectProvider = (label: string, fallback?: string) => {
    const url = providerUrls[label] ?? fallback;
    if (url) {
      set('apiBase', url);
    } else if (label === CUSTOM) {
      // No endpoint of your own yet: clear the field so you can type one.
      set('apiBase', '');
      requestAnimationFrame(() => document.getElementById('api-base')?.focus());
    }
  };

  /** Editing the URL re-points whichever provider is currently selected. */
  const editApiBase = (next: string) => {
    const owner = providerFor(form.apiBase, providerUrls);
    set('apiBase', next);
    const updated = { ...providerUrls, [owner]: next };
    setProviderUrls(updated);
    writeProviderUrls(updated);
  };

  const persist = async () => {
    const saved = await api.saveSettings(form);
    setForm(saved);
    return saved;
  };

  const fetchModels = async () => {
    setStatus({ kind: 'loading' });
    try {
      const saved = await persist();
      onSaved(saved);
      const { models } = await api.listModels();
      cacheModels(saved.apiBase, models);
      setModels(models);
      setStatus(
        models.length
          ? { kind: 'ok', text: `Connected — found ${models.length} models` }
          : { kind: 'ok', text: 'Connected, but the provider listed no models' },
      );
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  };

  const testConnection = async () => {
    setStatus({ kind: 'loading' });
    try {
      onSaved(await persist());
      const r = await api.testConnection();
      const tokens = r.usage
        ? `${r.usage.prompt_tokens ?? '?'} prompt + ${r.usage.completion_tokens ?? '?'} reply tokens`
        : 'the provider reported no token usage';
      setStatus({
        kind: 'ok',
        text: `${r.model ?? form.model} answered in ${r.ms} ms — ${tokens}${r.reply ? `, and said "${r.reply}"` : ''}`,
      });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  };

  const describeMe = async () => {
    setDescribing(true);
    try {
      const { text } = await api.describeMe();
      // Never overwrite what you wrote yourself; add to it instead.
      set('userDescription', form.userDescription.trim() ? `${form.userDescription.trim()}\n\n${text}` : text);
      toast.success('Added a description from your picture');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDescribing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      let saved = await persist();
      // The picture travels as raw bytes on its own endpoint, so apply it after the rest.
      if (userAvatar) saved = await api.uploadUserAvatar(userAvatar);
      else if (userAvatarCleared && saved.userAvatar) saved = await api.removeUserAvatar();
      if (background) saved = await api.uploadChatBackground(background);
      else if (backgroundCleared && saved.chatBackground) saved = await api.removeChatBackground();
      setForm(saved);
      onSaved(saved);
      toast.success('Settings saved');
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const section = SETTINGS_TABS.find((t) => t.value === tab) ?? SETTINGS_TABS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <section.icon className="text-muted-foreground size-4" />
            {section.label}
          </DialogTitle>
          <DialogDescription>{section.description}</DialogDescription>
        </DialogHeader>

        {/* One section at a time, picked from the Settings menu in the sidebar. */}
        <Tabs value={tab} className="max-h-[65vh] gap-0 overflow-y-auto">

          <TabsContent value="connection" className="space-y-5 px-6 py-5">
            <div className="grid gap-2">
              <Label>Provider</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[...PRESETS, { label: CUSTOM, apiBase: '', needsKey: false }].map((p) => {
                  const active = selected === p.label;
                  return (
                    <Button
                      key={p.label}
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={active}
                      onClick={() => selectProvider(p.label, p.apiBase || undefined)}
                      className={cn(
                        'justify-start',
                        active && 'border-primary bg-primary/5 text-primary dark:border-primary dark:bg-primary/10',
                      )}
                    >
                      {p.label === CUSTOM ? <Globe className="opacity-60" /> : <PlugZap className="opacity-60" />}
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <Field
              id="api-base"
              label="API base URL"
              hint={
                selected === CUSTOM
                  ? 'Any OpenAI-compatible endpoint, usually ending in /v1. This one is remembered under Custom.'
                  : `Any OpenAI-compatible endpoint, usually ending in /v1. Edits are remembered under ${selected}.`
              }
            >
              <Input
                id="api-base"
                value={form.apiBase}
                onChange={(e) => editApiBase(e.target.value)}
                placeholder="https://…/v1"
              />
            </Field>

            <Field
              id="api-key"
              label="API key"
              hint={`${
                preset?.needsKey ? `${preset.label} requires a key. ` : ''
              }Kept in this browser only, and sent to nobody but the provider above.`}
            >
              <div className="relative">
                <KeyRound className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input
                  id="api-key"
                  type="password"
                  className="pl-8"
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={preset?.needsKey ? 'sk-…' : 'Not needed for most local servers'}
                  autoComplete="off"
                />
              </div>
            </Field>

            <Field
              id="model"
              label="Model"
              hint={
                models.length
                  ? `${models.length} models known for this provider — pick one from the list, or type any name.`
                  : 'Fetch the list, or type a model name yourself.'
              }
            >
              <div className="flex gap-2">
                <ModelCombobox
                  id="model"
                  value={form.model}
                  models={models}
                  placeholder="e.g. llama3.1:8b"
                  onChange={(v) => set('model', v)}
                />
                <Button type="button" variant="outline" onClick={fetchModels} disabled={status.kind === 'loading'}>
                  {status.kind === 'loading' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                  Fetch models
                </Button>
              </div>
            </Field>

            <Field
              id="director-model"
              label="Director model"
              hint="Used in adventure mode to decide what happens before the character replies. Leave it empty to use the model above. A quick, sensible model does this job well."
            >
              <ModelCombobox
                id="director-model"
                value={form.directorModel}
                models={models}
                placeholder={form.model ? `Same as the model above (${form.model})` : 'Same as the model above'}
                onChange={(v) => set('directorModel', v)}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button type="button" variant="outline" onClick={testConnection} disabled={status.kind === 'loading'}>
                {status.kind === 'loading' ? <LoaderCircle className="animate-spin" /> : <Zap />}
                Test connection
              </Button>
              <span className="text-muted-foreground flex-1 text-xs">
                Sends one four-token message to the model itself, so it checks the key, URL and model together. Costs a
                few tokens; listing models costs nothing.
              </span>
            </div>

            <Field
              id="prompt-format"
              label="Prompt post-processing"
              hint={PROMPT_FORMATS.find((f) => f.value === form.promptFormat)?.hint}
            >
              <Select
                value={form.promptFormat}
                onChange={(v) => set('promptFormat', v as PromptFormat)}
                options={PROMPT_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
              />
            </Field>

            {(status.kind === 'ok' || status.kind === 'error') && (
              <div
                role="status"
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
                  status.kind === 'ok'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {status.kind === 'ok' ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                )}
                <span className="break-words">{status.text}</span>
              </div>
            )}
          </TabsContent>

          {/* Your own card: who {{user}} is in every chat. */}
          <TabsContent value="user" className="space-y-5 px-6 py-5">
            <AvatarPicker
              name={form.userName || 'You'}
              file={form.userAvatar || null}
              pending={userAvatar}
              cleared={userAvatarCleared}
              onChange={(f) => {
                setUserAvatar(f);
                setUserAvatarCleared(!f);
              }}
              hint="Shown next to your messages. PNG, JPEG, WebP or GIF."
            />

            <Field id="user-name" label="Your name" hint="Replaces {{user}} in cards and prompts.">
              <Input id="user-name" value={form.userName} onChange={(e) => set('userName', e.target.value)} />
            </Field>

            <Field
              id="user-description"
              label="About you"
              hint="Your persona: who the character is talking to. Added to the prompt above the scenario. Leave empty to send nothing."
            >
              <Textarea
                id="user-description"
                className="min-h-32"
                placeholder="A travelling cartographer with a sharp tongue and a worn leather satchel…"
                value={form.userDescription}
                onChange={(e) => set('userDescription', e.target.value)}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button"
                variant="outline"
                onClick={describeMe}
                disabled={!canDescribe || describing}
                title={describeBlockedBecause ?? undefined}
              >
                {describing || vision.checking ? <LoaderCircle className="animate-spin" /> : <ScanFace />}
                Describe from my picture
              </Button>
              <span className="text-muted-foreground flex-1 text-xs">
                {describeBlockedBecause ??
                  'Sends your picture to the model and adds how you look to the text above. It is added underneath whatever you have written, never over it.'}
              </span>
            </div>

          </TabsContent>

          {/* How the chat itself looks. */}
          <TabsContent value="customize" className="space-y-6 px-6 py-5">
            <div className="grid gap-2">
              <Label>Chat background</Label>
              <BackgroundPicker
                file={form.chatBackground || null}
                pending={background}
                cleared={backgroundCleared}
                dim={form.chatBackgroundDim}
                onChange={(f) => {
                  setBackground(f);
                  setBackgroundCleared(!f);
                }}
              />
              <p className="text-muted-foreground text-xs">
                Sits behind every chat. PNG, JPEG, WebP or GIF, scaled to cover the window.
              </p>
            </div>

            <div className="grid gap-2">
              <Label>Messages</Label>
              <Checkbox
                checked={form.messageBubbles}
                onChange={(v) => set('messageBubbles', v)}
                label="Draw a panel behind every message"
                className="text-sm"
              />
              <p className="text-muted-foreground text-xs">
                On, both sides sit in their own panel. Off, the writing sits plainly on the page and a thin rule
                separates one message from the next.
              </p>
            </div>

            <SliderField
              id="background-dim"
              label="Dimness"
              value={form.chatBackgroundDim}
              min={0}
              max={100}
              step={5}
              hint="How far the picture fades into the page colour. Higher is dimmer and keeps the writing easy to read."
              onChange={(v) => set('chatBackgroundDim', v)}
            />
          </TabsContent>

          <TabsContent value="generation" className="space-y-6 px-6 py-5">
            <SliderField
              id="temperature"
              label="Temperature"
              value={form.temperature}
              min={0}
              max={2}
              step={0.05}
              hint="Higher is more creative and unpredictable. 0.7–1.0 works well for roleplay."
              onChange={(v) => set('temperature', v)}
            />
            <SliderField
              id="max-tokens"
              label="Max reply tokens"
              value={form.maxTokens}
              min={32}
              max={2048}
              step={16}
              hint="The longest a single reply can be."
              onChange={(v) => set('maxTokens', v)}
            />
            <SliderField
              id="context-size"
              label="Context size"
              value={form.contextSize}
              min={1024}
              max={131072}
              step={1024}
              hint="How many tokens the model can see. Older messages are dropped to fit. Match your model's limit."
              onChange={(v) => set('contextSize', v)}
            />

            <SliderField
              id="memory-tokens"
              label="Memory budget"
              value={form.memoryTokens}
              min={0}
              max={4096}
              step={64}
              hint="Context set aside for what this chat remembers. It is taken out of the room for raw history, so a long chat keeps its past instead of the exact words. 0 turns memory off."
              onChange={(v) => set('memoryTokens', v)}
            />

            <SliderField
              id="director-temperature"
              label="Director temperature"
              value={form.directorTemperature}
              min={0}
              max={2}
              step={0.05}
              hint="Adventure mode only. Lower keeps the Director's rulings steady; the character's own temperature is the one above."
              onChange={(v) => set('directorTemperature', v)}
            />
            <SliderField
              id="director-tokens"
              label="Director history budget"
              value={form.directorTokens}
              min={512}
              max={16384}
              step={256}
              hint="Adventure mode only. How much recent chat the Director reads each turn. Less is quicker and cheaper."
              onChange={(v) => set('directorTokens', v)}
            />

            <div className="grid gap-3">
              <Label>Thinking level</Label>
              <div className="grid grid-cols-4 gap-2">
                {THINKING.map((t) => (
                  <Button
                    key={t.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={form.thinkingLevel === t.value}
                    onClick={() => set('thinkingLevel', t.value)}
                    className={cn(
                      form.thinkingLevel === t.value &&
                        'border-primary bg-primary/5 text-primary dark:border-primary dark:bg-primary/10',
                    )}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                How hard a reasoning model should think before it answers. <b className="font-medium">Default</b> sends
                nothing and leaves it to the provider. Models without a thinking mode ignore it; if a provider refuses
                the option outright, the reply's generation details will say so.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="prompt" className="space-y-5 px-6 py-5">
            <Field
              id="system-prompt"
              label="Default system prompt"
              hint="Used unless a card has its own. Cards can include this one with {{original}}."
            >
              <Textarea
                id="system-prompt"
                className="min-h-40"
                value={form.systemPrompt}
                onChange={(e) => set('systemPrompt', e.target.value)}
              />
            </Field>
            <Field
              id="director-prompt"
              label="Director instructions"
              hint={
                <>
                  Adventure mode only. Leave empty for the built-in instructions. Keep the{' '}
                  <code>&lt;direction&gt;</code> and <code>&lt;state&gt;</code> reply format, or the Director's answers
                  can't be read.
                </>
              }
            >
              <Textarea
                id="director-prompt"
                className="min-h-32"
                placeholder={DEFAULT_DIRECTOR_PROMPT}
                value={form.directorPrompt}
                onChange={(e) => set('directorPrompt', e.target.value)}
              />
            </Field>
            <p className="text-muted-foreground text-xs">
              Your name and persona moved to the <span className="text-foreground font-medium">User</span> tab.
            </p>
          </TabsContent>

          <TabsContent value="data" className="space-y-6 px-6 py-5">
            <DataPanel />
          </TabsContent>
        </Tabs>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <LoaderCircle className="animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
