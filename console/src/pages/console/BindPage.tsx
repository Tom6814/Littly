import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkIcon from '@mui/icons-material/Link';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import { bind } from '../../api/endpoints';
import { errMsg, useUiStore } from '../../stores/uiStore';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';

/** 可绑定的渠道：键 = 后端 CHANNEL_KINDS 的键。 */
const CHANNELS: Array<{ key: string; title: string; help: string }> = [
  { key: 'qqp', title: 'QQ 个人号（SnowLuma）', help: '生成 6 位码后，在 QQ 里私聊她发「绑定 XXXXXX」' },
  { key: 'tg', title: 'Telegram', help: '生成深链，把链接发到 Telegram（或让对方点）' },
  { key: 'wechat', title: '微信', help: '生成 6 位码后，在微信里私聊她发「绑定 XXXXXX」' },
  { key: 'qq', title: 'QQ 官方', help: '生成 6 位码后，在 QQ 官方机器人里发「绑定 XXXXXX」' },
  { key: 'discord', title: 'Discord', help: '生成 6 位码后，在 Discord 里私聊她发「绑定 XXXXXX」' },
];

export default function BindPage() {
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);
  const [codes, setCodes] = useState<Record<string, { code: string; instruction: string; expiresAt: string }>>({});

  const statusQuery = useQuery({
    queryKey: ['bind-status'],
    queryFn: () => bind.status(),
    refetchInterval: 5000,
  });

  const codeMutation = useMutation({
    mutationFn: (channel: string) => bind.createCode(channel),
    onSuccess: (res, channel) => {
      if (!res?.code) return;
      setCodes((prev) => ({ ...prev, [channel]: { code: res.code!, instruction: res.instruction ?? '', expiresAt: res.expiresAt ?? '' } }));
      showSnack('绑定码已生成', 'success');
      void queryClient.invalidateQueries({ queryKey: ['bind-status'] });
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const unbindMutation = useMutation({
    mutationFn: (input: { channel: string; externalId: string }) => bind.unbind(input.channel, input.externalId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bind-status'] });
      showSnack('已解绑（历史与记忆保留）', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const identities = statusQuery.data?.identities ?? [];

  return (
    <Box>
      <PageHeader
        title="账号绑定"
        subtitle="绑定一次，网页端与各渠道就是同一个她（跨渠道同一条会话线）"
      />

      <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          已绑定的渠道（{identities.length}）
        </Typography>
        {statusQuery.isPending ? (
          <Typography variant="body2" color="text.secondary">
            读取中…
          </Typography>
        ) : identities.length === 0 ? (
          <EmptyState text="还没有绑定任何渠道" hint="在下面生成绑定码，在对应渠道里发给她" />
        ) : (
          <Stack spacing={1}>
            {identities.map((id) => (
              <Stack key={`${id.channel}/${id.externalId}`} direction="row" spacing={1} alignItems="center">
                <Chip size="small" variant="outlined" label={id.channel} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {id.externalId}
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                <Button size="small" color="error" onClick={() => unbindMutation.mutate({ channel: id.channel, externalId: id.externalId })}>
                  解绑
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      <Divider sx={{ my: 2.5 }} />

      <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
        生成绑定码
      </Typography>
      <Stack spacing={1.5}>
        {CHANNELS.map((c) => {
          const issued = codes[c.key];
          return (
            <Paper key={c.key} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Typography variant="subtitle2">{c.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {c.help}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<QrCode2Icon />}
                  disabled={codeMutation.isPending}
                  onClick={() => codeMutation.mutate(c.key)}
                >
                  生成码
                </Button>
              </Stack>
              {issued && (
                <Stack spacing={0.5} sx={{ mt: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6" sx={{ fontFamily: 'monospace', letterSpacing: 2 }}>
                      {issued.code}
                    </Typography>
                    <Tooltip title="复制">
                      <IconButton
                        size="small"
                        onClick={() => {
                          void navigator.clipboard?.writeText(issued.code);
                          showSnack('已复制', 'success');
                        }}
                      >
                        <ContentCopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {issued.instruction}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    有效期至 {new Date(issued.expiresAt).toLocaleString('zh-CN')}（10 分钟）
                  </Typography>
                </Stack>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Alert severity="info" icon={<LinkIcon />} sx={{ mt: 2.5 }}>
        绑定码是一次性的，10 分钟内有效；同一人同一渠道只保留最新一个码。解绑不删除历史与记忆。
      </Alert>
    </Box>
  );
}
