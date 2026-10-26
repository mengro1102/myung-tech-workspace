/** 프로젝트 상태 → KPI·필터 묶음. App(KPI)과 ProjectsTab(필터)이 같이 쓴다.
 *
 *  따로 둔 이유: ProjectsTab 은 지연 로딩한다. App 이 거기서 이것만 가져와도
 *  번들이 통째로 앞으로 끌려온다.
 *
 *  착수 승인 대기는 '진행 중' 이다. 그 승인은 결재함에도 한 줄로 올라오므로,
 *  따로 '대기' 로 세면 같은 것이 결재 대기와 여기서 두 번 세어진다 — 전 칸반이
 *  그랬다(결재 행 + 프로젝트 카드). */
import type { ProjectStatus } from '../api';

export type PjGroup = 'all' | 'live' | 'done' | 'stopped';

export const GROUP_OF: Record<ProjectStatus, Exclude<PjGroup, 'all'>> = {
  intake: 'live', planning: 'live', awaiting_approval: 'live', running: 'live',
  done: 'done', paused: 'stopped', cancelled: 'stopped',
};

export const GROUP_LABEL: Record<PjGroup, string> = {
  all: '전체', live: '진행 중', done: '완료', stopped: '중단',
};
