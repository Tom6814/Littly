import { create } from 'zustand';
import type { AlertColor } from '@mui/material/Alert';

interface UiState {
  snackOpen: boolean;
  snackMessage: string;
  snackSeverity: AlertColor;
  showSnack: (message: string, severity?: AlertColor) => void;
  closeSnack: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  snackOpen: false,
  snackMessage: '',
  snackSeverity: 'info',
  showSnack: (snackMessage, snackSeverity = 'info') =>
    set({ snackOpen: true, snackMessage, snackSeverity }),
  closeSnack: () => set({ snackOpen: false }),
}));

/** 从异常提取中文提示。 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string' && e) return e;
  return '操作失败，请稍后再试';
}
