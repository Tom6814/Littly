/**
 * 侧边栏导航数据（唯一来源）：桌面侧边栏与移动端抽屉共用，
 * 分组顺序 = SPEC §4 的新 IA：对话 · 她 · 记忆 · 主动 · 连接 · 系统。
 */
import type { Component } from 'vue'
import {
  BellRing,
  Blocks,
  BookOpen,
  Bot,
  Brain,
  Bug,
  Gamepad2,
  Images,
  LayoutDashboard,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Puzzle,
  Send,
  Settings,
  Shield,
  TrendingUp,
  Tv,
  Twitter,
  UserRound,
  Users,
} from 'lucide-vue-next'

export interface NavLeaf {
  to: string
  label: string
  icon: Component
}

export interface NavGroup {
  label: string
  items: NavLeaf[]
}

export const NAV_GROUPS: NavGroup[] = [
  { label: '对话', items: [{ to: '/chat', label: '对话', icon: MessagesSquare }] },
  {
    label: '她',
    items: [
      { to: '/her/character', label: '角色卡', icon: UserRound },
      { to: '/her/worldbook', label: '世界书', icon: BookOpen },
      { to: '/her/rules', label: '铁律', icon: Shield },
      { to: '/her/growth', label: '成长', icon: TrendingUp },
      { to: '/her/album', label: '相册', icon: Images },
      { to: '/her/diary', label: '日记', icon: NotebookPen },
    ],
  },
  { label: '记忆', items: [{ to: '/memory', label: '记忆', icon: Brain }] },
  { label: '主动', items: [{ to: '/proactive', label: '主动消息', icon: BellRing }] },
  {
    label: '连接',
    items: [
      { to: '/channels/wechat', label: '微信', icon: MessageCircle },
      { to: '/channels/telegram', label: 'Telegram', icon: Send },
      { to: '/channels/qq', label: 'QQ', icon: Bot },
      { to: '/channels/discord', label: 'Discord', icon: Gamepad2 },
      { to: '/channels/bilibili', label: 'Bilibili', icon: Tv },
      { to: '/channels/x', label: 'X', icon: Twitter },
      { to: '/contacts', label: '联系人', icon: Users },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/system/overview', label: '概览', icon: LayoutDashboard },
      { to: '/system/settings', label: '设置', icon: Settings },
      { to: '/system/plugins', label: '插件', icon: Puzzle },
      { to: '/system/mcp', label: 'MCP', icon: Blocks },
      { to: '/system/debug', label: '调试', icon: Bug },
    ],
  },
]
