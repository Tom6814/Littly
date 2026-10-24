import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DescriptionIcon from '@mui/icons-material/Description';
import HistoryIcon from '@mui/icons-material/History';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import UndoIcon from '@mui/icons-material/Undo';
import { growth } from '../../api/endpoints';
import type { GrowthProposal } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonList } from '../../components/Loading';

export default function GrowthPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const growthQuery = useQuery({
    queryKey: ['growth', botId],
    queryFn: () => growth.get(botId ?? ''),
    enabled: !!botId,
  });
  const data = growthQuery.data;
  const dimensions = data?.profile?.dimensions ?? [];
  const proposals = (data?.proposals ?? []).filter((p) => !p.status || p.status === 'pending' || p.status === 'proposed');
  const versions = data?.versions ?? [];
  const window = data?.window;

  const [reportOpen, setReportOpen] = useState(false);
  const [editProposal, setEditProposal] = useState<GrowthProposal | null>(null);
  const [editText, setEditText] = useState('');
  const [rollbackVersion, setRollbackVersion] = useState<number | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['growth', botId] });

  const evaluateMutation = useMutation({
    mutationFn: () => growth.evaluate(botId ?? ''),
    onSuccess: () => {
      invalidate();
      showSnack('已触发一次成长评估', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const decideMutation = useMutation({
    mutationFn: (input: { id: string; decision: string; extra?: Record<string, unknown> }) =>
      growth.decide(input.id, input.decision, input.extra),
    onSuccess: () => {
      setEditProposal(null);
      invalidate();
      showSnack('已处理该提议', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const rollbackMutation = useMutation({
    mutationFn: () => growth.rollback(botId ?? '', rollbackVersion ?? undefined),
    onSuccess: () => {
      setRollbackVersion(null);
      invalidate();
      showSnack('已回滚成长档案', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  if (growthQuery.isPending) {
    return (
      <Box>
        <PageHeader title="成长" subtitle="她的变化，每一步都要有证据" />
        <SkeletonList rows={4} />
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="成长"
        subtitle="成长档案需审批（提议-审批制，永不静默生效）"
        actions={
          <>
            <Button variant="outlined" startIcon={<PlayArrowIcon />} disabled={!botId || evaluateMutation.isPending} onClick={() => evaluateMutation.mutate()}>
              触发评估
            </Button>
            <Button variant="outlined" startIcon={<DescriptionIcon />} onClick={() => setReportOpen(true)} disabled={!data?.profile?.report}>
              成长报告
            </Button>
          </>
        }
      />

      <Grid container spacing={2}>
        {/* 成长维度 */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <AutoAwesomeIcon fontSize="small" sx={{ color: 'primary.main' }} />
              <Typography variant="subtitle2">成长维度</Typography>
              {data?.profile?.version !== undefined && (
                <Chip size="small" label={`v${data.profile.version}`} variant="outlined" />
              )}
            </Stack>
            {dimensions.length === 0 ? (
              <EmptyState text="还没有成长档案" hint="触发一次评估后，她会慢慢长出自己的样子" />
            ) : (
              <Stack spacing={2}>
                {dimensions.map((d) => (
                  <Box key={d.name}>
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {d.name}
                      </Typography>
                      <Chip size="small" color="primary" label={`等级 ${d.level}`} sx={{ height: 20, fontSize: 12 }} />
                      {d.max !== undefined && (
                        <Typography variant="caption" color="text.disabled">
                          / {d.max}
                        </Typography>
                      )}
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={d.max && d.max > 0 ? Math.min(100, (d.level / d.max) * 100) : Math.min(100, d.level * 10)}
                      sx={{ height: 8, borderRadius: 4 }}
                    />
                    {d.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                        {d.description}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>

        {/* 待审批提议 */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Typography variant="subtitle2" sx={{ mb: 2 }}>
              待审批提议（{proposals.length}）
            </Typography>
            {proposals.length === 0 ? (
              <EmptyState text="没有待审批的成长提议" hint="有证据链的提议才会出现在这里" />
            ) : (
              <Stack spacing={2}>
                {proposals.map((p) => (
                  <Paper key={p.id} variant="outlined" sx={{ p: 1.75 }}>
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                      <Chip size="small" color="secondary" label={p.kind ?? '成长提议'} />
                      {p.createdAt && (
                        <Typography variant="caption" color="text.secondary">
                          {dayjs(p.createdAt).format('MM-DD HH:mm')}
                        </Typography>
                      )}
                    </Stack>
                    {p.title && (
                      <Typography variant="body2" fontWeight={600}>
                        {p.title}
                      </Typography>
                    )}
                    {p.summary && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {p.summary}
                      </Typography>
                    )}
                    {(p.evidence ?? []).length > 0 && (
                      <Box component="ul" sx={{ m: 0.75, pl: 2, color: 'text.secondary' }}>
                        {(p.evidence ?? []).map((ev, i) => (
                          <Box component="li" key={i} sx={{ fontSize: 12 }}>
                            {ev}
                          </Box>
                        ))}
                      </Box>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
                      <Button size="small" variant="contained" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ id: p.id, decision: 'approve' })}>
                        批准
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={decideMutation.isPending}
                        onClick={() => {
                          setEditProposal(p);
                          setEditText(p.summary ?? '');
                        }}
                      >
                        改后批准
                      </Button>
                      <Button size="small" color="error" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ id: p.id, decision: 'reject' })}>
                        驳回
                      </Button>
                      <Button size="small" color="inherit" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate({ id: p.id, decision: 'cancel' })}>
                        取消
                      </Button>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>

        {/* 复审窗口 */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
              复审窗口
            </Typography>
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  上次复审
                </Typography>
                <Typography variant="body2">
                  {window?.lastAt && dayjs(window.lastAt).isValid() ? dayjs(window.lastAt).format('YYYY-MM-DD HH:mm') : '—'}
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  下次复审
                </Typography>
                <Typography variant="body2">
                  {window?.nextAt && dayjs(window.nextAt).isValid() ? dayjs(window.nextAt).format('YYYY-MM-DD HH:mm') : '—'}
                </Typography>
              </Stack>
              {window?.reason && (
                <Typography variant="caption" color="text.secondary">
                  {window.reason}
                </Typography>
              )}
            </Stack>
          </Paper>
        </Grid>

        {/* 版本历史 */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <HistoryIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography variant="subtitle2">版本历史</Typography>
            </Stack>
            {versions.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                还没有版本记录
              </Typography>
            ) : (
              <List dense disablePadding>
                {versions.map((v, i) => (
                  <ListItem
                    key={i}
                    disableGutters
                    secondaryAction={
                      <Button
                        size="small"
                        startIcon={<UndoIcon fontSize="small" />}
                        disabled={rollbackMutation.isPending}
                        onClick={() => setRollbackVersion(v.version ?? null)}
                      >
                        回滚
                      </Button>
                    }
                  >
                    <ListItemText
                      primary={`v${v.version ?? '?'}${v.createdAt && dayjs(v.createdAt).isValid() ? ` · ${dayjs(v.createdAt).format('YYYY-MM-DD HH:mm')}` : ''}`}
                      secondary={v.summary}
                      slotProps={{ secondary: { noWrap: true } }}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* 成长报告 */}
      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>成长报告</DialogTitle>
        <DialogContent dividers>
          <Typography sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{data?.profile?.report ?? '暂无报告'}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReportOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* 改后批准 */}
      <Dialog open={!!editProposal} onClose={() => setEditProposal(null)} maxWidth="sm" fullWidth>
        <DialogTitle>改后批准</DialogTitle>
        <DialogContent>
          <TextField
            label="修改后的提议内容"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            multiline
            minRows={5}
            fullWidth
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditProposal(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={!editText.trim() || decideMutation.isPending}
            onClick={() => editProposal && decideMutation.mutate({ id: editProposal.id, decision: 'approve_edited', extra: { text: editText.trim() } })}
          >
            批准
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={rollbackVersion !== null}
        title={rollbackVersion !== null ? `回滚到 v${rollbackVersion}？` : '回滚成长档案？'}
        content="回滚后当前档案将被撤销（保留历史可再次前滚）。"
        danger
        loading={rollbackMutation.isPending}
        onConfirm={() => rollbackMutation.mutate()}
        onClose={() => setRollbackVersion(null)}
      />

      <Divider sx={{ mt: 4 }} />
      <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: 'block' }}>
        成长三铁律：证据链 ≥2 · 单维 ≤±1 级 · 总位移 ≤6 级 · 价值禁区不可逾越
      </Typography>
    </Box>
  );
}
