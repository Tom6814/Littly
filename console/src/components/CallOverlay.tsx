import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CallIcon from '@mui/icons-material/Call';
import CallEndIcon from '@mui/icons-material/CallEnd';
import MicIcon from '@mui/icons-material/Mic';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { API_BASE, http } from '../api/client';
import { useUiStore } from '../stores/uiStore';

export interface PendingCall {
  id: string;
  reason: string;
  topic: string;
}

type CallState = 'off' | 'connecting' | 'active';

interface CallMessage {
  type: string;
  text?: string;
  message?: string;
  audio?: string;
}

/**
 * 语音通话面板（对应服务端 @littly/voice-call 的 /call WebSocket）。
 *
 * 协议与旧实现一致：
 *   wss://<host>/call?botId=..&sender=..[&ai=1&callId=..]
 *   服务端 → 客户端：ready / error / stt_interim / stt_final / ai_thinking /
 *                     ai_text / tts_start / tts_chunk / tts_chunk_end / call_end
 *   客户端 → 服务端：二进制帧 = 16kHz 单声道 PCM16 麦克风音频；
 *                     {type:'stop'} 挂断；{type:'interrupt'} 打断 TTS
 */
export default function CallOverlay({
  botId,
  sender,
  onCallEnd,
}: {
  botId: string;
  sender: string;
  /** 通话结束后通知外部刷新消息列表（通话卡片会落一条消息） */
  onCallEnd?: () => void;
}) {
  const showSnack = useUiStore((s) => s.showSnack);
  const [state, setState] = useState<CallState>('off');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [thinking, setThinking] = useState(false);
  const [incoming, setIncoming] = useState<PendingCall | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const ttsMsRef = useRef<MediaSource | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsBufRef = useRef<SourceBuffer | null>(null);
  const ttsQueueRef = useRef<ArrayBuffer[]>([]);
  const ttsEndedRef = useRef(false);
  const dismissedRef = useRef<Set<string>>(new Set());

  // AI 主动来电：轮询待接列表
  const callsQuery = useQuery({
    queryKey: ['call-requests', botId],
    queryFn: () => http.get<{ calls?: PendingCall[] }>('/api/call/requests', { botId }),
    enabled: !!botId && state === 'off',
    refetchInterval: 4000,
  });

  useEffect(() => {
    const calls = callsQuery.data?.calls ?? [];
    const fresh = calls.find((c) => !dismissedRef.current.has(c.id));
    if (fresh) setIncoming(fresh);
  }, [callsQuery.data]);

  const cleanup = useCallback(() => {
    try {
      procRef.current?.disconnect();
      procRef.current = null;
      sourceRef.current?.disconnect();
      sourceRef.current = null;
    } catch {
      /* ignore */
    }
    try {
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      ttsMsRef.current?.endOfStream();
    } catch {
      /* ignore */
    }
    ttsMsRef.current = null;
    ttsBufRef.current = null;
    ttsQueueRef.current = [];
    ttsEndedRef.current = false;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }, []);

  /** Fish 流式 MP3：MediaSource 边收边播（与旧实现同构） */
  const drainMp3 = useCallback(() => {
    const sb = ttsBufRef.current;
    if (!sb || sb.updating) return;
    const queue = ttsQueueRef.current;
    if (queue.length) {
      const buf = queue.shift();
      if (buf) {
        try {
          sb.appendBuffer(buf);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const ms = ttsMsRef.current;
    if (ttsEndedRef.current && ms && ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const initTtsPlayer = useCallback(() => {
    if (ttsMsRef.current) return;
    if (typeof MediaSource === 'undefined' || typeof Audio === 'undefined') return;
    const ms = new MediaSource();
    const audio = new Audio();
    ttsMsRef.current = ms;
    ttsAudioRef.current = audio;
    const url = URL.createObjectURL(ms);
    audio.src = url;
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer('audio/mpeg');
        ttsBufRef.current = sb;
        sb.addEventListener('updateend', () => drainMp3());
        drainMp3();
      } catch {
        /* 浏览器不支持 audio/mpeg 时静默降级为纯文本 */
      }
    });
  }, [drainMp3]);

  const wsUrl = useCallback(
    (initiator?: { ai?: boolean; callId?: string }) => {
      const q = `?botId=${encodeURIComponent(botId)}&sender=${encodeURIComponent(sender)}`;
      const tail = initiator?.ai && initiator.callId ? `&ai=1&callId=${encodeURIComponent(initiator.callId)}` : '';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (API_BASE) {
        const base = API_BASE.replace(/^http/, 'ws');
        return `${base}/call${q}${tail}`;
      }
      return `${proto}//${window.location.host}/call${q}${tail}`;
    },
    [botId, sender],
  );

  const startCall = useCallback(
    async (initiator?: { ai?: boolean; callId?: string }) => {
      if (state !== 'off' || !botId || !sender) return;
      setState('connecting');
      setHeard('');
      setReply('');
      setThinking(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        });
        streamRef.current = stream;

        const ws = new WebSocket(wsUrl(initiator));
        wsRef.current = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          setState('active');
          initTtsPlayer();
          const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctx) return;
          const ctx = new Ctx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          sourceRef.current = source;
          // 16kHz 下采样（ScriptProcessor 兼容所有浏览器；静音回放避免回声）
          const proc = ctx.createScriptProcessor(4096, 1, 1);
          procRef.current = proc;
          const gain = ctx.createGain();
          gain.gain.value = 0;
          const ratio = ctx.sampleRate / 16000;
          proc.onaudioprocess = (e) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const input = e.inputBuffer.getChannelData(0);
            const n = Math.floor(input.length / ratio);
            if (n <= 0) return;
            const out = new Int16Array(n);
            for (let i = 0; i < n; i++) {
              const v = input[Math.floor(i * ratio)] ?? 0;
              out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
            }
            ws.send(out.buffer);
          };
          source.connect(proc);
          proc.connect(gain);
          gain.connect(ctx.destination);
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          let msg: CallMessage;
          try {
            msg = JSON.parse(ev.data) as CallMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case 'stt_interim':
            case 'stt_final':
              setHeard(msg.text ?? '');
              break;
            case 'ai_thinking':
              setThinking(true);
              setReply('');
              break;
            case 'ai_text':
            case 'tts_text':
              setThinking(false);
              setReply(msg.text ?? '');
              break;
            case 'tts_start':
              initTtsPlayer();
              ttsEndedRef.current = false;
              break;
            case 'tts_chunk': {
              if (!msg.audio) break;
              try {
                const bin = atob(msg.audio);
                const buf = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                ttsQueueRef.current.push(buf.buffer);
                drainMp3();
              } catch {
                /* ignore */
              }
              break;
            }
            case 'tts_chunk_end':
              ttsEndedRef.current = true;
              drainMp3();
              break;
            case 'call_end':
              cleanup();
              setState('off');
              onCallEnd?.();
              break;
            case 'error':
              showSnack(msg.message ?? '通话出错', 'error');
              cleanup();
              setState('off');
              break;
            default:
              break;
          }
        };

        ws.onclose = () => {
          cleanup();
          setState('off');
        };
        ws.onerror = () => {
          /* onclose 统一收尾 */
        };
      } catch (e) {
        showSnack(e instanceof Error ? e.message : '无法开始通话', 'error');
        cleanup();
        setState('off');
      }
    },
    [state, botId, sender, wsUrl, cleanup, initTtsPlayer, drainMp3, showSnack, onCallEnd],
  );

  const hangUp = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    else {
      cleanup();
      setState('off');
    }
  }, [cleanup]);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const active = state !== 'off';

  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="small"
          variant={active ? 'contained' : 'outlined'}
          color={active ? 'error' : 'primary'}
          startIcon={active ? <CallEndIcon /> : <CallIcon />}
          disabled={!botId || !sender}
          onClick={() => (active ? hangUp() : void startCall())}
        >
          {state === 'connecting' ? '接通中…' : active ? '挂断' : '语音通话'}
        </Button>
        {active && (
          <Button size="small" variant="text" startIcon={<MicIcon />} onClick={interrupt}>
            打断
          </Button>
        )}
      </Stack>

      {/* 来电接听框 */}
      <Dialog open={incoming !== null} onClose={() => {
        if (incoming) dismissedRef.current.add(incoming.id);
        setIncoming(null);
      }}>
        <DialogTitle>她打来电话了</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography variant="body2">原因：{incoming?.reason || '（她没说）'}</Typography>
            {incoming?.topic && <Typography variant="body2">想聊：{incoming.topic}</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              if (incoming) dismissedRef.current.add(incoming.id);
              setIncoming(null);
            }}
          >
            挂掉
          </Button>
          <Button
            variant="contained"
            startIcon={<CallIcon />}
            onClick={() => {
              const call = incoming;
              if (call) dismissedRef.current.add(call.id);
              setIncoming(null);
              void startCall({ ai: true, callId: call?.id });
            }}
          >
            接听
          </Button>
        </DialogActions>
      </Dialog>

      {/* 通话中面板 */}
      <Dialog open={active} fullWidth maxWidth="sm">
        <DialogTitle>
          <Stack direction="row" spacing={1} alignItems="center">
            <VolumeUpIcon color={state === 'active' ? 'success' : 'disabled'} />
            <span>语音通话</span>
            {thinking && <CircularProgress size={16} />}
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                听到的
              </Typography>
              <Typography variant="body1">{heard || '（还没听到声音）'}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                她说
              </Typography>
              <Typography variant="body1">{reply || (thinking ? '正在想…' : '（还没说话）')}</Typography>
            </Box>
            {state === 'connecting' && (
              <Alert severity="info" icon={<CircularProgress size={16} />}>
                正在接通…
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Chip size="small" label="16kHz PCM → 服务端识别" sx={{ mr: 1 }} />
          <Button color="error" variant="contained" startIcon={<CallEndIcon />} onClick={hangUp}>
            挂断
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
