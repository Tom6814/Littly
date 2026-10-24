import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import PsychologyIcon from '@mui/icons-material/Psychology';
import RestoreIcon from '@mui/icons-material/RestoreFromTrash';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import dayjs from 'dayjs';
import { contacts as contactsApi, memories as memoriesApi } from '../../api/endpoints';
import type { Memory } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonTable } from '../../components/Loading';

interface MemoryForm {
  id: string | null;
  sender: string;
  category: string;
  importance: number;
  eventTime: string;
  content: string;
  tagsText: string;
}

const emptyForm = (sender: string): MemoryForm => ({
  id: null,
  sender,
  category: '',
  importance: 3,
  eventTime: dayjs().format('YYYY-MM-DDTHH:mm'),
  content: '',
  tagsText: '',
});

function formFrom(m: Memory): MemoryForm {
  return {
    id: m.id,
    sender: m.sender ?? '',
    category: m.category ?? '',
    importance: m.importance ?? 3,
    eventTime: m.eventTime && dayjs(m.eventTime).isValid() ? dayjs(m.eventTime).format('YYYY-MM-DDTHH:mm') : dayjs().format('YYYY-MM-DDTHH:mm'),
    content: m.content ?? '',
    tagsText: (m.tags ?? []).join('、'),
  };
}

export default function MemoriesPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const contactsQuery = useQuery({
    queryKey: ['contacts', botId],
    queryFn: () => contactsApi.list(botId ?? ''),
    enabled: !!botId,
  });
  const contactOptions = contactsQuery.data ?? [];

  const [senderFilter, setSenderFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [provenanceFilter, setProvenanceFilter] = useState('');
  const [onlyFaded, setOnlyFaded] = useState(false);

  const memoriesQuery = useQuery({
    queryKey: ['memories', botId, senderFilter, onlyFaded ? 'with-deleted' : 'active'],
    queryFn: () => memoriesApi.list({ botId: botId ?? '', sender: senderFilter || undefined, includeDeleted: onlyFaded }),
    enabled: !!botId,
  });
  const allMemories = memoriesQuery.data ?? [];

  const provenanceOptions = useMemo(
    () => [...new Set(allMemories.map((m) => m.provenance).filter((p): p is string => !!p))],
    [allMemories],
  );

  const filtered = useMemo(() => {
    return allMemories.filter((m) => {
      if (onlyFaded && !m.deletedAt) return false;
      if (categoryFilter && (m.category ?? '') !== categoryFilter) return false;
      if (provenanceFilter && (m.provenance ?? '') !== provenanceFilter) return false;
      return true;
    });
  }, [allMemories, onlyFaded, categoryFilter, provenanceFilter]);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<MemoryForm | null>(null);
  const [fadeTarget, setFadeTarget] = useState<Memory | null>(null);
  const [consolidatePreview, setConsolidatePreview] = useState<unknown>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['memories', botId] });
  };

  const saveMutation = useMutation({
    mutationFn: (f: MemoryForm) => {
      const body: Record<string, unknown> = {
        botId,
        sender: f.sender,
        category: f.category,
        importance: f.importance,
        eventTime: f.eventTime ? dayjs(f.eventTime).toISOString() : undefined,
        content: f.content,
        tags: f.tagsText
          .split(/[，,、\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      };
      return f.id ? memoriesApi.update(f.id, body) : memoriesApi.create(body);
    },
    onSuccess: () => {
      setForm(null);
      invalidate();
      showSnack('已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const fadeMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.remove(id),
    onSuccess: () => {
      setFadeTarget(null);
      invalidate();
      showSnack('已淡忘（软删除，可恢复）', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.restore(id),
    onSuccess: () => {
      invalidate();
      showSnack('已恢复', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const consolidateDryMutation = useMutation({
    mutationFn: (sender: string) => memoriesApi.consolidate(botId ?? '', sender, true),
    onSuccess: (data) => {
      setConsolidatePreview(data);
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const consolidateApplyMutation = useMutation({
    mutationFn: (sender: string) => memoriesApi.consolidate(botId ?? '', sender, false),
    onSuccess: () => {
      setConsolidatePreview(null);
      invalidate();
      showSnack('整理完成', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const consolidateSender = senderFilter || contactOptions[0]?.id || '';

  return (
    <Box>
      <PageHeader
        title="记忆检查器"
        subtitle="记忆保真优先于风格——永不物理删除，只淡忘"
        actions={
          <>
            <Button
              variant="outlined"
              startIcon={<AutoFixHighIcon />}
              disabled={!consolidateSender || consolidateDryMutation.isPending}
              onClick={() => consolidateDryMutation.mutate(consolidateSender)}
            >
              触发整理（预览）
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} disabled={!botId} onClick={() => setForm(emptyForm(consolidateSender))}>
              新建记忆
            </Button>
          </>
        }
      />

      {/* 过滤器 */}
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField select label="联系人" value={senderFilter} onChange={(e) => setSenderFilter(e.target.value)} fullWidth>
            <MenuItem value="">全部</MenuItem>
            {contactOptions.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField label="类别" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} fullWidth placeholder="如：事件" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField select label="来源" value={provenanceFilter} onChange={(e) => setProvenanceFilter(e.target.value)} fullWidth>
            <MenuItem value="">全部</MenuItem>
            {provenanceOptions.map((p) => (
              <MenuItem key={p} value={p}>
                {p}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <FormControlLabel
            control={<Switch checked={onlyFaded} onChange={(e) => setOnlyFaded(e.target.checked)} />}
            label="只看淡忘"
            sx={{ mt: 0.75 }}
          />
        </Grid>
      </Grid>

      {memoriesQuery.isPending ? (
        <SkeletonTable />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<PsychologyIcon />} text={onlyFaded ? '淡忘池是空的' : '还没有记忆'} hint="记忆会随对话自动沉淀，也可以手动新建" />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={44} />
                <TableCell>类别</TableCell>
                <TableCell align="right">重要度</TableCell>
                <TableCell>事件时间</TableCell>
                <TableCell>来源</TableCell>
                <TableCell>状态</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((m) => (
                <Fragment key={m.id}>
                  <TableRow hover onClick={() => setExpanded((cur) => (cur === m.id ? null : m.id))} sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <IconButton size="small">
                        {expanded === m.id ? <ExpandMoreIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>{m.category ?? '—'}</TableCell>
                    <TableCell align="right">{m.importance ?? '—'}</TableCell>
                    <TableCell>
                      <Typography variant="caption">{m.eventTime ?? m.createdAt ?? '—'}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={m.provenance ?? '未知'} />
                    </TableCell>
                    <TableCell>
                      {m.deletedAt ? (
                        <Chip size="small" color="default" icon={<VisibilityOffIcon sx={{ fontSize: 14 }} />} label="已淡忘" />
                      ) : m.supersededBy ? (
                        <Chip size="small" color="warning" variant="outlined" label="已被取代" />
                      ) : (
                        <Chip size="small" color="success" variant="outlined" label="有效" />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="编辑">
                        <Button size="small" onClick={(e) => { e.stopPropagation(); setForm(formFrom(m)); }}>
                          编辑
                        </Button>
                      </Tooltip>
                      {m.deletedAt ? (
                        <Tooltip title="恢复">
                          <IconButton size="small" color="primary" onClick={(e) => { e.stopPropagation(); restoreMutation.mutate(m.id); }}>
                            <RestoreIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <Tooltip title="淡忘">
                          <IconButton size="small" color="warning" onClick={(e) => { e.stopPropagation(); setFadeTarget(m); }}>
                            <VisibilityOffIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                  <TableRow key={`${m.id}-detail`}>
                    <TableCell colSpan={7} sx={{ py: 0, border: 0 }}>
                      <Collapse in={expanded === m.id} timeout="auto" unmountOnExit>
                        <Box sx={{ py: 1.5, px: 1 }}>
                          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                            {m.content ?? '（无内容）'}
                          </Typography>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                            {(m.tags ?? []).map((t) => (
                              <Chip key={t} label={t} size="small" variant="outlined" />
                            ))}
                          </Stack>
                          <Stack spacing={0.5}>
                            {m.supersededBy && (
                              <Typography variant="caption" color="text.secondary">
                                取代链：被 {m.supersededBy} 取代
                              </Typography>
                            )}
                            {m.supersedes && (
                              <Typography variant="caption" color="text.secondary">
                                取代了 {m.supersedes}
                              </Typography>
                            )}
                            {m.validUntil && (
                              <Typography variant="caption" color="text.secondary">
                                有效期至 {m.validUntil}
                              </Typography>
                            )}
                          </Stack>
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* 检索账本占位 */}
      <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          检索账本（retrieval ledger）
        </Typography>
        <Typography variant="body2" color="text.secondary">
          记忆的每次检索与命中将在这里留痕，用于事实审计。该能力由后端逐步提供。
        </Typography>
      </Paper>

      {/* 新建/编辑 */}
      <Dialog open={!!form} onClose={() => setForm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{form?.id ? '编辑记忆' : '新建记忆'}</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField select label="联系人" value={form?.sender ?? ''} onChange={(e) => setForm((p) => (p ? { ...p, sender: e.target.value } : p))} fullWidth>
                {contactOptions.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="类别"
                value={form?.category ?? ''}
                onChange={(e) => setForm((p) => (p ? { ...p, category: e.target.value } : p))}
                placeholder="如：事件 / 偏好 / 事实"
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="重要度（1-5）"
                type="number"
                slotProps={{ htmlInput: { min: 1, max: 5 } }}
                value={form?.importance ?? 3}
                onChange={(e) => setForm((p) => (p ? { ...p, importance: Math.min(5, Math.max(1, Number(e.target.value) || 1)) } : p))}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="事件时间"
                type="datetime-local"
                value={form?.eventTime ?? ''}
                onChange={(e) => setForm((p) => (p ? { ...p, eventTime: e.target.value } : p))}
                fullWidth
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                label="内容"
                value={form?.content ?? ''}
                onChange={(e) => setForm((p) => (p ? { ...p, content: e.target.value } : p))}
                multiline
                minRows={3}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                label="标签"
                value={form?.tagsText ?? ''}
                onChange={(e) => setForm((p) => (p ? { ...p, tagsText: e.target.value } : p))}
                helperText="顿号/逗号分隔"
                fullWidth
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={!form?.content.trim() || saveMutation.isPending}
            onClick={() => form && saveMutation.mutate(form)}
          >
            {saveMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 整理预览 */}
      <Dialog open={consolidatePreview !== null} onClose={() => setConsolidatePreview(null)} maxWidth="md" fullWidth>
        <DialogTitle>整理预览（dry-run）</DialogTitle>
        <DialogContent dividers>
          {consolidatePreview === null ? null : (
            <>
              {typeof consolidatePreview === 'object' && consolidatePreview !== null ? (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  以下为建议的合并结果，确认后正式执行。原始数据不会被物理删除。
                </Alert>
              ) : null}
              <Box component="pre" sx={{ fontSize: 12.5, overflow: 'auto', m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(consolidatePreview, null, 2)}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConsolidatePreview(null)}>放弃</Button>
          <Button
            variant="contained"
            disabled={consolidateApplyMutation.isPending || !consolidateSender}
            onClick={() => consolidateApplyMutation.mutate(consolidateSender)}
          >
            {consolidateApplyMutation.isPending ? '整理中…' : '正式执行'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!fadeTarget}
        title="淡忘这条记忆？"
        content="记忆永不物理删除——淡忘只是移入可恢复的池子。"
        confirmText="淡忘"
        danger
        loading={fadeMutation.isPending}
        onConfirm={() => fadeTarget && fadeMutation.mutate(fadeTarget.id)}
        onClose={() => setFadeTarget(null)}
      />
    </Box>
  );
}
