import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Character, CharacterCard } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AvatarPicker } from '@/components/avatar-picker';
import { SpritePicker } from '@/components/sprite-picker';
import { Field } from '@/components/form-field';

const EMPTY_CARD: CharacterCard = {
  name: '',
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
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null creates a new character. */
  character: Character | null;
  onSaved: (character: Character, isNew: boolean) => void;
}

const MACRO_HINT = '{{char}} and {{user}} are replaced when the prompt is built.';

export function CharacterDialog({ open, onOpenChange, character, onSaved }: Props) {
  const [form, setForm] = useState<CharacterCard>(EMPTY_CARD);
  const [tagsText, setTagsText] = useState('');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarCleared, setAvatarCleared] = useState(false);
  const [sprite, setSprite] = useState<File | null>(null);
  const [spriteCleared, setSpriteCleared] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the card each time the dialog opens, so an abandoned edit doesn't linger.
  useEffect(() => {
    if (!open) return;
    setForm(character ? { ...EMPTY_CARD, ...character.card } : EMPTY_CARD);
    setTagsText(character?.card.tags.join(', ') ?? '');
    setAvatar(null);
    setAvatarCleared(false);
    setSprite(null);
    setSpriteCleared(false);
  }, [open, character]);

  const set = <K extends keyof CharacterCard>(k: K, v: CharacterCard[K]) => setForm((f) => ({ ...f, [k]: v }));

  const updateGreetings = (fn: (list: string[]) => string[]) =>
    setForm((f) => ({ ...f, alternate_greetings: fn(f.alternate_greetings) }));

  const save = async () => {
    const card: CharacterCard = {
      ...form,
      name: form.name.trim(),
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      alternate_greetings: form.alternate_greetings.filter((g) => g.trim()),
    };
    if (!card.name) {
      toast.error('The character needs a name');
      return;
    }
    setSaving(true);
    try {
      let saved = character ? await api.updateCharacter(character.id, card) : await api.createCharacter(card);
      if (avatar) saved = await api.uploadCharacterAvatar(saved.id, avatar);
      else if (avatarCleared && saved.avatar) saved = await api.removeCharacterAvatar(saved.id);
      if (sprite) saved = await api.uploadCharacterSprite(saved.id, sprite);
      else if (spriteCleared && saved.sprites.neutral) saved = await api.removeCharacterSprite(saved.id);
      onSaved(saved, !character);
      toast.success(character ? `Saved ${saved.name}` : `Created ${saved.name}`);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>{character ? `Edit ${character.name}` : 'New character'}</DialogTitle>
          <DialogDescription>
            {character
              ? 'Change any field of this card. Existing chats keep their messages.'
              : 'Write a character card by hand — the same fields an imported Tavern card uses.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="profile" className="max-h-[65vh] gap-0 overflow-y-auto">
          <div className="px-6 pt-4">
            <TabsList className="w-full">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="profile" className="space-y-5 px-6 py-5">
            <AvatarPicker
              name={form.name || 'New character'}
              file={character?.avatar ?? null}
              pending={avatar}
              cleared={avatarCleared}
              onChange={(f) => {
                setAvatar(f);
                setAvatarCleared(!f);
              }}
              hint="PNG, JPEG, WebP or GIF. Imported cards use the card image itself."
            />

            <SpritePicker
              file={character?.sprites.neutral ?? null}
              pending={sprite}
              cleared={spriteCleared}
              onChange={(f) => {
                setSprite(f);
                setSpriteCleared(!f);
              }}
            />

            <Field id="card-name" label="Name" hint="Replaces {{char}} in the card and prompts.">
              <Input id="card-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Lyra" />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="card-creator" label="Creator">
                <Input
                  id="card-creator"
                  value={form.creator}
                  onChange={(e) => set('creator', e.target.value)}
                  placeholder="Your name"
                />
              </Field>
              <Field id="card-tags" label="Tags" hint="Comma separated.">
                <Input
                  id="card-tags"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="fantasy, mentor"
                />
              </Field>
            </div>

            <Field id="card-description" label="Description" hint={`Who they are, how they look, what they want. ${MACRO_HINT}`}>
              <Textarea
                id="card-description"
                className="min-h-32"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>

            <Field id="card-personality" label="Personality" hint="A short summary of their temperament.">
              <Textarea
                id="card-personality"
                className="min-h-20"
                value={form.personality}
                onChange={(e) => set('personality', e.target.value)}
              />
            </Field>
          </TabsContent>

          <TabsContent value="chat" className="space-y-5 px-6 py-5">
            <Field id="card-scenario" label="Scenario" hint="The situation the chat opens in. Shown above the messages.">
              <Textarea
                id="card-scenario"
                className="min-h-20"
                value={form.scenario}
                onChange={(e) => set('scenario', e.target.value)}
              />
            </Field>

            <Field id="card-first-mes" label="First message" hint="The greeting that starts every new chat.">
              <Textarea
                id="card-first-mes"
                className="min-h-28 font-serif text-[15px]"
                value={form.first_mes}
                onChange={(e) => set('first_mes', e.target.value)}
              />
            </Field>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Alternate greetings</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => updateGreetings((list) => [...list, ''])}
                >
                  <Plus />
                  Add
                </Button>
              </div>
              {form.alternate_greetings.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Extra openings. They become swipes on the first message of a new chat.
                </p>
              ) : (
                <div className="space-y-2">
                  {form.alternate_greetings.map((g, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <Textarea
                        value={g}
                        aria-label={`Alternate greeting ${i + 1}`}
                        className="min-h-20 font-serif text-[15px]"
                        onChange={(e) => updateGreetings((list) => list.map((g, n) => (n === i ? e.target.value : g)))}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove alternate greeting ${i + 1}`}
                        className="hover:text-destructive"
                        onClick={() => updateGreetings((list) => list.filter((_, n) => n !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Field
              id="card-mes-example"
              label="Example dialogue"
              hint="Sample exchanges used as a style reference. Separate blocks with <START>."
            >
              <Textarea
                id="card-mes-example"
                className="min-h-28 font-mono text-xs"
                value={form.mes_example}
                onChange={(e) => set('mes_example', e.target.value)}
              />
            </Field>
          </TabsContent>

          <TabsContent value="prompt" className="space-y-5 px-6 py-5">
            <Field
              id="card-system-prompt"
              label="System prompt override"
              hint="Leave empty to use the default from Settings. Include the default with {{original}}."
            >
              <Textarea
                id="card-system-prompt"
                className="min-h-28"
                value={form.system_prompt}
                onChange={(e) => set('system_prompt', e.target.value)}
              />
            </Field>

            <Field
              id="card-post-history"
              label="Post-history instructions"
              hint="Sent after the chat history — a last reminder for the model."
            >
              <Textarea
                id="card-post-history"
                className="min-h-24"
                value={form.post_history_instructions}
                onChange={(e) => set('post_history_instructions', e.target.value)}
              />
            </Field>

            <Field id="card-notes" label="Creator notes" hint="Notes for humans. Never sent to the model.">
              <Textarea
                id="card-notes"
                className="min-h-20"
                value={form.creator_notes}
                onChange={(e) => set('creator_notes', e.target.value)}
              />
            </Field>
          </TabsContent>
        </Tabs>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <LoaderCircle className="animate-spin" />}
            {character ? 'Save changes' : 'Create character'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
