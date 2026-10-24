import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import AddIcon from '@mui/icons-material/Add';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import { scheduled } from '../../api/endpoints';
import type { ScheduledMessage } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonTable } from '../../components/Loading';

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  pending: 'warning',
  scheduled: 'warning',
  sent: 'success',
  fired: 'success',
  done: 'success',
  cancelled: 'default',
  failed: 'error',
};

export default function ScheduledPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const listQuery = useQuery({
    queryKey: ['scheduled', botId],
    queryFn: () => scheduled.list(botId ?? ''),
    enabled: !!botId,
  });
  const list = (listQuery.data ?? []).slice().sort((a, b) => (a.fireAt ?? '').localeCompare(b.fireAt ?? ''));

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ fireAt: dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm'), prompt: '', strictness: 'flexible' });
  const [cancelTarget, setCancelTarget] = useState<ScheduledMessage | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['scheduled', botId] });

  const createMutation = useMutation({
    mutationFn: () =>
      scheduled.create({
        botId,
        fireAt: form.fireAt ? dayjs(form.fireAt).toISOString() : undefined,
        prompt: form.prompt,
        strictness: form.strictness,
        origin: 'console',
      }),
    onSuccess: () => {
      setCreateOpen(false);
      invalidate();
      showSnack('已创建定时消息', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => scheduled.remove(id),
    onSuccess: () => {
      setCancelTarget(null);
      invalidate();
      showSnack('已取消', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  return (
    <Box>
      <PageHeader
        title="定时消息"
        subtitle="她会记得在合适的时间开口"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} disabled={!botId} onClick={() => setCreateOpen(true)}>
            新建定时消息
          </Button>
        }
      />

      {listQuery.isPending ? (
        <SkeletonTable />
      ) : list.length === 0 ? (
        <EmptyState icon={<ScheduleIcon />} text="没有定时消息" hint="安排一件她想做的事" />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>触发时间</TableCell>
                <TableCell>内容</TableCell>
                <TableCell>来源</TableCell>
                <TableCell>严格度</TableCell>
                <TableCell>状态</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((s) => (
                <TableRow key={s.id} hover>
                  <TableCell>
                    <Typography variant="body2">
                      {s.fireAt && dayjs(s.fireAt).isValid() ? dayjs(s.fireAt).format('M月D日 HH:mm') : s.fireAt ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>
                    <Typography variant="body2" noWrap title={s.prompt ?? ''}>
                      {s.prompt ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={s.origin ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{s.strictness ?? '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={STATUS_COLOR[s.status ?? ''] ?? 'default'} label={s.status ?? '未知'} />
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="取消">
                      <Button size="small" color="error" onClick={() => setCancelTarget(s)}>
                        取消
                      </Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>新建定时消息</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="触发时间"
                type="datetime-local"
                value={form.fireAt}
                onChange={(e) => setForm((p) => ({ ...p, fireAt: e.target.value }))}
                fullWidth
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField select label="严格度" value={form.strictness} onChange={(e) => setForm((p) => ({ ...p, strictness: e.target.value }))} fullWidth>
                <MenuItem value="strict">严格（准点触发）</MenuItem>
                <MenuItem value="flexible">弹性（她可微调）</MenuItem>
              </TextField>
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                label="内容 / 提示"
                placeholder="她想说什么、想做什么…"
                value={form.prompt}
                onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
                multiline
                minRows={3}
                fullWidth
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="contained" disabled={!form.prompt.trim() || !form.fireAt || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? '创建中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!cancelTarget}
        title="取消这条定时消息？"
        content={cancelTarget?.prompt}
        danger
        loading={cancelMutation.isPending}
        onConfirm={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
        onClose={() => setCancelTarget(null)}
      />

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 3, color: 'text.disabled' }}>
        <ScheduleSendIcon sx={{ fontSize: 16 }} />
        <Typography variant="caption">定时消息按她的时区与静默时段约束触发。</Typography>
      </Stack>
    </Box>
  );
}
