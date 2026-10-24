import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { useUiStore } from '../stores/uiStore';

export default function Snackbars() {
  const { snackOpen, snackMessage, snackSeverity, closeSnack } = useUiStore();
  return (
    <Snackbar
      open={snackOpen}
      autoHideDuration={3600}
      onClose={closeSnack}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
    >
      <Alert onClose={closeSnack} severity={snackSeverity} variant="filled" sx={{ width: '100%' }}>
        {snackMessage}
      </Alert>
    </Snackbar>
  );
}
