# BreezeTTS2 语音朗读

在 DeepSeek Harness 中，用 Breeze TTS 朗读助手回复。

## 安装

- **Git**：`github:hangdingding/dsh-breezetts`
- **Release**：下载 `local-breeze-voice-x.y.z.tgz`，解压后在插件管理页安装该目录

## 需要准备什么

1. **API Key**：在 Breeze 开发者控制台创建，`brz_` 开头。
2. **voice_id**：在 Breeze Studio 选一个音色，复制 `voc_` 开头的 ID。

安装后打开任意会话：没有 Key 时会自动弹出设置面板，粘贴 Key 保存即可开始朗读。

所有设置都在插件面板里完成，不需要改配置文件。
