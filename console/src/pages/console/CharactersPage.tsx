import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import FaceIcon from '@mui/icons-material/Face';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import PersonIcon from '@mui/icons-material/Person';
import { characters } from '../../api/endpoints';
import type { Character } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonCards } from '../../components/Loading';

/** chips 输入（回车/逗号添加） */
function TagsField({ value, onChange, label, placeholder }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <TextField
      label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
      helperText={value.length > 0 ? `已添加：${value.join('、')}` : undefined}
      fullWidth
    />
  );
}

interface EditorState {
  id: string | null;
  name: string;
  mask: string;
  tags: string[];
  cardText: string;
  cardError: string | null;
}

const emptyEditor: EditorState = { id: null, name: '', mask: '', tags: [], cardText: '{\n  "spec": "chara_card_v2",\n  "data": {}\n}', cardError: null };

function editorFrom(c: Character): EditorState {
  return {
    id: c.id,
    name: c.name,
    mask: c.mask ?? '',
    tags: c.deepseekPersonaTags ?? [],
    cardText: c.card ? JSON.stringify(c.card, null, 2) : '',
    cardError: null,
  };
}

export default function CharactersPage() {
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);
  const listQuery = useQuery({ queryKey: ['characters'], queryFn: characters.list });

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Character | null>(null);
  const [tab, setTab] = useState(0);
  const pngInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const avatarTargetRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['characters'] });

  const saveMutation = useMutation({
    mutationFn: async (e: EditorState) => {
      let card: Record<string, unknown> | undefined;
      if (e.cardText.trim()) {
        try {
          const parsed: unknown = JSON.parse(e.cardText);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('角色卡 JSON 必须是对象');
          card = parsed as Record<string, unknown>;
        } catch (err) {
          throw new Error(`角色卡 JSON 无效：${err instanceof Error ? err.message : '解析失败'}`);
        }
      }
      const body: Record<string, unknown> = { name: e.name.trim(), mask: e.mask, deepseekPersonaTags: e.tags };
      if (card) body.card = card;
      if (e.id) return characters.update(e.id, body);
      return characters.create(body);
    },
    onSuccess: () => {
      setEditor(null);
      invalidate();
      showSnack('已保存', 'success');
    },
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => characters.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      showSnack('已删除', 'success');
    },
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => characters.importPng(file),
    onSuccess: () => {
      invalidate();
      showSnack('角色卡导入成功', 'success');
    },
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const exportMutation = useMutation({
    mutationFn: (c: Character) => characters.exportPng(c.id),
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const avatarMutation = useMutation({
    mutationFn: (input: { id: string; file: File }) => characters.uploadAvatar(input.id, input.file),
    onSuccess: () => {
      invalidate();
      showSnack('头像已更新', 'success');
    },
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const presetMutation = useMutation({
    mutationFn: (p: Character) =>
      characters.create({ name: `${p.name}（副本）`, card: p.card, mask: p.mask, deepseekPersonaTags: p.deepseekPersonaTags }),
    onSuccess: () => {
      invalidate();
      showSnack('已从预设创建角色', 'success');
    },
    onError: (err) => showSnack(errMsg(err), 'error'),
  });

  const all = listQuery.data ?? [];
  const presets = all.filter((c) => c.preset);
  const mine = all.filter((c) => !c.preset);
  const shown = presets.length > 0 ? mine : all;

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.png')) {
      showSnack('请选择 PNG 角色卡', 'warning');
      return;
    }
    importMutation.mutate(file);
  };

  const renderCard = (c: Character) => (
    <Grid key={c.id} size={{ xs: 12, sm: 6, md: 4 }}>
      <Card variant="outlined" sx={{ height: '100%' }}>
        <CardContent>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
            <Avatar src={c.avatarUrl} sx={{ width: 44, height: 44 }}>
              {c.name.slice(0, 1)}
            </Avatar>
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <Typography variant="subtitle1" noWrap>
                {c.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap display="block">
                {c.card ? 'chara_card_v2' : '无角色卡'}
              </Typography>
            </Box>
          </Stack>
          {(c.deepseekPersonaTags ?? []).length > 0 && (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              {(c.deepseekPersonaTags ?? []).slice(0, 4).map((t) => (
                <Chip key={t} label={t} size="small" variant="outlined" />
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="编辑">
              <IconButton size="small" onClick={() => setEditor(editorFrom(c))}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="导出 PNG 角色卡">
              <span>
                <IconButton size="small" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate(c)}>
                  <DownloadIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="上传头像">
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    avatarTargetRef.current = c.id;
                    avatarInputRef.current?.click();
                  }}
                >
                  <PersonIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip title="删除">
              <IconButton size="small" color="error" onClick={() => setDeleteTarget(c)}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </CardContent>
      </Card>
    </Grid>
  );

  return (
    <Box>
      <PageHeader
        title="角色"
        subtitle="她是谁——角色卡永远只读，人格由这里定义"
        actions={
          <>
            <Button variant="outlined" startIcon={<FileUploadIcon />} onClick={() => pngInputRef.current?.click()}>
              导入 PNG
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditor(emptyEditor)}>
              新建角色
            </Button>
          </>
        }
      />

      <input
        ref={pngInputRef}
        type="file"
        accept="image/png"
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && avatarTargetRef.current) avatarMutation.mutate({ id: avatarTargetRef.current, file });
          e.target.value = '';
        }}
      />

      {presets.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <AutoAwesomeIcon fontSize="small" sx={{ color: 'secondary.main' }} />
            <Typography variant="subtitle2">预设画廊</Typography>
            <Typography variant="caption" color="text.secondary">
              点击「使用」以预设为模板创建
            </Typography>
          </Stack>
          <Grid container spacing={2}>
            {presets.map((p) => (
              <Grid key={p.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <Card variant="outlined">
                  <CardContent>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Avatar src={p.avatarUrl} sx={{ width: 40, height: 40 }}>
                        {p.name.slice(0, 1)}
                      </Avatar>
                      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                        <Typography variant="subtitle2" noWrap>
                          {p.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                          {(p.deepseekPersonaTags ?? []).join('、') || '官方预设'}
                        </Typography>
                      </Box>
                      <Button size="small" onClick={() => presetMutation.mutate(p)} disabled={presetMutation.isPending}>
                        使用
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      )}

      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        sx={{
          borderRadius: 2,
          border: 2,
          borderStyle: dragOver ? 'solid' : 'dashed',
          borderColor: dragOver ? 'primary.main' : 'divider',
          p: dragOver ? 1 : 0,
          transition: 'padding 0.1s',
        }}
      >
        {listQuery.isPending ? (
          <Box sx={{ p: 1 }}>
            <SkeletonCards />
          </Box>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<FaceIcon />}
            text="还没有角色"
            hint="新建一个，或把 PNG 角色卡拖进来"
            action={
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditor(emptyEditor)}>
                新建角色
              </Button>
            }
          />
        ) : (
          <Box sx={{ p: 1 }}>
            <Grid container spacing={2}>
              {shown.map(renderCard)}
            </Grid>
          </Box>
        )}
      </Box>

      {/* 编辑器 */}
      <Dialog
        open={!!editor}
        onClose={() => setEditor(null)}
        maxWidth="md"
        fullWidth
        slotProps={{ paper: { sx: { minHeight: '70vh' } } }}
      >
        <DialogTitle>{editor?.id ? '编辑角色' : '新建角色'}</DialogTitle>
        <DialogContent dividers>
          <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="基础" />
            <Tab label="角色卡 JSON" />
          </Tabs>
          {tab === 0 && (
            <Stack spacing={2}>
              <TextField
                label="名字"
                value={editor?.name ?? ''}
                onChange={(e) => setEditor((p) => (p ? { ...p, name: e.target.value } : p))}
                fullWidth
              />
              <TextField
                label="面具（mask 文本）"
                value={editor?.mask ?? ''}
                onChange={(e) => setEditor((p) => (p ? { ...p, mask: e.target.value } : p))}
                multiline
                minRows={4}
                fullWidth
                helperText="她在不同语境下对外的样子"
              />
              <TagsField
                label="deepseek_persona 标签"
                placeholder="回车添加，例如：温柔"
                value={editor?.tags ?? []}
                onChange={(tags) => setEditor((p) => (p ? { ...p, tags } : p))}
              />
            </Stack>
          )}
          {tab === 1 && (
            <Stack spacing={1}>
              <Alert severity="info" variant="outlined">
                粘贴 chara_card_v2 JSON（含 spec 与 data 字段）。保存前会校验格式。
              </Alert>
              <TextField
                value={editor?.cardText ?? ''}
                onChange={(e) => setEditor((p) => (p ? { ...p, cardText: e.target.value, cardError: null } : p))}
                multiline
                minRows={16}
                fullWidth
                slotProps={{ input: { sx: { fontFamily: 'ui-monospace, monospace', fontSize: 13 } } }}
              />
              {editor?.cardError && <Alert severity="error">{editor.cardError}</Alert>}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditor(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={!editor?.name.trim() || saveMutation.isPending}
            onClick={() => editor && saveMutation.mutate(editor)}
          >
            {saveMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除角色「${deleteTarget?.name ?? ''}」？`}
        content="删除后不可恢复。"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
