import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import ImageList from '@mui/material/ImageList';
import ImageListItem from '@mui/material/ImageListItem';
import ImageListItemBar from '@mui/material/ImageListItemBar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import { photos } from '../../api/endpoints';
import type { Photo } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonCards } from '../../components/Loading';

export default function AlbumPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const photosQuery = useQuery({
    queryKey: ['photos', botId],
    queryFn: () => photos.list(botId ?? ''),
    enabled: !!botId,
  });
  const list = photosQuery.data ?? [];

  const [editTarget, setEditTarget] = useState<Photo | null>(null);
  const [caption, setCaption] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Photo | null>(null);
  const [lightbox, setLightbox] = useState<Photo | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['photos', botId] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => photos.upload(botId ?? '', file),
    onSuccess: () => {
      invalidate();
      showSnack('已上传', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; patch: Record<string, unknown> }) => photos.update(input.id, botId ?? '', input.patch),
    onSuccess: () => {
      setEditTarget(null);
      invalidate();
      showSnack('已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => photos.remove(id, botId ?? ''),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      showSnack('已删除', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const openEdit = (p: Photo) => {
    setEditTarget(p);
    setCaption(p.caption ?? '');
    setTagsText((p.tags ?? []).join('、'));
  };

  return (
    <Box>
      <PageHeader
        title="相册"
        subtitle="她看过的世界，留下的瞬间"
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                files.slice(0, 9).forEach((f) => uploadMutation.mutate(f));
                e.target.value = '';
              }}
            />
            <Button variant="contained" startIcon={<AddPhotoAlternateIcon />} disabled={!botId} onClick={() => fileRef.current?.click()}>
              上传照片
            </Button>
          </>
        }
      />

      {photosQuery.isPending ? (
        <SkeletonCards count={6} height={200} />
      ) : list.length === 0 ? (
        <EmptyState icon={<PhotoLibraryIcon />} text="相册还是空的" hint="上传第一张照片，和她分享" />
      ) : (
        <ImageList cols={3} gap={12} sx={{ m: 0 }} rowHeight={220}>
          {list.map((p) => (
            <ImageListItem key={p.id} sx={{ borderRadius: 2, overflow: 'hidden' }}>
              <Box
                component="img"
                src={p.url}
                alt={p.caption ?? '照片'}
                loading="lazy"
                onClick={() => setLightbox(p)}
                sx={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' }}
              />
              <ImageListItemBar
                title={p.caption || '未命名'}
                subtitle={(p.tags ?? []).join('、')}
                actionIcon={
                  <Stack direction="row" sx={{ pr: 0.75 }}>
                    <Tooltip title="编辑">
                      <IconButton size="small" sx={{ color: 'rgba(255,255,255,0.85)' }} onClick={() => openEdit(p)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="删除">
                      <IconButton size="small" sx={{ color: 'rgba(255,255,255,0.85)' }} onClick={() => setDeleteTarget(p)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                }
              />
            </ImageListItem>
          ))}
        </ImageList>
      )}

      <Dialog open={!!editTarget} onClose={() => setEditTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>编辑照片</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            {editTarget?.url && (
              <Box component="img" src={editTarget.url} alt="" sx={{ maxWidth: '100%', maxHeight: 240, borderRadius: 2, objectFit: 'contain' }} />
            )}
            <TextField label="说明" value={caption} onChange={(e) => setCaption(e.target.value)} fullWidth />
            <TextField
              label="标签"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              helperText="顿号/逗号分隔"
              fullWidth
            />
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {(tagsText.split(/[，,、]+/).filter(Boolean)).map((t) => (
                <Chip key={t} label={t.trim()} size="small" variant="outlined" />
              ))}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={updateMutation.isPending}
            onClick={() =>
              editTarget &&
              updateMutation.mutate({
                id: editTarget.id,
                patch: {
                  caption,
                  tags: tagsText.split(/[，,、\s]+/).map((t) => t.trim()).filter(Boolean),
                },
              })
            }
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!lightbox} onClose={() => setLightbox(null)} maxWidth="lg">
        {lightbox?.url && (
          <Box component="img" src={lightbox.url} alt={lightbox.caption ?? ''} sx={{ maxWidth: '86vw', maxHeight: '82vh', display: 'block' }} />
        )}
        {lightbox?.caption && (
          <Typography variant="body2" sx={{ px: 2, py: 1 }}>
            {lightbox.caption}
          </Typography>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除这张照片？"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
