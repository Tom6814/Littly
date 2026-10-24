import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import Avatar from '@mui/material/Avatar';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import dayjs from 'dayjs';
import { API_BASE } from '../api/client';
import { chat, contacts as contactsApi, normalizeMessage, normalizeToolCall } from '../api/endpoints';
import type { BufferState, ChatMessage, Contact, ToolCallEvent } from '../api/types';
import { useBotId, useCurrentBot } from '../hooks';
import { useAppStore } from '../stores/appStore';
import { errMsg, useUiStore } from '../stores/uiStore';
import Composer from './chat/Composer';
import MessageBubble from './chat/MessageBubble';
import { NoBotHint } from '../components/BotSwitcher';
import ConfirmDialog from '../components/ConfirmDialog';

const SILENCE_FALLBACK_MS = 15_000;

function dayLabel(d: dayjs.Dayjs): string {
  const now = dayjs();
  if (d.isSame(now, 'day')) return '今天';
  if (d.isSame(now.subtract(1, 'day'), 'day')) return '昨天';
  return d.format('M月D日');
}

/** 沉默终止态：她这轮没有说话。不是加载动画。 */
function SilenceRow() {
  return (
    <Tooltip title="她这轮没有说话">
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.disabled', letterSpacing: 4, cursor: 'default' }}>
          …
        </Typography>
      </Box>
    </Tooltip>
  );
}

function TypingRow() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', letterSpacing: 1 }}>
        她正在输入…
      </Typography>
    </Box>
  );
}

export default function ChatPage() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const bot = useCurrentBot();
  const botId = useBotId();
  const botList = useAppStore((s) => s.bots);
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const [searchParams, setSearchParams] = useSearchParams();
  const senderParam = searchParams.get('sender') ?? '';

  // 联系人
  const contactsQuery = useQuery({
    queryKey: ['contacts', botId],
    queryFn: () => contactsApi.list(botId ?? ''),
    enabled: !!botId,
  });
  const contactList: Contact[] = contactsQuery.data ?? [];
  const sender = senderParam || contactList[0]?.id || '';

  // 未选择 sender 时默认选第一个联系人
  useEffect(() => {
    if (!botId) return;
    if (!senderParam && contactList.length > 0) {
      setSearchParams({ sender: contactList[0]!.id }, { replace: true });
    }
  }, [botId, senderParam, contactList, setSearchParams]);

  // 历史消息
  const messagesQuery = useQuery({
    queryKey: ['messages', botId, sender],
    queryFn: () => chat.listMessages(botId ?? '', sender || undefined, 200),
    enabled: !!botId,
    refetchInterval: false,
  });

  // 缓冲窗口
  const bufferQuery = useQuery({
    queryKey: ['buffer', botId, sender],
    queryFn: () => chat.getBuffer(botId ?? '', sender || undefined),
    enabled: !!botId && !!sender,
    refetchInterval: 4000,
  });
  const buffer: BufferState | null = bufferQuery.data ?? null;
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const bufferRemainSec = useMemo(() => {
    if (!buffer?.fireAt) return null;
    const t = dayjs(buffer.fireAt).valueOf();
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.ceil((t - nowTick) / 1000));
  }, [buffer?.fireAt, nowTick]);
  const bufferCount = buffer?.count ?? buffer?.buffered ?? 0;
  const bufferActive = (bufferCount > 0 || (bufferRemainSec ?? 0) > 0) === true;

  // 流式追加的消息（SSE / 直发响应）
  const [streamed, setStreamed] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [silence, setSilence] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallEvent[]>([]);
  const [sseDown, setSseDown] = useState(false);

  const pendingSpeak = useRef(false);
  const gotAssistant = useRef(false);
  const silenceTimer = useRef<number | null>(null);

  const merged = useMemo(() => {
    const history = messagesQuery.data ?? [];
    if (streamed.length === 0) return history;
    const ids = new Set(history.map((m) => m.id));
    return [...history, ...streamed.filter((m) => !ids.has(m.id))];
  }, [messagesQuery.data, streamed]);

  const clearSilenceTimer = () => {
    if (silenceTimer.current !== null) {
      window.clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
  };

  const markAssistantArrived = () => {
    gotAssistant.current = true;
    pendingSpeak.current = false;
    setSilence(false);
    setThinking(false);
    clearSilenceTimer();
  };

  /** 发送 / flush 后开始等待她的回应；超时后仍无消息则展示沉默终止态。 */
  const beginAwaiting = () => {
    pendingSpeak.current = true;
    gotAssistant.current = false;
    setThinking(true);
    setSilence(false);
    clearSilenceTimer();
    silenceTimer.current = window.setTimeout(() => {
      if (pendingSpeak.current && !gotAssistant.current) {
        setThinking(false);
        setSilence(true);
      }
      pendingSpeak.current = false;
    }, SILENCE_FALLBACK_MS);
  };

  const appendMessages = (msgs: ChatMessage[]) => {
    if (msgs.length === 0) return;
    setStreamed((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      const fresh = msgs.filter((m) => !ids.has(m.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    if (msgs.some((m) => (m.role ?? 'assistant') !== 'user')) markAssistantArrived();
  };

  // 切换会话时清空流式状态
  useEffect(() => {
    setStreamed([]);
    setSilence(false);
    setThinking(false);
    setToolCalls([]);
    setSseDown(false);
  }, [botId, sender]);

  // SSE 订阅；出错时降级为轮询
  useEffect(() => {
    if (!botId || !sender) return;
    const url = `${API_BASE}/api/stream?botId=${encodeURIComponent(botId)}&sender=${encodeURIComponent(sender)}`;
    const es = new EventSource(url, { withCredentials: API_BASE !== '' });

    const onMessage = (ev: MessageEvent<string>) => {
      try {
        const raw: unknown = JSON.parse(ev.data);
        const msg = normalizeMessage(raw);
        const isAssistant = (msg.role ?? 'assistant') !== 'user';
        setStreamed((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        if (isAssistant) markAssistantArrived();
      } catch {
        /* 忽略无法解析的事件 */
      }
    };
    const onBuffer = (ev: MessageEvent<string>) => {
      try {
        const raw: unknown = JSON.parse(ev.data);
        const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        const state: BufferState = {
          fireAt: typeof rec.fireAt === 'string' ? rec.fireAt : undefined,
          count: typeof rec.count === 'number' ? rec.count : undefined,
          buffered: typeof rec.buffered === 'number' ? rec.buffered : undefined,
        };
        queryClient.setQueryData(['buffer', botId, sender], state);
      } catch {
        /* ignore */
      }
    };
    const onAgentStatus = (ev: MessageEvent<string>) => {
      try {
        const raw: unknown = JSON.parse(ev.data);
        const status = typeof raw === 'object' && raw !== null ? String((raw as Record<string, unknown>).status ?? '') : String(raw ?? '');
        if (status === 'thinking' || status === 'running') {
          setThinking(true);
          return;
        }
        if (status === 'silent' || status === 'silence') {
          setThinking(false);
          setSilence(true);
          pendingSpeak.current = false;
          return;
        }
        if (status === 'done' || status === 'idle') {
          setThinking(false);
          if (pendingSpeak.current && !gotAssistant.current) setSilence(true);
          pendingSpeak.current = false;
        }
      } catch {
        /* ignore */
      }
    };
    const onToolCall = (ev: MessageEvent<string>) => {
      try {
        const raw: unknown = JSON.parse(ev.data);
        const tool = normalizeToolCall(raw);
        if (!tool) return;
        setToolCalls((prev) => {
          const idx = prev.findIndex((t) => t.id === tool.id || t.name === tool.name);
          if (idx === -1) return [...prev, tool];
          const next = [...prev];
          next[idx] = { ...next[idx]!, ...tool };
          return next;
        });
        if (tool.status !== 'running') {
          window.setTimeout(() => {
            setToolCalls((prev) => prev.filter((t) => t.id !== tool.id));
          }, 2500);
        }
      } catch {
        /* ignore */
      }
    };

    es.addEventListener('message', onMessage);
    es.addEventListener('buffer', onBuffer);
    es.addEventListener('agent-status', onAgentStatus);
    es.addEventListener('tool-call', onToolCall);
    es.onerror = () => {
      es.close();
      setSseDown(true);
    };
    return () => {
      es.removeEventListener('message', onMessage);
      es.removeEventListener('buffer', onBuffer);
      es.removeEventListener('agent-status', onAgentStatus);
      es.removeEventListener('tool-call', onToolCall);
      es.close();
    };
  }, [botId, sender, queryClient]);

  // SSE 不可用时轮询兜底
  useEffect(() => {
    if (!sseDown || !botId || !sender) return;
    const t = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['messages', botId, sender] });
      void queryClient.invalidateQueries({ queryKey: ['buffer', botId, sender] });
    }, 4000);
    return () => window.clearInterval(t);
  }, [sseDown, botId, sender, queryClient]);

  // 发送
  const [sending, setSending] = useState(false);
  const invalidateMessages = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages', botId, sender] });
  };

  const handleSend = async (text: string) => {
    if (!botId || !sender) return;
    setSending(true);
    beginAwaiting();
    try {
      const msgs = await chat.send(botId, sender, text);
      if (msgs.length > 0) {
        appendMessages(msgs);
      }
      invalidateMessages();
    } catch (e) {
      showSnack(errMsg(e), 'error');
      setSilence(false);
      setThinking(false);
      clearSilenceTimer();
    } finally {
      setSending(false);
    }
  };

  const flushMutation = useMutation({
    mutationFn: () => chat.flushBuffer(botId ?? '', sender),
    onSuccess: (msgs) => {
      beginAwaiting();
      if (msgs.length > 0) appendMessages(msgs);
      invalidateMessages();
      void queryClient.invalidateQueries({ queryKey: ['buffer', botId, sender] });
      showSnack('已立即送达', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const regenerateMutation = useMutation({
    mutationFn: () => chat.regenerate(botId ?? '', sender),
    onSuccess: () => {
      beginAwaiting();
      invalidateMessages();
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  // 右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [editDialog, setEditDialog] = useState<{ message: ChatMessage; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [contactsDrawer, setContactsDrawer] = useState(false);

  const editMutation = useMutation({
    mutationFn: (input: { messageId: string; text: string }) =>
      chat.edit({ botId: botId ?? '', sender, messageId: input.messageId, text: input.text }),
    onSuccess: () => {
      setEditDialog(null);
      invalidateMessages();
      setStreamed([]);
      showSnack('已编辑并重新发送', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => chat.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidateMessages();
      showSnack('已删除', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const handleCopy = async (message: ChatMessage) => {
    const text = message.pieces
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showSnack('已复制', 'success');
    } catch {
      showSnack('复制失败', 'error');
    }
  };

  // 自动滚到底部
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [merged.length, thinking, silence]);

  if (!botId || botList.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <NoBotHint />
      </Box>
    );
  }

  const currentContact = contactList.find((c) => c.id === sender);

  const contactPicker = (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 1.5, py: 1 }}>
      {isMobile ? (
        <TextField
          select
          fullWidth
          size="small"
          label="联系人"
          value={sender}
          onChange={(e) => setSearchParams({ sender: e.target.value })}
        >
          {contactList.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
      ) : (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Avatar src={currentContact?.avatarUrl} sx={{ width: 30, height: 30, fontSize: 13 }}>
            {(currentContact?.name ?? '?').slice(0, 1)}
          </Avatar>
          <Typography variant="subtitle2">{currentContact?.name ?? '未选择联系人'}</Typography>
          <Box sx={{ flexGrow: 1 }} />
          {sseDown && (
            <Tooltip title="实时连接不可用，已切换为轮询">
              <Chip size="small" label="轮询中" variant="outlined" />
            </Tooltip>
          )}
          <Tooltip title="重新生成她的回复">
            <span>
              <IconButton
                size="small"
                disabled={regenerateMutation.isPending || !sender}
                onClick={() => regenerateMutation.mutate()}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      )}
    </Box>
  );

  const messageList = (
    <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: 'auto', px: { xs: 1.5, sm: 3 }, py: 2 }}>
      {messagesQuery.isPending && !messagesQuery.data ? (
        <Stack spacing={2} alignItems="center" py={4}>
          <CircularProgress size={22} />
        </Stack>
      ) : merged.length === 0 ? (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <Typography color="text.secondary" variant="body2">
            {sender ? '还没有对话，说第一句话吧。' : '先在「联系人」中创建一位联系人。'}
          </Typography>
        </Box>
      ) : (
        merged.map((m, i) => {
          const d = m.createdAt && dayjs(m.createdAt).isValid() ? dayjs(m.createdAt) : null;
          const prev = i > 0 ? merged[i - 1] : undefined;
          const prevD = prev?.createdAt && dayjs(prev.createdAt).isValid() ? dayjs(prev.createdAt) : null;
          const showDate = d && (!prevD || !d.isSame(prevD, 'day'));
          const own = m.role ? m.role === 'user' : m.sender === sender;
          return (
            <Box key={m.id}>
              {showDate && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 2 }}>
                  <Divider sx={{ flexGrow: 1 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                    {dayLabel(d)}
                  </Typography>
                  <Divider sx={{ flexGrow: 1 }} />
                </Box>
              )}
              <Box sx={{ mb: 1.25 }}>
                <MessageBubble
                  message={m}
                  own={own}
                  botName={bot?.name ?? '她'}
                  botAvatar={bot?.avatarUrl}
                  senderName={currentContact?.name}
                  senderAvatar={currentContact?.avatarUrl}
                  onContextMenu={(e: MouseEvent<HTMLDivElement>, msg) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, message: msg });
                  }}
                  onImageClick={(url) => setLightbox(url)}
                />
              </Box>
            </Box>
          );
        })
      )}
      {thinking && <TypingRow />}
      {!thinking && silence && <SilenceRow />}
    </Box>
  );

  const toolChips =
    toolCalls.length > 0 ? (
      <Stack direction="row" spacing={0.75} sx={{ px: { xs: 1.5, sm: 3 }, pb: 0.5, flexWrap: 'wrap' }} useFlexGap>
        {toolCalls.map((t) => (
          <Chip
            key={t.id}
            size="small"
            color="secondary"
            variant="outlined"
            icon={t.status === 'running' ? <CircularProgress size={12} sx={{ mx: 0.5 }} /> : undefined}
            label={t.status === 'running' ? `正在使用 ${t.name}` : t.status === 'failed' ? `${t.name} 失败` : `${t.name} 完成`}
          />
        ))}
      </Stack>
    ) : null;

  const bufferBar = bufferActive ? (
    <Box
      sx={{
        mx: { xs: 1.5, sm: 3 },
        mb: 0.75,
        px: 1.5,
        py: 0.75,
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        bgcolor: (t) => alpha(t.palette.primary.main, 0.08),
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
        合并窗口 · 已合并 {bufferCount} 条{bufferRemainSec !== null ? ` · ${bufferRemainSec}s 后送达` : ''}
      </Typography>
      {bufferRemainSec !== null && (
        <LinearProgress
          variant="determinate"
          value={Math.min(100, Math.max(0, 100 - (bufferRemainSec / 20) * 100))}
          sx={{ flexGrow: 1, height: 4, borderRadius: 2 }}
        />
      )}
      <Button size="small" variant="text" disabled={flushMutation.isPending} onClick={() => flushMutation.mutate()}>
        立即送达
      </Button>
    </Box>
  ) : null;

  return (
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* 联系人侧栏 */}
      {!isMobile && (
        <Box sx={{ width: 232, flexShrink: 0, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="subtitle2" color="text.secondary">
              联系人
            </Typography>
          </Box>
          <List dense sx={{ overflowY: 'auto', flexGrow: 1, px: 1 }}>
            {contactsQuery.isPending && <ListItemButton disabled>加载中…</ListItemButton>}
            {contactList.map((c) => (
              <ListItemButton
                key={c.id}
                selected={c.id === sender}
                onClick={() => setSearchParams({ sender: c.id })}
                sx={{ mb: 0.25 }}
              >
                <ListItemAvatar sx={{ minWidth: 40 }}>
                  <Avatar src={c.avatarUrl} sx={{ width: 30, height: 30, fontSize: 13 }}>
                    {c.name.slice(0, 1)}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText primary={c.name} slotProps={{ primary: { fontSize: 14 } }} />
              </ListItemButton>
            ))}
            {contactList.length === 0 && !contactsQuery.isPending && (
              <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 2, display: 'block' }}>
                还没有联系人
              </Typography>
            )}
          </List>
        </Box>
      )}

      {/* 聊天主区 */}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {contactPicker}
        {messageList}
        {toolChips}
        {bufferBar}
        <Composer disabled={!sender} sending={sending} onSend={(t) => void handleSend(t)} />
        {isMobile && (
          <Button size="small" sx={{ mx: 1.5, mb: 1 }} onClick={() => setContactsDrawer(true)}>
            选择联系人
          </Button>
        )}
      </Box>

      {/* 移动端联系人抽屉 */}
      <Drawer anchor="bottom" open={contactsDrawer} onClose={() => setContactsDrawer(false)}>
        <Box sx={{ p: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            选择联系人
          </Typography>
          <List dense>
            {contactList.map((c) => (
              <ListItemButton
                key={c.id}
                selected={c.id === sender}
                onClick={() => {
                  setSearchParams({ sender: c.id });
                  setContactsDrawer(false);
                }}
              >
                <ListItemAvatar sx={{ minWidth: 40 }}>
                  <Avatar src={c.avatarUrl} sx={{ width: 30, height: 30, fontSize: 13 }}>
                    {c.name.slice(0, 1)}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText primary={c.name} />
              </ListItemButton>
            ))}
          </List>
        </Box>
      </Drawer>

      {/* 右键菜单 */}
      <Menu
        open={!!ctxMenu}
        onClose={() => setCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined}
      >
        <MenuItem
          onClick={() => {
            if (ctxMenu) void handleCopy(ctxMenu.message);
            setCtxMenu(null);
          }}
        >
          <ListItemIconMini>
            <ContentCopyIcon fontSize="small" />
          </ListItemIconMini>
          复制
        </MenuItem>
        {ctxMenu && (ctxMenu.message.role ?? 'user') === 'user' && (
          <MenuItem
            onClick={() => {
              if (ctxMenu) {
                const text = ctxMenu.message.pieces
                  .map((p) => p.text ?? '')
                  .filter(Boolean)
                  .join('\n');
                setEditDialog({ message: ctxMenu.message, text });
              }
              setCtxMenu(null);
            }}
          >
            <ListItemIconMini>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIconMini>
            编辑并重发
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            regenerateMutation.mutate();
            setCtxMenu(null);
          }}
        >
          <ListItemIconMini>
            <RefreshIcon fontSize="small" />
          </ListItemIconMini>
          重新生成
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (ctxMenu) setDeleteTarget(ctxMenu.message);
            setCtxMenu(null);
          }}
        >
          <ListItemIconMini>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIconMini>
          删除
        </MenuItem>
      </Menu>

      {/* 编辑消息 */}
      <Dialog open={!!editDialog} onClose={() => setEditDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>编辑并重发</DialogTitle>
        <DialogContent>
          <TextField
            multiline
            minRows={3}
            fullWidth
            value={editDialog?.text ?? ''}
            onChange={(e) => setEditDialog((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={editMutation.isPending || !editDialog?.text.trim()}
            onClick={() => {
              if (editDialog) editMutation.mutate({ messageId: editDialog.message.id, text: editDialog.text.trim() });
            }}
          >
            {editMutation.isPending ? '发送中…' : '发送'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除这条消息？"
        content="删除后不可恢复。"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />

      {/* 图片查看 */}
      <Dialog open={!!lightbox} onClose={() => setLightbox(null)} maxWidth="lg">
        <IconButton
          onClick={() => setLightbox(null)}
          sx={{ position: 'absolute', top: 8, right: 8, bgcolor: 'background.paper' }}
        >
          <CloseIcon />
        </IconButton>
        {lightbox && (
          <Box component="img" src={lightbox} alt="图片" sx={{ maxWidth: '86vw', maxHeight: '82vh', display: 'block' }} />
        )}
      </Dialog>
    </Box>
  );
}

/** 小图标容器，避免每处重复写 sx */
function ListItemIconMini({ children }: { children: ReactNode }) {
  return <Box sx={{ display: 'inline-flex', mr: 1.25, alignItems: 'center' }}>{children}</Box>;
}
