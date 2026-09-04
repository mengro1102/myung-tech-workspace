# 오피스 픽셀 아트 출처

이 디렉터리의 스프라이트는 직접 그린 것이 아니라 가져온 것이다. 재배포 조건을
지키기 위해 출처를 남긴다.

## 가구 · 바닥 · 벽 · 카펫

- 출처: [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
  (`webview-ui/public/assets/`)
- 저작권: Copyright (c) 2026 Pablo De Lucca
- 라이선스: **MIT**

MIT 는 저작권 고지와 라이선스 전문을 함께 배포할 것을 요구한다. 전문은 같은
디렉터리의 `LICENSE-pixel-agents.txt` 에 두었다.

## 캐릭터 (`characters/char_*.png`)

- 원본: [JIK-A-4 — MetroCity Free Topdown Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)
- 라이선스: **CC0 1.0 (Public Domain Dedication)**

CC0 는 출처 표기를 요구하지 않지만 제작자가 "크레딧은 필수는 아니나 있으면
고맙다"고 밝혀 두었으므로 남긴다. pixel-agents 가 이 팩을 다듬어 시트로 만든
것을 그대로 가져왔다.

## 스프라이트 시트 규격

포맷을 바꾸지 않고 원본 그대로 쓴다. 렌더러가 이 규격에 의존한다.

| 종류 | 파일 | 크기 | 구성 |
|---|---|---|---|
| 캐릭터 | `characters/char_N.png` | 112×96 | 16×32 프레임 7개 × 3행. 행 = down/up/right, 프레임 = walk 0·1·2, typing 3·4, reading 5·6. left 는 right 를 좌우 반전 |
| 바닥 | `floors/floor_N.png` | 16×16 | 회색조. 방 색으로 틴트해서 쓴다 |
| 벽 | `walls/wall_0.png` | 64×128 | 16×32 스프라이트 16개(4×4). 인덱스 = N·E·S·W 4비트 마스크 |
| 카펫 | `carpets/carpet_N.png` | 64×64 | 16×16 타일 16개(4×4). 인덱스 = 이웃 마스크 |
| 가구 | `furniture/<ID>/manifest.json` | 가변 | `type: asset` 은 단일 스프라이트, `type: group` 은 방향별 members |

가구 좌표는 16px 타일 단위(`footprintW`/`footprintH`)로 표현된다.
