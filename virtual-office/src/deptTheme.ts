/* 부서 색 — 이 파일 하나가 기준이다.
 *
 * 예전에는 부서 색이 세 군데에 따로 있었다. 사무실 방(officeLayout), 사무실
 * 아래 부서 칩(OfficeView), 대화·피드·팀 목록(api.ts deptColors). 같은 연구부가
 * 방에서는 파랑, 칩에서는 청록, 대화 프로필에서는 초록이었다 — 사무실에서
 * 파란 방의 사람이 대화 패널에서는 초록 동그라미로 나오니 누가 누구인지
 * 이어지지 않았다.
 *
 * 기준은 사무실 방 색이다. 사용자가 가장 오래 보는 화면이 거기라서다.
 */
export const DEPT_COLORS: Record<string, string> = {
  research_dept:      '#60a5fa',   // 학술연구부 — 파랑
  finance_dept:       '#fbbf24',   // 금융투자부 — 노랑
  orchestration_dept: '#0ffd6a',   // CEO실 · 회의실 — 초록
  dev_dept:           '#a78bfa',   // 개발실 — 보라
  content_dept:       '#f472b6',   // 콘텐츠생산부 — 분홍
};

export const DEPT_FALLBACK = '#94a3b8';

export function deptColor(dept?: string): string {
  return (dept && DEPT_COLORS[dept]) || DEPT_FALLBACK;
}

/** 옅은 배경용. '#rrggbb' → 'rgba(r,g,b,a)' */
export function deptTint(dept: string | undefined, alpha: number): string {
  const hex = deptColor(dept).replace('#', '');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
