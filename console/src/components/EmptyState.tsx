import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

interface Props {
  icon?: ReactNode;
  text: string;
  hint?: string;
  action?: ReactNode;
}

export default function EmptyState({ icon, text, hint, action }: Props) {
  return (
    <Box sx={{ py: 8, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
      {icon && (
        <Box sx={{ fontSize: 44, opacity: 0.4, mb: 1, display: 'flex' }}>{icon}</Box>
      )}
      <Typography variant="subtitle1" color="text.secondary">
        {text}
      </Typography>
      {hint && (
        <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
          {hint}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  );
}
