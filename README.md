# BreezeTTS2 语音朗读（@local/breeze-voice）

在每条已完成的助手回复的操作栏里加一个喇叭按钮：点击后把回复文字交给 Breeze TTS 合成语音并播放，
再次点击停止。API Key 只留在 Host 侧，浏览器拿不到。

## 安装

- **Git**（推荐）：`github:<你的账号>/breeze-voice`，或锁定版本 `github:<你的账号>/breeze-voice#v1.0.0`；
  Gitee 用 `git+https://gitee.com/<你的账号>/breeze-voice.git`。
- **Release 压缩包**：下载 `local-breeze-voice-x.y.z.tgz`，解压后在插件管理页安装该目录。
- **npm**（如已发布）：包名，例如 `@breezeblue/dsh-breeze-voice`。

发布到 GitHub/Gitee、打 Release、发 npm 的完整步骤见 [PUBLISHING.md](PUBLISHING.md)。

## 需要准备什么

1. **API Key**：在 [Breeze 开发者控制台](https://breezeblue.ai/app/developer/api-keys) 创建，
   形如 `brz_xxxxxxxx`。只在创建时显示一次，记得先存好。
2. **voice_id**：在 [Breeze Studio](https://breezeblue.ai/app) 里挑一个音色并复制其 ID（`voc_` 开头）。
   配好 Key 之后也可以直接在本机查：

   ```bash
   curl -s http://127.0.0.1:58449/breeze-voice/voices | head -c 800
   ```

## 配置（3 步）

1. 打开 `cordis.patch.yml`（就在这个目录），填入 `apiKey` 与 `voiceId`：

   ```yaml
   - insert:
       - id: breeze-voice
         name: '@local/breeze-voice'
         config:
           protocol: breezeblue
           baseUrl: 'https://api.breeze.blue'
           apiKey: 'brz_你的密钥'
           voiceId: 'voc_你的音色'
           modelId: ''
           languageCode: ''
           outputFormat: 'mp3'
           speed: 1
           instructions: ''
           maxChars: 2000
   ```

2. 重启 DeepSeek Harness（Host 启动时读取这份配置）。
3. 打开任意一条已经生成完的助手回复，点操作栏里的喇叭按钮。

## 设置面板

输入框下方的 **Breeze** 按钮会弹出设置面板，用户不用改 YAML：

- **API Key**：密码框，已保存的只显示末四位（`••••Jlky`），留空表示不修改。
- **音色**：当前音色卡片 + 试听；搜索框按名称/描述查 Breeze 音色库，点「使用」选中，
  试听走免费 `preview_url`，不消耗额度。
- **语速**：0.5–2 倍，保存后立即生效。
- **保存**：写入插件目录的 `settings.json`，下一次请求就用新配置；头像、播放条、名字同步刷新。

插件在插件管理页的显示名是 **BreezeTTS2**。

## 未登录时的引导

未配置 Key 时，页面加载约 2.5 秒后自动弹出 Breeze 面板：

- 左侧：API Key 输入框（可手动粘贴）；
- 右侧福利卡主按钮「登录获取 API Key」→ 新窗口打开
  https://breezeblue.ai/app/developer/api-keys ，登录后在控制台创建 Key；
- 回到面板粘贴保存，余额立即出现在 Key 下方。

已登录时 Key 下方显示余额和「退出登录」。

## 邀请朋友## 邀请朋友## 邀请朋友

设置面板里有一张紫色的邀请卡：**邀请朋友，双方得积分**。左侧文案说明分享规则，右侧是插画，
按钮「复制邀请文案」会把下面这段（含兑换码和链接）复制到剪贴板：

```
我在用 Breeze 语音朗读插件，Breeze 注册就送 1000–10000 积分（兑换码 BREEZEBLUE）：
https://breezeblue.ai/zh/app/subscription?gift=BREEZEBLUE
```

「打开邀请页」在新窗口打开同一个链接。要换成你自己的推荐链接（这样好友注册后你也能拿推荐奖励），
把 `client.js` 里的 `PROMO_URL` 换成你的专属链接即可。

## 自动朗读

输入框下方的「自动朗读」开关默认**开启**（偏好保存在浏览器 localStorage）。每条新回复生成完，
插件会自动朗读；播放条里可以随时停止。页面第一次加载时不会重播历史回复。

浏览器如果拦截自动播放，会自动降级为手动：点「朗读上一条回复」即可。

## 新建音色

「音色」标题右侧有 **+ 新建音色**：填一段描述（3–500 字），可选一句试听台词，点「生成 3 个预览」，
Breeze 会返回 3 个候选（约 5 秒）。逐个试听、选中一个、命名，点「保存并使用」——新音色会存进
你的 Breeze 音色库，并立即设为当前朗读音色。

> 生成预览会消耗少量额度；保存后的音色可以在 Breeze Studio 里删除。

## 头像

Breeze 的音色对象只有试听音频（`preview_url`），**没有头像图片字段**。插件自带一张
`avatar.svg`（按「大肥鱼」画的卡通鱼），Host 直接以同源方式提供；想换就替换这个文件，
或把图片地址填到 `avatarUrl`（http/https，小于 2 MB，优先级更高）。Host 会代理远程图，
页面保持同源，也不受远程站点 CSP 限制：

```yaml
avatarUrl: 'https://你的图床/avatar.png'
```

## 接口与行为

插件在 Host 侧调用 Breeze 的
[Convert text to speech](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech)：

```http
POST https://api.breeze.blue/v1/text-to-speech/{voice_id}?output_format=mp3&delivery=sync
xi-api-key: brz_xxx
Content-Type: application/json

{"text":"要朗读的文字","model_id":"breeze-tts-2","language_code":"zh"}
```

- 鉴权用 `xi-api-key`（等价于 `Authorization: Bearer`）。
- `language_code` 留空时由服务端按语言自动选模型；写 `zh`/`en` 会固定到 `breeze-tts-2`。
- 官方单次限制默认 **1000 字**（部分账号可到 2000）。插件会在浏览器端按 800 字、
  在句号/换行处自动分段，逐段合成并按顺序播放，段与段之间预取，尽量无缝。
- 可选的 `instructions` 用来描述语气（如“温和、放慢一点”），语言与正文一致。

## 为什么用流式

Breeze 的同步接口要等整段音频生成完才返回：实测 250 字约 29 秒、800 字约 64 秒。
所以插件改用流式接口 `POST /v1/text-to-speech/{voice_id}/stream`，Host 边收边转发，
浏览器的 `<audio>` 边下边播——实测首字节不到 1 秒，长回复也能马上出声。

浏览器不支持流式时（或 `protocol: openai`）回退到同步分段播放：按 800 字切段、
逐段合成、顺序播放。

## 诊断日志

`debug.log` 会记录每次合成/播放的耗时、字节数与失败原因，以及页面加载的客户端版本
（`client` 字段）。排查“没声音”时先看这里。

## 自检

```bash
curl -s http://127.0.0.1:58449/breeze-voice/health
curl -s -X POST http://127.0.0.1:58449/breeze-voice/speak \
  -H 'content-type: application/json' \
  -d '{"text":"你好，这是一次朗读测试"}' -o /tmp/tts.mp3 -w '%{http_code} %{content_type}\n'
```

`health` 只显示非敏感配置（`hasApiKey` 而不是密钥本身）。`/breeze-voice/stream?text=...`
可以直接用 curl 测首字节时间。

## 常见错误

| 现象 | 原因 |
|---|---|
| `还没有配置 apiKey` / `voiceId` | 配置没填，或改完没有重启 |
| `401 AUTH_REQUIRED` | 密钥无效、被停用或复制不完整 |
| `402 API_KEY_CREDIT_LIMIT_EXCEEDED` | 该 Key 的额度或账户余额不足 |
| `413` | 单段超过 `maxChars`，正常情况不会触发（已自动分段） |
| `502` | Host 连不上 `api.breeze.blue`，或上游返回其它错误，`error` 里带原始信息 |

## 可选：自建 OpenAI 兼容接口

如果用的是自己部署的 BreezeTTS（vLLM-omni 等），把协议换成 `openai`：

```yaml
protocol: openai
endpoint: 'http://127.0.0.1:8000/v1/audio/speech'
model: 'Breeze-TTS-2'
voice: 'default'
```

此时请求体为 `{model, input, voice, response_format, speed}`，鉴权仍然是
`Authorization: Bearer <apiKey>`（`apiKey` 为空则不发送）。

## 说明

- 回复操作栏里的按钮就是音色头像；播放时变成停止方块，合成中显示转圈。这条操作栏只在鼠标移到回复上时出现。
- 输入框下方常驻的是 **Breeze**（设置）和「自动朗读」开关；播放时这里会变成带音色头像和停止按钮的
  播放条。手动朗读某一条回复，用回复末尾的头像按钮。
- 朗读前会去掉代码块、表格、链接语法等不适合朗读的 Markdown 记号。
- 这条消息没有可朗读文字时按钮置灰。
- 这不是语音输入（STT）。需要说话转文字时，启用内置的语音输入 Bundle。
