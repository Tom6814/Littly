import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
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
import BugReportIcon from '@mui/icons-material/BugReport';
import LayersIcon from '@mui/icons-material/Layers';
import { contacts as contactsApi, debug } from '../../api/endpoints';
import { errMsg } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import { SkeletonList } from '../../components/Loading';

export default function DebugPage() {
  const botId = useBotId();
  const contactsQuery = useQuery({
    queryKey: ['contacts', botId],
    queryFn: () => contactsApi.list(botId ?? ''),
    enabled: !!botId,
  });
  const [sender, setSender] = useState('');

  const promptQuery = useQuery({
    queryKey: ['system-prompt', botId, sender],
    queryFn: () => debug.systemPrompt(botId ?? '', sender || undefined),
    enabled: !!botId,
    retry: 0,
  });
  const [category, setCategory] = useState('');
  const auditQuery = useQuery({
    queryKey: ['debug-audit', botId, category],
    queryFn: () => debug.audit(botId ?? '', category || undefined),
    enabled: !!botId,
    retry: 0,
  });

  const layers = promptQuery.data?.layers ?? [];
  const audit = auditQuery.data ?? [];
  const categories = useMemo(() => [...new Set(audit.map((a) => a.category).filter((c): c is string => !!c))], [audit]);

  return (
    <Box>
      <PageHeader
        title="调试"
        subtitle="分层提示词与事实审计——她每一轮看到了什么"
      />

      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid size={{ xs: 12, sm: 6 }}>
          <TextField
            select
            label="联系人（影响联系人层）"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            fullWidth
            SelectProps={{ displayEmpty: true }}
          >
            <MenuItem value="">不指定</MenuItem>
            {(contactsQuery.data ?? []).map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
      </Grid>

      {/* 分层提示词 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <LayersIcon fontSize="small" sx={{ color: 'primary.main' }} />
        <Typography variant="subtitle2">分层提示词</Typography>
        {promptQuery.data?.totalChars !== undefined && (
          <Chip size="small" variant="outlined" label={`共 ${promptQuery.data.totalChars} 字符`} />
        )}
      </Stack>

      {promptQuery.isPending ? (
        <SkeletonList rows={5} />
      ) : promptQuery.isError ? (
        <Alert_ message={errMsg(promptQuery.error)} />
      ) : layers.length === 0 ? (
        <EmptyState icon={<LayersIcon />} text="暂无分层提示词数据" hint="后端未返回 layers，或她还没有被唤醒过" />
      ) : (
        <Box sx={{ mb: 4 }}>
          {layers.map((l, i) => (
            <Accordion key={`${l.name}-${i}`} defaultExpanded={i === 0}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle2" noWrap>
                    {l.name}
                  </Typography>
                  {l.source && <Chip size="small" variant="outlined" label={l.source} />}
                  <Tooltip title="字符数">
                    <Chip size="small" label={`${l.chars ?? 0}`} />
                  </Tooltip>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: 'action.hover',
                    fontSize: 12.5,
                    lineHeight: 1.7,
                    overflow: 'auto',
                    maxHeight: 420,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {l.content || '（空）'}
                </Box>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}

      {/* 审计日志 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <BugReportIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="subtitle2">事实审计</Typography>
      </Stack>
      <TextField
        select
        label="类别"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        fullWidth
        sx={{ mb: 1.5, maxWidth: 300 }}
      >
        <MenuItem value="">全部</MenuItem>
        {categories.map((c) => (
          <MenuItem key={c} value={c}>
            {c}
          </MenuItem>
        ))}
      </TextField>

      {auditQuery.isPending ? (
        <SkeletonList rows={4} />
      ) : auditQuery.isError ? (
        <Alert_ message={errMsg(auditQuery.error)} />
      ) : audit.length === 0 ? (
        <EmptyState icon={<BugReportIcon />} text="暂无审计记录" hint="事实审计以对话原文为金标准，记录会随使用累积" />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>类别</TableCell>
                <TableCell>摘要</TableCell>
                <TableCell>详情</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {audit.map((a, i) => (
                <TableRow key={a.id ?? i} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="caption">{a.time ?? '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={a.category ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" noWrap title={a.summary ?? ''} sx={{ maxWidth: 320 }}>
                      {a.summary ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={a.detail ?? ''} placement="top">
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 280 }}>
                        {a.detail ?? '—'}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

function Alert_({ message }: { message: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {message}
      </Typography>
    </Paper>
  );
}
