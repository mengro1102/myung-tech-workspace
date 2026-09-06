import { useCallback, useEffect, useState } from 'react';
import { api, type StoreCollection, type StoreItem } from './api';

/* 서버 저장소를 화면에 붙이는 훅.
 *
 * 할 일·등록 서비스·승인 큐는 잠깐 localStorage 에 있었다. 새로고침을
 * 견디게는 됐지만 에이전트가 읽을 수 없었다 — 태스크 보드가 "에이전트가
 * 자동으로 쌓는다"고 말하려면 서버에 있어야 한다.
 *
 * 에이전트도 같은 저장소에 쓰므로 화면이 그 변화를 알아야 한다. 폴링이
 * 촌스럽긴 해도, 이 규모에서 SSE 를 하나 더 여는 것보다 낫다.
 */
export function useStore<T extends StoreItem>(
  collection: StoreCollection,
  pollMs = 8000,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const d = await api.storeList<T>(collection);
    if (d) setItems(d.items ?? []);
    setLoaded(true);
  }, [collection]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  /* 아래 세 함수는 낙관적으로 화면을 먼저 바꾸고 서버에 보낸다. 실패하면
   * 서버 상태로 되돌린다 — 눌렀는데 아무 반응이 없는 것이 제일 나쁘다. */
  const add = useCallback(async (item: Record<string, unknown>) => {
    const r = await api.storeAdd<T>(collection, item);
    if (r?.ok && r.item) setItems(prev => [...prev, r.item]);
    else refresh();
    return r?.ok ?? false;
  }, [collection, refresh]);

  /* 서버가 후속 조치를 했으면(승인 → 태스크 재투입) 그것도 돌려준다.
   * 화면이 "승인했다"까지만 말하고 끝나면 무엇이 일어났는지 알 수 없다. */
  const update = useCallback(async (id: string, patch: Record<string, unknown>) => {
    setItems(prev => prev.map(x => (x.id === id ? { ...x, ...patch } as T : x)));
    const r = await api.storeUpdate<T>(collection, id, patch);
    if (!r?.ok) refresh();
    return r ?? null;
  }, [collection, refresh]);

  const remove = useCallback(async (id: string) => {
    setItems(prev => prev.filter(x => x.id !== id));
    const r = await api.storeRemove(collection, id);
    if (!r?.ok) refresh();
    return r?.ok ?? false;
  }, [collection, refresh]);

  return { items, loaded, refresh, add, update, remove };
}
