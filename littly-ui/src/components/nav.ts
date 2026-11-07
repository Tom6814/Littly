import type { Component } from 'vue'
import {
  Brain,
  MessagesSquare,
  NotebookPen,
  Settings,
  UserRound,
  Users,
  Bot,
  LayoutDashboard,
  Wrench,
} from 'lucide-vue-next'

export interface NavLeaf { to: string; label: string; icon: Component }
export interface NavGroup { label: string; items: NavLeaf[] }

export const NAV_GROUPS: NavGroup[] = [
  { label: '今天', items: [{ to: '/chat', label: '对话', icon: MessagesSquare }] },
  { label: '她', items: [
    { to: '/her/character', label: '角色卡', icon: UserRound },
    { to: '/her/diary', label: '日记', icon: NotebookPen },
    { to: '/workbench', label: '工作台', icon: Wrench },
  ] },
  { label: '记忆', items: [{ to: '/memory', label: '记忆', icon: Brain }] },
  { label: '世界', items: [
    { to: '/contacts', label: '联系人', icon: Users },
    { to: '/channels/qq', label: 'QQ', icon: Bot },
  ] },
  { label: '系统', items: [
    { to: '/system/overview', label: '概览', icon: LayoutDashboard },
    { to: '/system/settings', label: '设置', icon: Settings },
  ] },
]
