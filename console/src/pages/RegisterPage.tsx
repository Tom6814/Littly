import AuthForm from './AuthForm';
import Snackbars from '../components/Snackbars';

export default function RegisterPage() {
  return (
    <>
      <AuthForm mode="register" />
      <Snackbars />
    </>
  );
}
