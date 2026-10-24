import { useState, type KeyboardEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import SendIcon from '@mui/icons-material/Send';
import Tooltip from '@mui/material/Tooltip';

const QUICK_COMMANDS = ['画图', '搜索', '写文档', '记一下', '提醒'] as const;

interface Props {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => void;
}

export default function Composer({ disabled, sending, onSend }: Props) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || disabled || sending) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const applyQuick = (label: string) => {
    const prefix = `${label}：`;
    setText((prev) => (prev.startsWith(prefix) ? prev : prefix + prev));
  };

  return (
    <Box sx={{ px: { xs: 1.5, sm: 3 }, pb: 1.5, pt: 0.5 }}>
      <Stack direction="row" spacing={0.75} sx={{ mb: 1, flexWrap: 'wrap' }} useFlexGap>
        {QUICK_COMMANDS.map((q) => (
          <Chip key={q} label={q} size="small" variant="outlined" onClick={() => applyQuick(q)} disabled={disabled} />
        ))}
      </Stack>
      <Stack direction="row" spacing={1} alignItems="flex-end">
        <TextField
          multiline
          maxRows={6}
          fullWidth
          placeholder={disabled ? '选择一个联系人后开始对话' : '和她说点什么…（Enter 发送，Shift+Enter 换行）'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        <Tooltip title="发送（Enter）">
          <span>
            <IconButton color="primary" onClick={submit} disabled={disabled || sending || text.trim() === ''} sx={{ p: 1.25 }}>
              <SendIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {sending && (
        <Box sx={{ mt: 0.5 }}>
          <Button size="small" disabled variant="text">
            她正在处理…
          </Button>
        </Box>
      )}
    </Box>
  );
}
