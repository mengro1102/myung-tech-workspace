/* 프로젝트 탭의 **구역 한 칸**.
 *
 * ## 왜 이게 생겼나
 *
 * 사장님: "컴포넌트간 공백도 통일화가 되어있지 않고 … 구조적으로는 깔끔한데
 * 사용하고 활용하는 측면에서는 그렇지 않다. 이전에도 개선을 요청했는데 왜
 * 온전히 반영되지 않았나?"
 *
 * 재 봤다. 프로젝트 탭은 **서로 모르는 다섯 덩어리**를 세로로 쌓은 화면이다
 * (결재함·배운 것·프로젝트·노트·휴지통). 그리고 각자 자기 머리글을 따로
 * 만들어 쓰고 있었다.
 *
 *     머리글 글씨     16px · 16px · 15px · 13px      ← 넷이 다 다르다
 *     머리글 간격     8px · 10px · 8px · 기본
 *     구역 사이 간격  20px · 60px · 10px             ← 셋이 다 다르다
 *     안쪽 간격       22px · 12px
 *     버튼 높이       30px · 32px · 34px · 36px      ← 넷이 다 다르다
 *     카드 모서리     10px · 11px                    ← 1px 차이
 *
 * **이게 "왜 반영이 안 됐나" 의 답이다.** 지난번에 고친 것은 한 덩어리였고,
 * 나머지 넷은 자기 값을 그대로 들고 있었다. 공유하는 그릇이 없으니 한 곳을
 * 고쳐도 옆이 안 따라온다 — 규율로 맞출 수 있는 것이 아니다.
 *
 * 그래서 그릇을 만든다. **머리글·여백·접기는 여기서만 정한다.** 다섯 덩어리는
 * 내용만 넣는다. 다음에 여섯 번째가 와도 자동으로 같은 모양이 된다.
 *
 * ## 접기는 왜 버튼인가
 *
 * 머리글 전체를 누르게 하면 그 안의 버튼(「전체 선택」 같은 것)을 누를 때마다
 * 구역이 접힌다. 그래서 **제목 묶음만** 버튼이고, 오른쪽 조작부는 바깥이다.
 */
import type { ReactNode } from 'react';

type Props = {
  /** 머리글 왼쪽의 그림문자. 글이 아니라 표시라 읽어 주지 않는다. */
  icon?: string;
  title: string;
  /** 제목 옆 회색 한 마디 — 「3건 대기」 「비어 있음」. 숫자는 여기 둔다. */
  count?: ReactNode;
  /** 오른쪽 끝 조작부. 접기 버튼 바깥이라 눌러도 안 접힌다. */
  actions?: ReactNode;
  /** 조작부 왼쪽의 설명 한 줄. 좁아지면 먼저 사라진다. */
  hint?: ReactNode;
  /** 넘기지 않으면 접지 않는 구역이 된다(머리글이 버튼이 아니다). */
  open?: boolean;
  onToggle?: () => void;
  /** 다른 화면에서 이 구역으로 스크롤해 올 때 쓰는 닻. */
  id?: string;
  className?: string;
  children?: ReactNode;
};

export default function Section({
  icon, title, count, actions, hint, open, onToggle, id, className, children,
}: Props) {
  const collapsible = typeof onToggle === 'function';
  const shown = collapsible ? open !== false : true;

  const head = (
    <>
      {/* 접히지 않는 구역에도 **자리는 비워 둔다.** 안 그러면 꺾쇠가 있는
          구역만 제목이 16px 밀려, 다섯 줄의 글머리가 서로 어긋난다
          (실측: 제목 왼쪽 끝이 118 · 118 · 102 · 102 · 109 로 네 군데였다). */}
      <span className={`sec-chev ${collapsible ? (shown ? 'open' : '') : 'none'}`}
            aria-hidden="true">▾</span>
      {icon && <span className="sec-icon" aria-hidden="true">{icon}</span>}
      <span className="sec-title">{title}</span>
      {count != null && count !== '' && <span className="sec-count">{count}</span>}
    </>
  );

  return (
    <section className={`sec ${className ?? ''}`} id={id} aria-label={title}>
      <header className="sec-head">
        {collapsible ? (
          <button type="button" className="sec-grip" onClick={onToggle}
                  aria-expanded={shown} title={shown ? '접기' : '펼치기'}>
            {head}
          </button>
        ) : (
          <h2 className="sec-grip static">{head}</h2>
        )}
        {hint && <span className="sec-hint">{hint}</span>}
        {actions && <div className="sec-actions">{actions}</div>}
      </header>
      {shown && children != null && <div className="sec-body">{children}</div>}
    </section>
  );
}
