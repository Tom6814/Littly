import { Box, Skeleton, Stack } from '@mui/material';

/** 列表加载骨架 */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <Stack spacing={1.5}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={52} animation="wave" />
      ))}
    </Stack>
  );
}

/** 表格加载骨架 */
export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <Box>
      <Skeleton variant="rounded" height={40} sx={{ mb: 1 }} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={44} animation="wave" sx={{ mb: 0.75 }} />
      ))}
    </Box>
  );
}

/** 卡片加载骨架 */
export function SkeletonCards({ count = 6, height = 120 }: { count?: number; height?: number }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 2 }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={height} animation="wave" />
      ))}
    </Box>
  );
}
