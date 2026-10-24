import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditNoteIcon from '@mui/icons-material/EditNote';
import HistoryEduIcon from '@mui/icons-material/HistoryEdu';
import { diary } from '../../api/endpoints';
import type { Diary } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonList } from '../../components/Loading';

export default function DiaryPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const diariesQuery = useQuery({
    queryKey: ['diaries', botId],
    queryFn: () => diary.list(botId ?? ''),
    enabled: !!botId,
  });
  const diaries = (diariesQuery.data ?? []).slice().sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const [viewing, setViewing] = useState<Diary | null>(null);
  const [viewContent, setViewContent] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<Diary | null>(null);
  const [writeOpen, setWriteOpen] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['diaries', botId] });

  const writeMutation = useMutation({
    mutationFn: () => diary.write(botId ?? ''),
    onSuccess: () => {
      setWriteOpen(false);
      invalidate();
      showSnack('她已经开始写今天的日记', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => diary.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      setViewing(null);
      invalidate();
      showSnack('已删除', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const openDiary = async (d: Diary) => {
    setViewing(d);
    setViewContent(d.content ?? '');
    try {
      const full = await diary.get(d.id);
      if (full?.content) setViewContent(full.content);
    } catch {
      /* 列表内容兜底 */
    }
  };

  return (
    <Box>
      <PageHeader
        title="日记"
        subtitle="她过自己的生活，也有自己的记录"
        actions={
          <Button variant="contained" startIcon={<HistoryEduIcon />} disabled={!botId || writeMutation.isPending} onClick={() => setWriteOpen(true)}>
            手动写入
          </Button>
        }
      />

      {diariesQuery.isPending ? (
        <SkeletonList rows={6} />
      ) : diaries.length === 0 ? (
        <EmptyState icon={<EditNoteIcon />} text="还没有日记" hint="手动写入，或等她在合适的时候自己写" />
      ) : (
        <List>
          {diaries.map((d) => {
            const dt = d.date && dayjs(d.date).isValid() ? dayjs(d.date) : null;
            return (
              <Paper key={d.id} variant="outlined" sx={{ mb: 1 }}>
                <ListItem
                  secondaryAction={
                    <>
                      <Tooltip title="删除">
                        <IconButton size="small" color="error" onClick={() => setDeleteTarget(d)}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </>
                  }
                  disablePadding
                >
                  <ListItemButton onClick={() => void openDiary(d)} sx={{ pr: 10 }}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="subtitle2">{dt ? dt.format('YYYY年M月D日 ddd') : d.date ?? d.id}</Typography>
                          {d.mood && <Chip size="small" label={d.mood} variant="outlined" />}
                        </Stack>
                      }
                      secondary={(d.content ?? '').slice(0, 80) || '（空）'}
                      slotProps={{ secondary: { noWrap: true } }}
                    />
                  </ListItemButton>
                </ListItem>
              </Paper>
            );
          })}
        </List>
      )}

      <Dialog open={!!viewing} onClose={() => setViewing(null)} maxWidth="md" fullWidth>
        <DialogTitle>{viewing?.date ?? ''}</DialogTitle>
        <DialogContent dividers>
          <Typography sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.9 }}>{viewContent || '（空）'}</Typography>
        </DialogContent>
        <DialogActions>
          <Button color="error" onClick={() => viewing && setDeleteTarget(viewing)}>
            删除
          </Button>
          <Button onClick={() => setViewing(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={writeOpen}
        title="让她现在写一篇日记？"
        content="她会根据最近的经历写日记，可能需要一点时间。"
        confirmText="写入"
        loading={writeMutation.isPending}
        onConfirm={() => writeMutation.mutate()}
        onClose={() => setWriteOpen(false)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除 ${deleteTarget?.date ?? ''} 的日记？`}
        content="删除后不可恢复。"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}
