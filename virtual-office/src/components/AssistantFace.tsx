/** 맹비서의 얼굴. **한 군데서만 정의한다.**
 *
 *  사장님 지적: 같은 화면에서 맹비서가 어떤 곳에선 사진, 어떤 곳에선 로봇
 *  이모지(🤖)로 나온다. 한 인격이 창마다 다른 얼굴이면 두 명처럼 보인다.
 *
 *  이모지를 각자 박아 두었던 게 원인이다. 얼굴이 필요한 곳은 전부 이
 *  컴포넌트를 쓴다 — 그래야 바꿀 때 한 번만 바꾼다.
 *
 *  그림은 디스코드 봇의 실제 아바타다(`public/assets/assistant/SOURCE.md`).
 *  디스코드에서 보던 얼굴과 웹에서 보는 얼굴이 같아야 한 사람으로 읽힌다.
 */

/** 파일이 없을 때 쓸 글자. 깨진 이미지 아이콘보다 낫다. */
const FALLBACK = '🙂';

export default function AssistantFace({ size }: { size?: number }) {
  return (
    <img
      className="assistant-face"
      src="/assets/assistant/mengbiseo.png"
      alt="맹비서"
      /* 장식이 아니라 "누가 말하나" 를 나타내므로 alt 를 비우지 않는다. */
      style={size ? { width: size, height: size } : undefined}
      onError={e => {
        // 이미지가 없으면 글자로 되돌린다. 숨기기만 하면 빈 칸이 남아
        // 아바타 자리가 어긋난다.
        const el = e.currentTarget;
        el.style.display = 'none';
        const p = el.parentElement;
        if (p && !p.dataset.faceFallback) {
          p.dataset.faceFallback = '1';   // 두 번 붙지 않게
          p.insertAdjacentText('beforeend', FALLBACK);
        }
      }}
    />
  );
}
