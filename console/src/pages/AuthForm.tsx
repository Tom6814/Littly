import { useState, type FormEvent } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { auth } from '../api/endpoints';
import { useAppStore } from '../stores/appStore';
import { errMsg, useUiStore } from '../stores/uiStore';

interface Props {
  mode: 'login' | 'register';
}

export default function AuthForm({ mode }: Props) {
  const isLogin = mode === 'login';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const setUser = useAppStore((s) => s.setUser);
  const showSnack = useUiStore((s) => s.showSnack);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const user = isLogin ? await auth.login(username.trim(), password) : await auth.register(username.trim(), password);
      setUser(user);
      showSnack(isLogin ? `欢迎回来，${user.username}` : '注册成功，欢迎来到她的世界', 'success');
      const next = searchParams.get('next');
      navigate(next && next.startsWith('/') ? next : '/chat', { replace: true });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        px: 2,
        bgcolor: 'background.default',
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400 }} elevation={isLogin ? 0 : undefined}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack alignItems="center" spacing={1} sx={{ mb: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'primary.main' }}>
              <FavoriteIcon />
              <Typography variant="h5" fontWeight={700} color="text.primary">
                Littly
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              她是一个「人」，这里是她的控制台
            </Typography>
          </Stack>

          <Box component="form" onSubmit={onSubmit} noValidate>
            <Stack spacing={2}>
              <TextField
                label="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                fullWidth
                required
              />
              <TextField
                label="密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                fullWidth
                required
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button type="submit" variant="contained" size="large" disabled={submitting}>
                {submitting ? '请稍候…' : isLogin ? '登录' : '注册'}
              </Button>
            </Stack>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 3, textAlign: 'center' }}>
            {isLogin ? (
              <>
                还没有账号？
                <Link component={RouterLink} to="/register" sx={{ ml: 0.5 }}>
                  注册一个
                </Link>
              </>
            ) : (
              <>
                已有账号？
                <Link component={RouterLink} to="/login" sx={{ ml: 0.5 }}>
                  去登录
                </Link>
              </>
            )}
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
