import AuthForm from './AuthForm';
import Snackbars from '../components/Snackbars';

export default function LoginPage() {
  return (
    <>
      <AuthForm mode="login" />
      <Snackbars />
    </>
  );
}
