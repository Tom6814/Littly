import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contacts } from '../api/endpoints';
import { useBotId } from '../hooks';
import type { Contact } from '../api/types';

interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  keywords?: string;
}

export const SEARCHABLE_PAGES: NavItem[] = [
  { label: '聊天', path: '/chat', keywords: '对话 会话 消息 chat' },
  { label: '总览', path: '/console/dashboard', keywords: '仪表 活动 统计 dashboard' },
  { label: '角色', path: '/console/characters', keywords: '角色卡 人格 character' },
  { label: '世界书', path: '/console/worldbook', keywords: '词条 关键词 worldbook' },
  { label: '成长', path: '/console/growth', keywords: '成长档案 提议 审批 growth' },
  { label: '联系人', path: '/console/contacts', keywords: '关系 通讯录 contacts' },
  { label: '记忆', path: '/console/memories', keywords: '记忆 淡忘 整理 memories' },
  { label: '日记', path: '/console/diary', keywords: '日记 diary' },
  { label: '相册', path: '/console/album', keywords: '照片 相册 album' },
  { label: '定时消息', path: '/console/scheduled', keywords: '计划 定时 scheduled' },
  { label: '铁律', path: '/console/rules', keywords: '规则 persona rules' },
  { label: '机器人设置', path: '/console/settings-bot', keywords: '参数 渠道 settings bot' },
  { label: '全局设置', path: '/console/settings-global', keywords: 'AI 服务 平台 settings' },
  { label: '插件', path: '/console/plugins', keywords: 'MCP 技能 工具 plugins' },
  { label: 'Bilibili', path: '/console/bili', keywords: 'B站 扫码 bilibili' },
  { label: '调试', path: '/console/debug', keywords: '提示词 审计 debug' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 全局搜索 / 命令面板（Ctrl+K）：页面直达 + 联系人直达聊天。 */
export default function SearchDialog({ open, onClose }: Props) {
  const [text, setText] = useState('');
  const navigate = useNavigate();
  const botId = useBotId();
  const contactsQuery = useQuery({
    queryKey: ['contacts', botId],
    queryFn: () => contacts.list(botId ?? ''),
    enabled: open && !!botId,
  });

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  const pageHits = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return SEARCHABLE_PAGES;
    return SEARCHABLE_PAGES.filter(
      (p) => p.label.toLowerCase().includes(q) || (p.keywords ?? '').includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [text]);

  const contactHits: Contact[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    const all = contactsQuery.data ?? [];
    if (!q) return all.slice(0, 5);
    return all.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 5);
  }, [contactsQuery.data, text]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogContent sx={{ p: 2 }}>
        <TextField
          autoFocus
          fullWidth
          placeholder="搜索页面、联系人…"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
        <List sx={{ mt: 1 }} dense>
          {pageHits.map((p) => (
            <ListItemButton key={p.path} onClick={() => go(p.path)}>
              <ListItemIcon sx={{ minWidth: 36 }}>{p.icon}</ListItemIcon>
              <ListItemText primary={p.label} secondary={p.path} />
            </ListItemButton>
          ))}
          {contactHits.length > 0 && (
            <Typography variant="overline" sx={{ pl: 2, display: 'block', color: 'text.secondary' }}>
              联系人
            </Typography>
          )}
          {contactHits.map((c) => (
            <ListItemButton key={c.id} onClick={() => go(`/chat?sender=${encodeURIComponent(c.id)}`)}>
              <ListItemText primary={`和 ${c.name} 聊天`} secondary="前往会话" />
            </ListItemButton>
          ))}
          {pageHits.length === 0 && contactHits.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3, textAlign: 'center' }}>
              没有匹配的结果
            </Typography>
          )}
        </List>
      </DialogContent>
    </Dialog>
  );
}
