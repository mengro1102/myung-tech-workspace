import { useEffect, useState } from 'react';

/* 브라우저에만 남는 저장소.
 *
 * 관리 탭의 할 일·등록 서비스·승인 큐는 React state 뿐이었다. 입력해 놓고
 * 새로고침하면 사라졌다 — 저장되는 줄 알고 쓰다가 잃는 쪽이, 저장 안 된다고
 * 알고 쓰는 것보다 나쁘다.
 *
 * 서버에 두는 편이 옳지만 그건 스키마와 API 가 따로 필요한 일이다. 우선
 * localStorage 에 붙여 "적은 것이 남는다"는 최소한을 맞춘다. 이 PC 의 이
 * 브라우저에만 남는다는 점은 화면에 적어 둔다.
 */
export function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;                       // 사생활 보호 모드 등에서 던진다
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장 못 해도 화면은 계속 돈다 */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
