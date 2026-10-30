# `src/components/call/`

- `CallOverlay.vue` —— 语音通话浮层（自包含：`POST /api/call/token` → `/call` WebSocket，PCM16/16kHz 上行 + MP3 流式下行）。
  用法：`<CallOverlay :bot-id="botId" :sender="sender" :open="callOpen" @close="callOpen = false" />`；
  可选 `ai-call-id` / `ai-reason` 用于接听 AI 主动来电。组件自己负责麦克风/AudioContext/WS/MediaSource 的释放。
