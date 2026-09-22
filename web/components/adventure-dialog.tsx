import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Chat, DirectorStyle } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/select';
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
  chat: Chat;
  onChatChanged: (chat: Chat) => void;
}

const STYLES: { value: DirectorStyle; label: string; hint: string }[] = [
  { value: 'referee', label: 'Referee', hint: 'Only rules on what your actions achieve. Never adds anything of its own.' },
  { value: 'balanced', label: 'Balanced', hint: 'Brings in characters and events when the scene stalls.' },
  { value: 'active', label: 'Active', hint: 'Keeps the pressure on: something moves almost every turn.' },
];

const PLACEHOLDER = `Empty until your next turn - the Director fills it in. You can also write it yourself:

Cast:
- Brann: a hooded stranger watching from the treeline
Threads:
- who sent Brann, and why
Rules:
- magic is rare and feared`;

/** Adventure mode for one chat: on or off, the Director Style, and the Adventure State. */
export function AdventureDialog({ open, onOpenChange, chat, onChatChanged }: Props) {
  const [enabled, setEnabled] = useState(!!chat.adventure);
  const [style, setStyle] = useState<DirectorStyle>(chat.directorStyle ?? 'balanced');
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnabled(!!chat.adventure);
    setStyle(chat.directorStyle ?? 'balanced');
    let live = true;
    setLoading(true);
    api
      .getAdventureState(chat.id)
      .then((s) => live && setState(s.text))
      .catch((e: Error) => live && toast.error(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, chat]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveAdventureState(chat.id, state);
      onChatChanged(await api.updateAdventure(chat.id, { adventure: enabled, directorStyle: style }));
      toast.success(enabled ? 'Adventure saved' : 'Adventure mode is off');
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
          <DialogTitle>Adventure</DialogTitle>
          <DialogDescription>
            A Director decides what happens - what your actions achieve, who turns up, where the story goes - and the
            character writes it. Start a message with <code>/d </code> to suggest something to the Director alone.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-6 overflow-y-auto px-6 py-5">
          <Checkbox checked={enabled} onChange={setEnabled} label="Adventure mode for this chat" className="text-sm" />

          <div className={cn('grid gap-3', !enabled && 'opacity-60')}>
            <Label>Director style</Label>
            <div className="grid grid-cols-3 gap-2">
              {STYLES.map((s) => (
                <Button
                  key={s.value}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={style === s.value}
                  onClick={() => setStyle(s.value)}
                  className={cn(
                    style === s.value && 'border-primary bg-primary/5 text-primary dark:border-primary dark:bg-primary/10',
                  )}
                >
                  {s.label}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">{STYLES.find((s) => s.value === style)?.hint}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="adventure-state">Adventure State</Label>
            <Textarea
              id="adventure-state"
              className="max-h-[40vh] min-h-56 font-mono text-xs"
              placeholder={PLACEHOLDER}
              value={state}
              disabled={loading}
              onChange={(e) => setState(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The Director's notes: who it has introduced, the threads it is following and the rules of the world. It
              rewrites this as the story goes. The character sees only the Cast; delete a thread and the Director
              drops it.
            </p>
          </div>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={loading || saving}>
            {saving && <LoaderCircle className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
