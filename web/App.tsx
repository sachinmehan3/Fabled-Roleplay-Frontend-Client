import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api';
import type { Character, Chat, Settings } from '@/types';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/hooks/use-confirm';
import { AppSidebar } from '@/components/app-sidebar';
import { ChatView } from '@/components/chat-view';
import { CharacterDialog } from '@/components/character-dialog';
import { CharacterGallery } from '@/components/character-gallery';
import { LorebookDialog } from '@/components/lorebook-dialog';
import { EmptyState } from '@/components/empty-state';
import { SettingsDialog, type SettingsTab } from '@/components/settings-dialog';
import { ImportDialog } from '@/components/import-dialog';

const LAST_OPEN_KEY = 'rp-last-open';

function readLastOpen(): { characterId: number; chatId: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_OPEN_KEY) ?? 'null');
    return typeof saved?.characterId === 'number' && typeof saved?.chatId === 'number' ? saved : null;
  } catch {
    return null;
  }
}

export function App() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const [editorOpen, setEditorOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [lorebooksOpen, setLorebooksOpen] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null); // null = creating a new card
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile slide-over
  const [railOpen, setRailOpen] = useState(() => {
    try {
      return localStorage.getItem('rp-sidebar') !== 'closed'; // desktop column
    } catch {
      return true;
    }
  });
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('rp-sidebar', railOpen ? 'open' : 'closed');
    } catch {
      /* storage unavailable */
    }
  }, [railOpen]);

  // One control reopens it at any width: the two states never apply at the same breakpoint.
  const openSidebar = () => {
    setRailOpen(true);
    setSidebarOpen(true);
  };

  const character = characters.find((c) => c.id === characterId) ?? null;

  // Run an async action and surface failures as a toast.
  const run = useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      (...args: A) => {
        fn(...args).catch((e: Error) => toast.error(e.message));
      },
    [],
  );

  const refreshChats = useCallback(async (charId: number) => {
    const list = await api.listChats(charId);
    setChats(list);
    return list;
  }, []);

  useEffect(() => {
    run(async () => {
      const [s, cs] = await Promise.all([api.getSettings(), api.listCharacters()]);
      setSettings(s);
      setCharacters(cs);
      if (!s.model) setSettingsOpen(true);

      // Reopen the chat from last time, as long as it is still there.
      const last = readLastOpen();
      if (!last || !cs.some((c) => c.id === last.characterId)) return;
      const list = await refreshChats(last.characterId);
      setCharacterId(last.characterId);
      const chat = list.find((c) => c.id === last.chatId) ?? list[0];
      if (chat) setChatId(chat.id);
    })();
  }, [run, refreshChats]);

  // Only ever written, never cleared: a stale entry is ignored on the way back in,
  // and clearing it would race with the restore above on a fresh load.
  useEffect(() => {
    if (!characterId || !chatId) return;
    try {
      localStorage.setItem(LAST_OPEN_KEY, JSON.stringify({ characterId, chatId }));
    } catch {
      /* storage unavailable */
    }
  }, [characterId, chatId]);

  const openCharacter = async (id: number) => {
    setCharacterId(id);
    setSidebarOpen(false);
    const list = await refreshChats(id);
    if (list.length) {
      setChatId(list[0].id);
    } else {
      const chat = await api.createChat(id); // first visit: start a chat automatically
      await refreshChats(id);
      setChatId(chat.id);
    }
  };

  const importCharacter = async (source: File | string) => {
    const c = typeof source === 'string' ? await api.importCharacterFromUrl(source) : await api.importCharacter(source);
    setCharacters(await api.listCharacters());
    toast.success(
      c.lorebook ? `Imported ${c.name}, with ${c.lorebook.entries} lorebook entries` : `Imported ${c.name}`,
    );
    await openCharacter(c.id);
  };

  const openEditor = (target: Character | null) => {
    setEditing(target);
    setEditorOpen(true);
    setSidebarOpen(false);
  };

  // A new card opens its first chat; an edited one just refreshes in place.
  const characterSaved = async (saved: Character, isNew: boolean) => {
    setCharacters(await api.listCharacters());
    if (isNew) await openCharacter(saved.id);
  };

  const openSettings = (tab: SettingsTab = 'connection') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSidebarOpen(false);
  };

  const deleteCharacter = async (id: number) => {
    const c = characters.find((x) => x.id === id);
    const ok = await confirm({
      title: `Delete ${c?.name ?? 'character'}?`,
      description: 'This permanently removes the character and all of its chats.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteCharacter(id);
    setCharacters((cs) => cs.filter((x) => x.id !== id));
    if (characterId === id) {
      setCharacterId(null);
      setChats([]);
      setChatId(null);
    }
    toast.success(`Deleted ${c?.name ?? 'character'}`);
  };

  const newChat = async (charId: number) => {
    const chat = await api.createChat(charId);
    setCharacterId(charId);
    await refreshChats(charId);
    setChatId(chat.id);
    setSidebarOpen(false);
  };

  const deleteChat = async (id: number) => {
    if (!characterId) return;
    const ok = await confirm({
      title: 'Delete this chat?',
      description: 'All messages in this chat will be permanently removed.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api.deleteChat(id);
    const list = await refreshChats(characterId);
    if (chatId === id) setChatId(list[0]?.id ?? null);
  };

  const sidebarProps = {
    characters,
    selectedCharacterId: characterId,
    chats,
    selectedChatId: chatId,
    onSelectCharacter: run(openCharacter),
    onImport: () => setImportOpen(true),
    onCreateCharacter: () => openEditor(null),
    onBrowseCharacters: () => {
      setGalleryOpen(true);
      setSidebarOpen(false);
    },
    onEditCharacter: (id: number) => openEditor(characters.find((c) => c.id === id) ?? null),
    onDeleteCharacter: run(deleteCharacter),
    onNewChat: run(newChat),
    onSelectChat: (id: number) => {
      setChatId(id);
      setSidebarOpen(false);
    },
    onRenameChat: run(async (id: number, title: string) => {
      await api.renameChat(id, title);
      if (characterId) await refreshChats(characterId);
    }),
    onDeleteChat: run(deleteChat),
    onOpenSettings: (tab: SettingsTab) => openSettings(tab),
    onOpenLorebooks: () => {
      setLorebooksOpen(true);
      setSidebarOpen(false);
    },
  };

  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onFile={importCharacter} onUrl={importCharacter} />

      {/* Desktop sidebar. The wrapper animates its width while the panel inside keeps
          its own, so the contents slide out of view instead of reflowing. */}
      <div
        className={cn(
          'hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none md:block',
          railOpen ? 'w-72' : 'w-0',
        )}
        inert={!railOpen}
      >
        <AppSidebar {...sidebarProps} onClose={() => setRailOpen(false)} />
      </div>

      {/* Mobile sidebar (slide-over) */}
      <div
        className={cn('fixed inset-0 z-40 md:hidden', !sidebarOpen && 'pointer-events-none')}
        inert={!sidebarOpen}
        aria-hidden={!sidebarOpen}
      >
        <div
          className={cn('absolute inset-0 bg-black/50 transition-opacity motion-reduce:transition-none', sidebarOpen ? 'opacity-100' : 'opacity-0')}
          onClick={() => setSidebarOpen(false)}
        />
        <AppSidebar
          {...sidebarProps}
          className={cn(
            'absolute inset-y-0 left-0 shadow-xl transition-transform duration-200 motion-reduce:transition-none',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        />
      </div>

      <main className="min-w-0 flex-1">
        {character && chatId && settings ? (
          <ChatView
            key={chatId}
            chatId={chatId}
            character={character}
            settings={settings}
            onMessagesChanged={() => refreshChats(character.id).catch(() => {})}
            onOpenSidebar={openSidebar}
            sidebarCollapsed={!railOpen}
            onBranched={run(async (id: number) => {
              await refreshChats(character.id);
              setChatId(id);
            })}
            onEditCharacter={() => openEditor(character)}
            onEditUser={() => openSettings('user')}
            onToggleSpriteMode={run(async () => setSettings(await api.saveSettings({ spriteMode: !settings.spriteMode })))}
          />
        ) : (
          <EmptyState
            hasModel={!!settings?.model}
            hasCharacters={characters.length > 0}
            onImport={() => setImportOpen(true)}
            onCreate={() => openEditor(null)}
            onOpenSettings={() => openSettings('connection')}
            onOpenSidebar={openSidebar}
            sidebarCollapsed={!railOpen}
          />
        )}
      </main>

      <LorebookDialog open={lorebooksOpen} onOpenChange={setLorebooksOpen} characters={characters} />

      <CharacterGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        characters={characters}
        selectedId={characterId}
        onSelect={(id) => {
          setGalleryOpen(false);
          run(openCharacter)(id);
        }}
        onEdit={(id) => {
          setGalleryOpen(false);
          openEditor(characters.find((c) => c.id === id) ?? null);
        }}
        onDelete={run(deleteCharacter)}
        onCreate={() => {
          setGalleryOpen(false);
          openEditor(null);
        }}
        onImport={() => {
          setGalleryOpen(false);
          setImportOpen(true);
        }}
      />

      <CharacterDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        character={editing}
        onSaved={run(characterSaved)}
      />

      {settings && (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onSaved={setSettings}
          tab={settingsTab}
        />
      )}
    </div>
  );
}
