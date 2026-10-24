import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Bot, User } from '../api/types';

interface AppState {
  user: User | null;
  themeMode: 'light' | 'dark';
  bots: Bot[];
  currentBotId: string | null;
  setUser: (u: User | null) => void;
  toggleTheme: () => void;
  setBots: (b: Bot[]) => void;
  setCurrentBotId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      themeMode: 'dark',
      bots: [],
      currentBotId: null,
      setUser: (user) => set({ user }),
      toggleTheme: () => set((s) => ({ themeMode: s.themeMode === 'dark' ? 'light' : 'dark' })),
      setBots: (bots) => set({ bots }),
      setCurrentBotId: (currentBotId) => set({ currentBotId }),
    }),
    {
      name: 'littly-console',
      partialize: (s) => ({ themeMode: s.themeMode, currentBotId: s.currentBotId }) as Pick<AppState, 'themeMode' | 'currentBotId'>,
    },
  ),
);
