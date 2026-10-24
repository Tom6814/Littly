import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
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
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { worldbook } from '../../api/endpoints';
import type { WorldEntry } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonTable } from '../../components/Loading';

const LOGIC_OPTIONS = [
  { value: 'AND_ALL', label: '全部关键词（AND ALL）' },
  { value: 'AND_ANY', label: '任一关键词 + 次级（AND ANY）' },
  { value: 'OR_ANY', label: '任一关键词（OR ANY）' },
  { value: 'NOT_ANY', label: '不含这些词（NOT ANY）' },
];

interface EntryForm {
  id: string | null;
  keys: string[];
  secondKeys: string[];
  logic: string;
  probability: number;
  priority: number;
  position: string;
  constant: boolean;
  enabled: boolean;
  content: string;
  comment: string;
}

const emptyForm: EntryForm = {
  id: null,
  keys: [],
  secondKeys: [],
  logic: 'AND_ANY',
  probability: 100,
  priority: 0,
  position: 'before',
  constant: false,
  enabled: true,
  content: '',
  comment: '',
};

function formFrom(e: WorldEntry): EntryForm {
  return {
    id: e.id,
    keys: e.keys,
    secondKeys: e.secondKeys ?? [],
    logic: e.logic ?? 'AND_ANY',
    probability: e.probability ?? 100,
    priority: e.priority ?? 0,
    position: e.position ?? 'before',
    constant: e.constant ?? false,
    enabled: e.enabled ?? true,
    content: e.content ?? '',
    comment: e.comment ?? '',
  };
}

function ChipsField({ value, onChange, label, placeholder }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    for (const raw of draft.split(/[,，\s]+/)) {
      const t = raw.trim();
      if (t && !value.includes(t)) value = [...value, t];
    }
    onChange(value);
    setDraft('');
  };
  return (
    <TextField
      label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
      fullWidth
      helperText={value.length > 0 ? value.join('、') : '回车或逗号分隔'}
    />
  );
}

export default function WorldbookPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const entriesQuery = useQuery({
    queryKey: ['world-entries', botId],
    queryFn: () => worldbook.list(botId ?? ''),
    enabled: !!botId,
  });
  const entries = entriesQuery.data ?? [];

  const [form, setForm] = useState<EntryForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorldEntry | null>(null);

  const [testText, setTestText] = useState('');
  const [matchedIds, setMatchedIds] = useState<string[]>([]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['world-entries', botId] });

  const saveMutation = useMutation({
    mutationFn: (f: EntryForm) => {
      const body: Record<string, unknown> = {
        botId,
        keys: f.keys,
        secondKeys: f.secondKeys,
        logic: f.logic,
        probability: f.probability,
        priority: f.priority,
        position: f.position,
        constant: f.constant,
        enabled: f.enabled,
        content: f.content,
        comment: f.comment,
      };
      return f.id ? worldbook.update(f.id, body) : worldbook.create(body);
    },
    onSuccess: () => {
      setForm(null);
      invalidate();
      showSnack('已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => worldbook.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      showSnack('已删除', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const testMutation = useMutation({
    mutationFn: () => worldbook.test(botId ?? '', testText),
    onSuccess: (res) => {
      setMatchedIds(res.matchedIds);
      showSnack(res.matchedIds.length > 0 ? `命中 ${res.matchedIds.length} 条` : '没有命中任何词条', 'info');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const patchForm = (p: Partial<EntryForm>) => setForm((prev) => (prev ? { ...prev, ...p } : prev));

  return (
    <Box>
      <PageHeader
        title="世界书"
        subtitle="她所知道的世界，按关键词注入"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} disabled={!botId} onClick={() => setForm(emptyForm)}>
            新增词条
          </Button>
        }
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 8 }}>
          {entriesQuery.isPending ? (
            <SkeletonTable />
          ) : entries.length === 0 ? (
            <EmptyState icon={<MenuBookIcon />} text="世界书还是空的" hint="添加第一批词条，让她了解你的世界" />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>关键词</TableCell>
                    <TableCell>逻辑</TableCell>
                    <TableCell align="right">概率</TableCell>
                    <TableCell align="right">优先级</TableCell>
                    <TableCell>常驻</TableCell>
                    <TableCell align="right">操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entries.map((e) => {
                    const matched = matchedIds.includes(e.id);
                    return (
                      <TableRow
                        key={e.id}
                        hover
                        sx={matched ? { bgcolor: (t) => alpha(t.palette.primary.main, 0.14) } : undefined}
                      >
                        <TableCell>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {e.keys.map((k) => (
                              <Chip key={k} label={k} size="small" />
                            ))}
                            {(e.secondKeys ?? []).map((k) => (
                              <Chip key={k} label={k} size="small" variant="outlined" color="secondary" />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {LOGIC_OPTIONS.find((o) => o.value === (e.logic ?? ''))?.label ?? e.logic ?? '—'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">{e.probability ?? 100}%</TableCell>
                        <TableCell align="right">{e.priority ?? 0}</TableCell>
                        <TableCell>{e.constant ? '是' : '—'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="编辑">
                            <IconButton size="small" onClick={() => setForm(formFrom(e))}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="删除">
                            <IconButton size="small" color="error" onClick={() => setDeleteTarget(e)}>
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Paper variant="outlined" sx={{ p: 2, position: 'sticky', top: 76 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              命中测试
            </Typography>
            <TextField
              label="模拟一段对话文本"
              placeholder="输入一段包含关键词的文本，测试哪些词条会被注入…"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              multiline
              minRows={4}
              fullWidth
            />
            <Button
              sx={{ mt: 1.5 }}
              variant="contained"
              startIcon={<PlayArrowIcon />}
              disabled={!testText.trim() || !botId || testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? '测试中…' : '运行测试'}
            </Button>
            {matchedIds.length > 0 && (
              <Alert severity="success" sx={{ mt: 1.5 }}>
                命中 {matchedIds.length} 条词条，左侧表格已高亮。
              </Alert>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* 词条编辑器 */}
      <Dialog open={!!form} onClose={() => setForm(null)} maxWidth="md" fullWidth>
        <DialogTitle>{form?.id ? '编辑词条' : '新增词条'}</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2} sx={{ pt: 0.5 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <ChipsField
                label="关键词（keys）"
                value={form?.keys ?? []}
                onChange={(keys) => patchForm({ keys })}
                placeholder="主关键词"
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <ChipsField
                label="次级关键词（secondKeys）"
                value={form?.secondKeys ?? []}
                onChange={(secondKeys) => patchForm({ secondKeys })}
                placeholder="附加条件"
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                select
                label="命中逻辑"
                value={form?.logic ?? 'AND_ANY'}
                onChange={(e) => patchForm({ logic: e.target.value })}
                fullWidth
              >
                {LOGIC_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                select
                label="注入位置"
                value={form?.position ?? 'before'}
                onChange={(e) => patchForm({ position: e.target.value })}
                fullWidth
              >
                <MenuItem value="before">角色卡之前</MenuItem>
                <MenuItem value="after">角色卡之后</MenuItem>
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <Typography variant="caption" color="text.secondary">
                触发概率：{form?.probability ?? 100}%
              </Typography>
              <Slider
                value={form?.probability ?? 100}
                min={0}
                max={100}
                step={5}
                onChange={(_, v: number | number[]) => patchForm({ probability: Array.isArray(v) ? v[0] ?? 100 : v })}
                valueLabelDisplay="auto"
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="优先级"
                type="number"
                value={form?.priority ?? 0}
                onChange={(e) => patchForm({ priority: Number(e.target.value) })}
                fullWidth
                helperText="数字越大越优先"
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <Stack direction="row" spacing={3}>
                <FormControlLabel
                  control={<Switch checked={form?.constant ?? false} onChange={(e) => patchForm({ constant: e.target.checked })} />}
                  label="常驻（每轮必注入）"
                />
                <FormControlLabel
                  control={<Switch checked={form?.enabled ?? true} onChange={(e) => patchForm({ enabled: e.target.checked })} />}
                  label="启用"
                />
              </Stack>
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                label="内容"
                value={form?.content ?? ''}
                onChange={(e) => patchForm({ content: e.target.value })}
                multiline
                minRows={5}
                fullWidth
                helperText="命中后注入给她的世界设定文本"
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                label="备注"
                value={form?.comment ?? ''}
                onChange={(e) => patchForm({ comment: e.target.value })}
                fullWidth
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={(form?.keys.length ?? 0) === 0 || saveMutation.isPending}
            onClick={() => form && saveMutation.mutate(form)}
          >
            {saveMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除这条词条？"
        content={deleteTarget?.keys.join('、')}
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
