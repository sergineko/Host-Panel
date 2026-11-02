import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';

export default function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(ellipse_at_top,var(--accent-soft),transparent_60%)] px-4">
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
              const r = await api.post<{ totp_required?: boolean }>('/api/auth/login', { username, password, code: needsCode ? code : undefined });
              if (r.totp_required) {
                setNeedsCode(true);
                return;
              }
              await qc.invalidateQueries({ queryKey: ['me'] });
              navigate('/');
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {needsCode ? (
            <>
              <div className="flex items-start gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
                  <ShieldCheck className="size-5" />
                </div>
                <div>
                  <h1 className="text-lg font-semibold">Verificación en dos pasos</h1>
                  <p className="text-[13px] text-muted">Escribe el código de 6 dígitos de tu app de autenticación.</p>
                </div>
              </div>
              {error != null && <ErrorBox error={error} />}
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="123456"
                className="h-12 text-center font-mono text-2xl tracking-[0.4em]"
              />
              <Button variant="primary" className="w-full" loading={busy} disabled={code.length !== 6} type="submit">
                Verificar
              </Button>
              <button
                type="button"
                className="w-full text-center text-[13px] text-muted hover:text-fg"
                onClick={() => {
                  setNeedsCode(false);
                  setCode('');
                  setError(null);
                }}
              >
                Volver
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </form>
        <p className="mt-6 text-center text-xs text-muted">
          ¿Olvidaste la contraseña? Ejecuta <code className="font-mono">sudo hostpanel reset-password</code> en el servidor.
        </p>
      </div>
    </div>
  );
}
