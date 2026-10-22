# 맹비서 프로필 사진

디스코드 봇 `맹비스✨` (id `1544508520337121280`) 의 실제 아바타를
CDN 에서 내려받은 것입니다. 해시 `4e7e62f7b9b6be8647c9142c9df42f42`.

다시 받으려면:

```
GET https://discord.com/api/v10/users/@me   (Authorization: Bot <token>)
→ avatar 해시로 https://cdn.discordapp.com/avatars/<id>/<hash>.png?size=256
```

디스코드에서 프로필을 바꾸면 해시가 달라지므로 이 파일도 다시 받아야
합니다. 이모지로 돌아가지 않으려면 그때 같은 경로에 덮어쓰면 됩니다.
