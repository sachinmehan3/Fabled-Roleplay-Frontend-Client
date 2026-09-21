import { useEffect, useMemo, useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useImageUrl } from '@/hooks/use-image-url';
import { Button } from '@/components/ui/button';

interface Props {
  /** Id of the picture already saved in this browser. */
  file: string | null;
  /** Newly picked image, not uploaded yet. */
  pending: File | null;
  /** True when the saved sprite is staged for removal. */
  cleared: boolean;
  onChange: (file: File | null) => void;
}

export function SpritePicker({ file, pending, cleared, onChange }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (pending ? URL.createObjectURL(pending) : null), [pending]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const stored = useImageUrl(file);
  const shown = preview ?? (cleared ? null : stored);

  return (
    <div className="flex items-end gap-4">
      {/* Tall and uncropped, the way sprite mode shows it. */}
      <div className="bg-muted flex aspect-[3/4] w-28 shrink-0 items-end justify-center overflow-hidden rounded-xl border">
        {shown ? (
          <img src={shown} alt="" className="size-full object-contain object-bottom" />
        ) : (
          <span className="text-muted-foreground self-center px-2 text-center text-xs">No sprite</span>
        )}
      </div>
      <div className="grid gap-2">
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            <ImagePlus />
            {shown ? 'Change sprite' : 'Upload sprite'}
          </Button>
          {shown && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
              <X />
              Remove
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          A tall picture of the character, shown large in sprite mode. A PNG with a transparent background looks best.
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onChange(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
