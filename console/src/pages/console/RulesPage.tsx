import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import GavelIcon from '@mui/icons-material/Gavel';
import { rules } from '../../api/endpoints';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';

export default function RulesPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const rulesQuery = useQuery({
    queryKey: ['persona-rules', botId],
    queryFn: () => rules.get(botId ?? ''),
    enabled: !!botId,
  });

  const [content, setContent] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (rulesQuery.data && !loaded) {
      setContent(rulesQuery.data.content ?? '');
      setEnabled(rulesQuery.data.enabled ?? true);
      setLoaded(true);
    }
  }, [rulesQuery.data, loaded]);

  const dirty = loaded && (content !== (rulesQuery.data?.content ?? '') || enabled !== (rulesQuery.data?.enabled ?? true));

  const saveMutation = useMutation({
    mutationFn: () => rules.put(botId ?? '', { content, enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['persona-rules', botId] });
      showSnack('铁律已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  if (rulesQuery.isPending) {
    return (
      <Box>
        <PageHeader title="铁律" subtitle="确定性分层——只回答她是谁" />
        <Skeleton variant="rounded" height={320} />
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="铁律"
        subtitle="唯一的硬约束层：安全阀也写在这里"
        actions={
          <Button
            variant="contained"
            startIcon={<GavelIcon />}
            disabled={!dirty || saveMutation.isPending || !botId}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? '保存中…' : dirty ? '保存修改' : '无修改'}
          </Button>
        }
      />

      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          铁律用「她是谁」的句式书写，而不是「你要怎样」。系统提示词的每一层每轮完整注入，铁律永不裁剪。
        </Alert>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />}
            label={enabled ? '已启用' : '已停用（不推荐）'}
            sx={{ mb: 1.5 }}
          />
          <TextField
            label="铁律内容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            multiline
            minRows={14}
            fullWidth
            slotProps={{ input: { sx: { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13.5, lineHeight: 1.7 } } }}
            placeholder={'她有自己的生活节奏。\n她可以拒绝。\n当对方流露求死或自伤念头时，她必须开口——这是唯一例外。'}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button size="small" disabled={!dirty} onClick={() => { setContent(rulesQuery.data?.content ?? ''); setEnabled(rulesQuery.data?.enabled ?? true); }}>
              撤销修改
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              {content.length} 字
            </Typography>
          </Stack>
        </Paper>
      </Stack>
    </Box>
  );
}
