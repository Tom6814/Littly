import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

/** 通用设置字段：布尔 → 开关，数字 → 数字框，字符串 → 文本框；secret 键打码显示。 */
export function SettingsField({
  label,
  value,
  onChange,
  secret = false,
  help,
  multiline = false,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  secret?: boolean;
  help?: string;
  multiline?: boolean;
}) {
  const [show, setShow] = useState(false);

  if (typeof value === 'boolean') {
    return (
      <FormControlLabel
        control={<Switch checked={value} onChange={(e) => onChange(e.target.checked)} />}
        label={label}
        sx={{ my: 0.25 }}
      />
    );
  }

  if (typeof value === 'number') {
    return (
      <TextField
        label={label}
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : e.target.value);
        }}
        fullWidth
        helperText={help}
      />
    );
  }

  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);

  return (
    <TextField
      label={label}
      type={secret && !show ? 'password' : 'text'}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      multiline={multiline}
      minRows={multiline ? 2 : undefined}
      fullWidth
      helperText={help}
      slotProps={{
        input: {
          endAdornment: secret ? (
            <InputAdornment position="end">
              <Tooltip title={show ? '隐藏' : '已打码，点击查看'}>
                <IconButton size="small" onClick={() => setShow((s) => !s)} edge="end">
                  {show ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ) : undefined,
        },
      }}
    />
  );
}

/** 真实生效值提示行 */
export function EffectiveHint({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: -0.25 }}>
      <Typography variant="caption" color="text.disabled">
        真实生效值：
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>
        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
      </Typography>
    </Stack>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
        gap: 1.5,
        alignItems: 'start',
      }}
    >
      {children}
    </Box>
  );
}
