import { MenuItem, TextField, Box, Avatar, Typography } from '@mui/material';
import { useBots, useCurrentBot } from '../hooks';
import { useAppStore } from '../stores/appStore';

/** 顶栏的机器人切换器（她是谁）。 */
export default function BotSwitcher() {
  useBots();
  const botList = useAppStore((s) => s.bots);
  const currentBotId = useAppStore((s) => s.currentBotId);
  const setCurrentBotId = useAppStore((s) => s.setCurrentBotId);
  const current = useCurrentBot();

  if (botList.length === 0) {
    return (
      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
        <Typography variant="body2" color="text.secondary">
          还没有机器人
        </Typography>
      </Box>
    );
  }

  return (
    <TextField
      select
      size="small"
      value={currentBotId ?? ''}
      onChange={(e) => setCurrentBotId(e.target.value)}
      sx={{ minWidth: { xs: 130, sm: 180 } }}
      aria-label="切换机器人"
      slotProps={{ select: { renderValue: () => current?.name ?? '' } }}
    >
      {botList.map((b) => (
        <MenuItem key={b.id} value={b.id}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Avatar src={b.avatarUrl} sx={{ width: 22, height: 22, fontSize: 12 }}>
              {b.name.slice(0, 1)}
            </Avatar>
            {b.name}
          </Box>
        </MenuItem>
      ))}
    </TextField>
  );
}

export function NoBotHint() {
  return (
    <Box sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="body1" gutterBottom>
        还没有创建机器人
      </Typography>
      <Typography variant="body2" color="text.secondary">
        先在「角色」或接口中创建她，才能开始聊天。
      </Typography>
    </Box>
  );
}
