import { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListSubheader from '@mui/material/ListSubheader';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import type { ReactNode } from 'react';
import SearchIcon from '@mui/icons-material/Search';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ForumIcon from '@mui/icons-material/Forum';
import FaceIcon from '@mui/icons-material/Face';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import GavelIcon from '@mui/icons-material/Gavel';
import PeopleIcon from '@mui/icons-material/People';
import PsychologyIcon from '@mui/icons-material/Psychology';
import EditNoteIcon from '@mui/icons-material/EditNote';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import ScheduleIcon from '@mui/icons-material/Schedule';
import TuneIcon from '@mui/icons-material/Tune';
import SettingsIcon from '@mui/icons-material/Settings';
import ExtensionIcon from '@mui/icons-material/Extension';
import OndemandVideoIcon from '@mui/icons-material/OndemandVideo';
import LinkIcon from '@mui/icons-material/Link';
import BugReportIcon from '@mui/icons-material/BugReport';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import { auth } from '../api/endpoints';
import { useAppStore } from '../stores/appStore';
import { errMsg, useUiStore } from '../stores/uiStore';
import BotSwitcher from './BotSwitcher';
import SearchDialog from './SearchDialog';
import Snackbars from './Snackbars';

const DRAWER_WIDTH = 236;

interface NavEntry {
  label: string;
  path: string;
  icon: ReactNode;
}

const NAV_GROUPS: { group: string; items: NavEntry[] }[] = [
  { group: '会话', items: [{ label: '聊天', path: '/chat', icon: <ForumIcon fontSize="small" /> }] },
  {
    group: '她',
    items: [
      { label: '总览', path: '/console/dashboard', icon: <DashboardIcon fontSize="small" /> },
      { label: '角色', path: '/console/characters', icon: <FaceIcon fontSize="small" /> },
      { label: '世界书', path: '/console/worldbook', icon: <MenuBookIcon fontSize="small" /> },
      { label: '成长', path: '/console/growth', icon: <TrendingUpIcon fontSize="small" /> },
      { label: '铁律', path: '/console/rules', icon: <GavelIcon fontSize="small" /> },
    ],
  },
  {
    group: '她与世界',
    items: [
      { label: '联系人', path: '/console/contacts', icon: <PeopleIcon fontSize="small" /> },
      { label: '记忆', path: '/console/memories', icon: <PsychologyIcon fontSize="small" /> },
      { label: '日记', path: '/console/diary', icon: <EditNoteIcon fontSize="small" /> },
      { label: '相册', path: '/console/album', icon: <PhotoLibraryIcon fontSize="small" /> },
      { label: '定时消息', path: '/console/scheduled', icon: <ScheduleIcon fontSize="small" /> },
    ],
  },
  {
    group: '系统',
    items: [
      { label: '机器人设置', path: '/console/settings-bot', icon: <TuneIcon fontSize="small" /> },
      { label: '全局设置', path: '/console/settings-global', icon: <SettingsIcon fontSize="small" /> },
      { label: '插件', path: '/console/plugins', icon: <ExtensionIcon fontSize="small" /> },
      { label: '账号绑定', path: '/console/bind', icon: <LinkIcon fontSize="small" /> },
      { label: 'Bilibili', path: '/console/bili', icon: <OndemandVideoIcon fontSize="small" /> },
      { label: '调试', path: '/console/debug', icon: <BugReportIcon fontSize="small" /> },
    ],
  },
];

function DrawerContent({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  return (
    <Box sx={{ overflowY: 'auto', height: '100%', pb: 4 }}>
      {NAV_GROUPS.map((g) => (
        <List
          key={g.group}
          dense
          subheader={
            <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '32px', mt: 1 }}>
              {g.group}
            </ListSubheader>
          }
        >
          {g.items.map((item) => {
            const active = item.path === '/chat' ? location.pathname === '/chat' : location.pathname.startsWith(item.path);
            return (
              <ListItemButton
                key={item.path}
                component={NavLink}
                to={item.path}
                selected={active}
                onClick={onNavigate}
                sx={{ mx: 1, mb: 0.25 }}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
              </ListItemButton>
            );
          })}
        </List>
      ))}
    </Box>
  );
}

export default function Layout() {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenuAnchor, setUserMenuAnchor] = useState<HTMLElement | null>(null);
  const themeMode = useAppStore((s) => s.themeMode);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const showSnack = useUiStore((s) => s.showSnack);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch (e) {
      showSnack(errMsg(e), 'warning');
    }
    setUser(null);
    navigate('/login', { replace: true });
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider', zIndex: (t) => t.zIndex.drawer + 1 }}
      >
        <Toolbar sx={{ gap: 1.5, minHeight: { xs: 56, sm: 60 } }}>
          {!isDesktop && (
            <IconButton edge="start" onClick={() => setDrawerOpen(true)} aria-label="打开菜单">
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="subtitle1" sx={{ fontWeight: 700, display: { xs: 'none', sm: 'block' }, mr: 1 }}>
            Littly
          </Typography>
          <BotSwitcher />
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="搜索（Ctrl+K）">
            <IconButton onClick={() => setSearchOpen(true)} aria-label="全局搜索">
              <SearchIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={themeMode === 'dark' ? '切换到浅色' : '切换到深色'}>
            <IconButton onClick={toggleTheme} aria-label="切换主题">
              {themeMode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
          <IconButton onClick={(e) => setUserMenuAnchor(e.currentTarget)} aria-label="账户">
            <AccountCircleIcon />
          </IconButton>
          <Menu anchorEl={userMenuAnchor} open={!!userMenuAnchor} onClose={() => setUserMenuAnchor(null)}>
            <MenuItem disabled sx={{ opacity: '1 !important' }}>
              <Typography variant="body2" color="text.primary">
                {user?.username ?? '未登录'}
              </Typography>
            </MenuItem>
            <Divider />
            <MenuItem onClick={() => void handleLogout()}>
              <ListItemIcon>
                <LogoutIcon fontSize="small" />
              </ListItemIcon>
              退出登录
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {isDesktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box', borderRight: 1, borderColor: 'divider', pt: '60px' },
          }}
        >
          <DrawerContent />
        </Drawer>
      ) : (
        <Drawer variant="temporary" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Box sx={{ pt: '56px' }}>
            <DrawerContent onNavigate={() => setDrawerOpen(false)} />
          </Box>
        </Drawer>
      )}

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          pt: { xs: '56px', sm: '60px' },
          height: '100dvh',
        }}
      >
        <Outlet />
      </Box>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Snackbars />
    </Box>
  );
}
