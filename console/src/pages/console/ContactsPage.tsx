import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import EditIcon from '@mui/icons-material/Edit';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import { contacts as contactsApi, memories as memoriesApi, relations as relationsApi } from '../../api/endpoints';
import type { Contact } from '../../api/types';
import { asStr } from '../../api/client';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import { SkeletonList } from '../../components/Loading';

export default function ContactsPage() {
  const botId = useBotId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const contactsQuery = useQuery({
    queryKey: ['contacts', botId],
    queryFn: () => contactsApi.list(botId ?? ''),
    enabled: !!botId,
  });
  const memoriesQuery = useQuery({
    queryKey: ['memories', botId, 'preview'],
    queryFn: () => memoriesApi.list({ botId: botId ?? '' }),
    enabled: !!botId,
  });
  const relationsQuery = useQuery({
    queryKey: ['relations', botId],
    queryFn: () => relationsApi.list(botId ?? ''),
    enabled: !!botId,
  });

  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<Contact | null>(null);
  const [rename, setRename] = useState<Contact | null>(null);
  const [renameText, setRenameText] = useState('');
  const [relationOpen, setRelationOpen] = useState(false);
  const [relationForm, setRelationForm] = useState({ fromId: '', toId: '', type: '', description: '' });

  const all = contactsQuery.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.name.toLowerCase().includes(q));
  }, [all, search]);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['contacts', botId] });
    void queryClient.invalidateQueries({ queryKey: ['relations', botId] });
    void queryClient.invalidateQueries({ queryKey: ['memories', botId] });
  };

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) => contactsApi.update(input.id, { name: input.name }),
    onSuccess: () => {
      setRename(null);
      invalidateAll();
      showSnack('已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const relationMutation = useMutation({
    mutationFn: () => relationsApi.create(botId ?? '', { fromContactId: relationForm.fromId, toContactId: relationForm.toId, type: relationForm.type, description: relationForm.description }),
    onSuccess: () => {
      setRelationOpen(false);
      invalidateAll();
      showSnack('已添加关系', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const detailMemories = useMemo(() => {
    if (!detail) return [];
    return (memoriesQuery.data ?? []).filter((m) => m.sender === detail.id && !m.deletedAt).slice(0, 8);
  }, [detail, memoriesQuery.data]);

  const detailRelations = useMemo(() => {
    if (!detail) return [];
    return (relationsQuery.data ?? []).filter((r) => r.fromContactId === detail.id || r.toContactId === detail.id);
  }, [detail, relationsQuery.data]);

  const detailProfileRows = useMemo(() => {
    if (!detail?.profile) return [];
    return Object.entries(detail.profile)
      .filter(([k]) => !['id', 'name'].includes(k))
      .map(([k, v]) => ({ key: k, value: asStr(v) ?? (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')) }));
  }, [detail?.profile]);

  return (
    <Box>
      <PageHeader
        title="联系人"
        subtitle="她认识的人，以及他们之间的关系"
        actions={
          <>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setRelationOpen(true)} disabled={!botId}>
              添加关系
            </Button>
          </>
        }
      />

      <TextField
        placeholder="搜索联系人…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        fullWidth
        sx={{ mb: 2, maxWidth: 420 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
      />

      {contactsQuery.isPending ? (
        <SkeletonList rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<PeopleAltIcon />} text="还没有联系人" hint="联系人会随对话出现，也可以由后端渠道自动创建" />
      ) : (
        <Grid container spacing={2}>
          {filtered.map((c) => (
            <Grid key={c.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Avatar src={c.avatarUrl} sx={{ width: 44, height: 44 }}>
                    {c.name.slice(0, 1)}
                  </Avatar>
                  <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                    <Typography variant="subtitle1" noWrap>
                      {c.name}
                    </Typography>
                    {c.lastActiveAt && (
                      <Typography variant="caption" color="text.secondary">
                        最近活跃 · {c.lastActiveAt}
                      </Typography>
                    )}
                  </Box>
                  <Tooltip title="改名">
                    <IconButton
                      size="small"
                      onClick={() => {
                        setRename(c);
                        setRenameText(c.name);
                      }}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button size="small" variant="outlined" startIcon={<ChatBubbleOutlineIcon />} onClick={() => navigate(`/chat?sender=${encodeURIComponent(c.id)}`)}>
                    去聊天
                  </Button>
                  <Button size="small" onClick={() => setDetail(c)}>
                    详情
                  </Button>
                </Stack>
              </Paper>
            </Grid>
          ))}
        </Grid>
      )}

      {/* 详情抽屉 */}
      <Drawer anchor="right" open={!!detail} onClose={() => setDetail(null)} slotProps={{ paper: { sx: { width: { xs: '100%', sm: 420 } } } }}>
        {detail && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
              <Avatar src={detail.avatarUrl} sx={{ width: 52, height: 52 }}>
                {detail.name.slice(0, 1)}
              </Avatar>
              <Box>
                <Typography variant="h6">{detail.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {detail.id}
                </Typography>
              </Box>
            </Stack>

            <Button
              fullWidth
              variant="contained"
              startIcon={<ChatBubbleOutlineIcon />}
              onClick={() => navigate(`/chat?sender=${encodeURIComponent(detail.id)}`)}
              sx={{ mb: 2 }}
            >
              去聊天
            </Button>

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              档案
            </Typography>
            {detailProfileRows.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                暂无档案信息
              </Typography>
            ) : (
              <Stack spacing={0.75} sx={{ mb: 2 }}>
                {detailProfileRows.map((r) => (
                  <Stack key={r.key} direction="row" spacing={1}>
                    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 88 }}>
                      {r.key}
                    </Typography>
                    <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                      {r.value}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              记忆速览
            </Typography>
            {detailMemories.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                暂无记忆
              </Typography>
            ) : (
              <Stack spacing={1} sx={{ mb: 2 }}>
                {detailMemories.map((m) => (
                  <Paper key={m.id} variant="outlined" sx={{ p: 1.25 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
                      {m.category && <Chip size="small" label={m.category} variant="outlined" />}
                      {m.importance !== undefined && <Chip size="small" label={`重要度 ${m.importance}`} variant="outlined" color="secondary" />}
                    </Stack>
                    <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                      {m.content ?? ''}
                    </Typography>
                  </Paper>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              关系
            </Typography>
            {detailRelations.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                暂无关系记录
              </Typography>
            ) : (
              <Stack spacing={0.75}>
                {detailRelations.map((r, i) => (
                  <Paper key={r.id ?? i} variant="outlined" sx={{ p: 1.25 }}>
                    <Typography variant="body2">
                      {r.fromName ?? r.fromContactId ?? '?'} → {r.toName ?? r.toContactId ?? '?'}
                      {r.type ? `（${r.type}）` : ''}
                    </Typography>
                    {r.description && (
                      <Typography variant="caption" color="text.secondary">
                        {r.description}
                      </Typography>
                    )}
                  </Paper>
                ))}
              </Stack>
            )}
          </Box>
        )}
      </Drawer>

      {/* 改名 */}
      <Dialog open={!!rename} onClose={() => setRename(null)} maxWidth="xs" fullWidth>
        <DialogTitle>修改名字</DialogTitle>
        <DialogContent>
          <TextField value={renameText} onChange={(e) => setRenameText(e.target.value)} fullWidth sx={{ mt: 1 }} autoFocus />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRename(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={!renameText.trim() || renameMutation.isPending}
            onClick={() => rename && renameMutation.mutate({ id: rename.id, name: renameText.trim() })}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 关系编辑 */}
      <Dialog open={relationOpen} onClose={() => setRelationOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>添加关系</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField select label="谁" value={relationForm.fromId} onChange={(e) => setRelationForm((p) => ({ ...p, fromId: e.target.value }))} fullWidth>
                {all.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField select label="和谁" value={relationForm.toId} onChange={(e) => setRelationForm((p) => ({ ...p, toId: e.target.value }))} fullWidth>
                {all.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="关系类型"
                placeholder="例如：朋友 / 家人 / 同事"
                value={relationForm.type}
                onChange={(e) => setRelationForm((p) => ({ ...p, type: e.target.value }))}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="描述"
                value={relationForm.description}
                onChange={(e) => setRelationForm((p) => ({ ...p, description: e.target.value }))}
                fullWidth
              />
            </Grid>
          </Grid>
          {(relationsQuery.data ?? []).length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="caption" color="text.secondary">
                已有关系：
              </Typography>
              <List dense disablePadding>
                {(relationsQuery.data ?? []).slice(0, 6).map((r, i) => (
                  <ListItem key={r.id ?? i} disableGutters>
                    <ListItemText
                      primary={`${r.fromName ?? r.fromContactId ?? '?'} → ${r.toName ?? r.toContactId ?? '?'}`}
                      secondary={[r.type, r.description].filter(Boolean).join(' · ') || undefined}
                    />
                  </ListItem>
                ))}
              </List>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRelationOpen(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={!relationForm.fromId || !relationForm.toId || relationMutation.isPending}
            onClick={() => relationMutation.mutate()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
