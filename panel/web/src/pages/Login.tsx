import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';

export default function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <form
          className="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/auth/login', { username, password });
              await qc.invalidateQueries({ queryKey: ['me'] });
              navigate('/');
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <h1 className="text-lg font-semibold">Iniciar sesión</h1>
            <p className="text-[13px] text-muted">Accede al panel de administración del servidor.</p>
          </div>
          {error != null && <ErrorBox error={error} />}
          <Field label="Usuario">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </Field>
          <Field label="Contraseña">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
          </Field>
          <Button variant="primary" className="w-full" loading={busy} type="submit">
            Entrar
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-muted">
          ¿Olvidaste la contraseña? Ejecuta <code className="font-mono">sudo hostpanel reset-password</code> en el servidor.
        </p>
      </div>
    </div>
  );
}
