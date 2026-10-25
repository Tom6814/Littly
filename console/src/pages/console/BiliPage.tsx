import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import OndemandVideoIcon from '@mui/icons-material/OndemandVideo';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import TerminalIcon from '@mui/icons-material/Terminal';
import { bili } from '../../api/endpoints';
import type { BiliQrState } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import PageHeader from '../../components/PageHeader';

/** sidecar 给的是裸 base64（PNG）；浏览器要 data URL 才能渲染。 */
function qrDataUrl(value: string): string {
  if (value.startsWith('data:')) return value;
  return `data:image/png;base64,${value}`;
}

export default function BiliPage() {
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const statusQuery = useQuery({ queryKey: ['bili-status'], queryFn: bili.status, staleTime: 15_000 });
  const status = statusQuery.data;

  const [qr, setQr] = useState<BiliQrState | null>(null);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<number | null>(null);
  const sessionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const startQrMutation = useMutation({
    mutationFn: () => bili.qrStart(),
    onSuccess: (state) => {
      setQr(state);
      sessionRef.current = state.sessionId;
      setPolling(true);
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await bili.qrStatus(sessionRef.current);
          setQr((prev) => ({ ...(prev ?? {}), ...s }));
          const st = s.status ?? '';
          if (st === 'confirmed' || st.includes('confirm') || st.includes('success')) {
            stopPolling();
            showSnack('B 站登录成功', 'success');
            void queryClient.invalidateQueries({ queryKey: ['bili-status'] });
          } else if (st === 'expired') {
            stopPolling();
            showSnack('二维码已过期，请重新生成', 'warning');
          }
        } catch {
          /* 忽略单次轮询错误 */
        }
      }, 2000);
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const stopPolling = () => {
    setPolling(false);
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // 命令执行
  const [argvText, setArgvText] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const cmdMutation = useMutation({
    mutationFn: () => {
      const argv = argvText.trim().split(/\s+/).filter(Boolean);
      if (argv.length === 0) throw new Error('请输入命令');
      return bili.cmd(argv);
    },
    onSuccess: (res) => {
      setOutput(res.output ?? '（无输出）');
    },
    onError: (e) => {
      setOutput(null);
      showSnack(errMsg(e), 'error');
    },
  });

  const qrStatus = qr?.status ?? '';
  const confirmed = qrStatus.includes('confirm') || qrStatus.includes('success');

  return (
    <Box>
      <PageHeader title="Bilibili" subtitle="她看世界的另一个窗口" />

      <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <OndemandVideoIcon sx={{ color: 'primary.main' }} />
          <Typography variant="subtitle2">账号状态</Typography>
          {statusQuery.isPending ? (
            <CircularProgress size={16} />
          ) : status?.connected === false ? (
            <Chip size="small" color="error" variant="outlined" label="sidecar 未连接" />
          ) : status?.logined ? (
            <Chip size="small" color="success" label={`已登录 · ${status.username ?? '未知用户'}`} />
          ) : (
            <Chip size="small" color="default" label="未登录" />
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button variant="outlined" startIcon={<QrCode2Icon />} onClick={() => startQrMutation.mutate()} disabled={startQrMutation.isPending || polling}>
            {qr && !confirmed ? '重新生成二维码' : '扫码登录'}
          </Button>
        </Stack>

        {status?.connected === false && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="body2">{status.error ?? 'bilibili sidecar 没连上'}</Typography>
            {status.hint && (
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5, opacity: 0.85 }}>
                {status.hint}
              </Typography>
            )}
          </Alert>
        )}

        {qr && (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 2 }}>
            {qr.qrImage ? (
              <Box
                component="img"
                src={qrDataUrl(qr.qrImage)}
                alt="B 站登录二维码"
                sx={{ width: 220, height: 220, borderRadius: 2, bgcolor: '#fff', p: 1 }}
              />
            ) : qr.qrUrl ? (
              <Alert severity="info">
                请在 B 站 App 中打开此链接完成扫码：
                <Box component="code" sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}>
                  {qr.qrUrl}
                </Box>
              </Alert>
            ) : (
              <Alert severity="warning">后端未返回二维码图片</Alert>
            )}
            <Chip
              size="small"
              color={confirmed ? 'success' : qrStatus === 'expired' ? 'default' : 'warning'}
              label={
                confirmed
                  ? '已确认登录'
                  : qrStatus === 'expired'
                    ? '已过期'
                    : qrStatus.includes('scan')
                      ? '已扫码，等待确认…'
                      : polling
                        ? '等待扫码…'
                        : '已生成'
              }
            />
          </Stack>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <TerminalIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2">允许清单命令</Typography>
        </Stack>
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          仅允许执行服务端白名单内的命令，参数用空格分隔。
        </Alert>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            placeholder="如：bili status"
            value={argvText}
            onChange={(e) => setArgvText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) cmdMutation.mutate();
            }}
            fullWidth
            slotProps={{ input: { sx: { fontFamily: 'ui-monospace, monospace', fontSize: 13.5 } } }}
          />
          <Button variant="contained" disabled={!argvText.trim() || cmdMutation.isPending} onClick={() => cmdMutation.mutate()}>
            {cmdMutation.isPending ? '执行中…' : '执行'}
          </Button>
        </Stack>
        {output !== null && (
          <Box component="pre" sx={{ mt: 2, p: 1.5, borderRadius: 2, bgcolor: 'action.hover', fontSize: 12.5, overflow: 'auto', m: 0, maxHeight: 360 }}>
            {output}
          </Box>
        )}
      </Paper>
    </Box>
  );
}
