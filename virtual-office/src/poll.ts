/** 화면이 보일 때만 도는 폴링.
 *
 * `setInterval` 과 **똑같이** 쓰고 `clearInterval` 로 똑같이 정리한다 —
 * 돌려주는 것이 진짜 인터벌 id 라서 호출부를 바꿀 필요가 없다.
 *
 * 왜 필요한가. 대시보드는 가만히 둬도 분당 50회 서버를 두드렸다(실측
 * 2026-10-30). 사장님은 이 PC 로 다른 일을 하시고, 그동안 탭은 뒤에 있다.
 * 브라우저가 배경 탭 타이머를 늦추기는 해도 요청을 막지는 않는다.
 *
 * 돌아왔을 때 바로 새로고침하지는 않는다. 그러려면 visibilitychange
 * 리스너가 필요한데, 호출부는 clearInterval 로만 정리하므로 리스너가 남는다.
 * 가장 긴 주기가 30초이니 한 주기만 기다리면 된다.
 */
export function pollInterval(fn: () => void, ms: number): number {
  return window.setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
}
