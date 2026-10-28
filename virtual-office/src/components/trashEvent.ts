/** 휴지통이 바뀌었다는 신호.
 *
 *  휴지통 상자(TrashBox)·프로젝트 목록·교훈 상자가 서로를 모르는 채로
 *  같은 사건에 반응해야 한다. 상수를 TrashBox 에 두면 그걸 쓰려는 쪽마다
 *  TrashBox 전체를 번들로 끌고 온다 — 그래서 파일 하나짜리로 뗀다.
 */
export const TRASH_EVENT = 'mt:trash-changed';

export function trashChanged() { window.dispatchEvent(new Event(TRASH_EVENT)); }
