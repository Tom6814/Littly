import { createTheme, alpha, type Theme } from '@mui/material/styles';

export const BRAND = {
  primary: '#E5728F',
  primaryDark: '#C9556F',
  secondary: '#8B7FD6',
  chatBubbleUser: '#E5728F',
};

export function makeTheme(mode: 'light' | 'dark'): Theme {
  const dark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      primary: { main: BRAND.primary, dark: BRAND.primaryDark },
      secondary: { main: BRAND.secondary },
      background: dark
        ? { default: '#141317', paper: '#1C1B21' }
        : { default: '#FAF7F8', paper: '#FFFFFF' },
      divider: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    },
    typography: {
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
      h6: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiButton: { styleOverrides: { root: { textTransform: 'none', borderRadius: 10 } } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiChip: { styleOverrides: { root: { borderRadius: 8 } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiListItemButton: { styleOverrides: { root: { borderRadius: 10 } } },
    },
  });
}

/** 消息气泡配色 */
export function bubbleSx(theme: Theme, own: boolean) {
  return {
    px: 1.75,
    py: 1.1,
    maxWidth: { xs: '82%', md: '68%' },
    borderRadius: 3,
    borderTopRightRadius: own ? 1 : 3,
    borderTopLeftRadius: own ? 3 : 1,
    bgcolor: own
      ? theme.palette.mode === 'dark'
        ? alpha(BRAND.primary, 0.28)
        : alpha(BRAND.primary, 0.12)
      : theme.palette.mode === 'dark'
        ? 'rgba(255,255,255,0.06)'
        : 'rgba(0,0,0,0.04)',
  };
}
