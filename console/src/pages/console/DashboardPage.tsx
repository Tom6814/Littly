import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { LineChart } from '@mui/x-charts/LineChart';
import dayjs from 'dayjs';
import { chat } from '../../api/endpoints';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import { SEARCHABLE_PAGES } from '../../components/SearchDialog';

export default function DashboardPage() {
  const botId = useBotId();
  const navigate = useNavigate();

  const messagesQuery = useQuery({
    queryKey: ['messages', botId, 'dashboard'],
    queryFn: () => chat.listMessages(botId ?? '', undefined, 1000),
    enabled: !!botId,
    retry: 0,
    staleTime: 60_000,
  });
  const messages = messagesQuery.data ?? [];

  const chart = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const m of messages) {
      if (!m.createdAt) continue;
      const d = dayjs(m.createdAt);
      if (!d.isValid()) continue;
      const key = d.format('YYYY-MM-DD');
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const dates: Date[] = [];
    const counts: number[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = dayjs().subtract(i, 'day');
      dates.push(d.toDate());
      counts.push(byDay.get(d.format('YYYY-MM-DD')) ?? 0);
    }
    return { dates, counts, total: counts.reduce((a, b) => a + b, 0) };
  }, [messages]);

  const toolStats = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of messages) {
      for (const p of m.pieces) {
        if (p.type === 'tool_call' && p.name) map.set(p.name, (map.get(p.name) ?? 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [messages]);

  if (messagesQuery.isPending) {
    return (
      <Box>
        <PageHeader title="总览" subtitle="她的近况一览" />
        <Skeleton variant="rounded" height={280} />
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="总览"
        subtitle="她的近况一览（统计基于最近 1000 条消息）"
        actions={
          <Button variant="outlined" onClick={() => void messagesQuery.refetch()}>
            刷新
          </Button>
        }
      />

      {messagesQuery.isError && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          暂时取不到消息统计：{(messagesQuery.error as Error).message}
        </Typography>
      )}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {[
          { label: '近 14 天消息', value: chart.total },
          { label: '日均消息', value: Math.round(chart.total / 14) },
          { label: '工具调用', value: toolStats.reduce((a, b) => a + b[1], 0) },
          { label: '使用过的工具', value: toolStats.length },
        ].map((s) => (
          <Grid key={s.label} size={{ xs: 6, md: 3 }}>
            <Paper sx={{ p: 2, height: '100%' }}>
              <Typography variant="h5" fontWeight={700}>
                {s.value}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {s.label}
              </Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          近 14 天消息活跃
        </Typography>
        {chart.total === 0 ? (
          <EmptyState text="这段时间她还没有消息记录" />
        ) : (
          <LineChart
            height={280}
            xAxis={[
              {
                scaleType: 'time',
                data: chart.dates,
                valueFormatter: (v) => dayjs(v).format('M月D日'),
              },
            ]}
            series={[{ label: '消息数', data: chart.counts, area: true, showMark: false }]}
            yAxis={[{ width: 42 }]}
            margin={{ left: 8, right: 16 }}
          />
        )}
      </Paper>

      {toolStats.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            工具调用排行
          </Typography>
          <Grid container spacing={1.5}>
            {toolStats.map(([name, count]) => (
              <Grid key={name} size={{ xs: 6, sm: 3 }}>
                <Paper variant="outlined" sx={{ p: 1.5, textAlign: 'center' }}>
                  <Typography variant="subtitle2" noWrap title={name}>
                    {name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {count} 次
                  </Typography>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </Paper>
      )}

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        快捷入口
      </Typography>
      <Grid container spacing={1.5}>
        {SEARCHABLE_PAGES.filter((p) => p.path !== '/chat').map((p) => (
          <Grid key={p.path} size={{ xs: 6, sm: 4, md: 3 }}>
            <Card variant="outlined">
              <CardActionArea onClick={() => navigate(p.path)}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Box sx={{ display: 'flex', color: 'primary.main' }}>{p.icon}</Box>
                    <Typography variant="body2">{p.label}</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
