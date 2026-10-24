import { useEffect } from 'react';
import { Outlet, useLocation, Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Box, CircularProgress, Typography, Button, Stack } from '@mui/material';
import { auth } from '../api/endpoints';
import { useAppStore } from '../stores/appStore';

export default function RequireAuth() {
  const location = useLocation();
  const setUser = useAppStore((s) => s.setUser);
  const query = useQuery({ queryKey: ['session'], queryFn: auth.session, staleTime: 60_000 });

  useEffect(() => {
    if (query.data !== undefined) setUser(query.data);
  }, [query.data, setUser]);

  if (query.isPending) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress color="primary" />
      </Box>
    );
  }
  if (query.isError) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Stack spacing={2} alignItems="center">
          <Typography color="error">无法确认登录状态：{(query.error as Error).message}</Typography>
          <Button variant="contained" onClick={() => void query.refetch()}>
            重试
          </Button>
        </Stack>
      </Box>
    );
  }
  if (!query.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
