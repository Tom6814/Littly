import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { bots } from './api/endpoints';
import { useAppStore } from './stores/appStore';
import type { Bot, User } from './api/types';

/** 拉取机器人列表并同步到全局 store；保证 currentBotId 有效。 */
export function useBots() {
  const setBots = useAppStore((s) => s.setBots);
  const currentBotId = useAppStore((s) => s.currentBotId);
  const setCurrentBotId = useAppStore((s) => s.setCurrentBotId);

  const query = useQuery({ queryKey: ['bots'], queryFn: bots.list, staleTime: 60_000 });

  useEffect(() => {
    if (!query.data) return;
    setBots(query.data.bots);
    const valid = query.data.bots.some((b) => b.id === currentBotId);
    if (!valid && query.data.bots.length > 0) {
      setCurrentBotId(query.data.current ?? query.data.bots[0]?.id ?? null);
    }
  }, [query.data, currentBotId, setBots, setCurrentBotId]);

  return query;
}

export function useCurrentBot(): Bot | undefined {
  const list = useAppStore((s) => s.bots);
  const id = useAppStore((s) => s.currentBotId);
  return useMemo(() => list.find((b) => b.id === id) ?? list[0], [list, id]);
}

/** botId 兜底：store 里有就用，否则取当前 bot。 */
export function useBotId(): string | null {
  const bot = useCurrentBot();
  const id = useAppStore((s) => s.currentBotId);
  return id ?? bot?.id ?? null;
}

export function useUser(): User | null {
  return useAppStore((s) => s.user);
}
