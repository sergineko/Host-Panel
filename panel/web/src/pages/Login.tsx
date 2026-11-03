import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';

export default function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ required: boolean; account: boolean }>('/api/setup/status'), retry: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Fresh install without an account yet: the first-run wizard instead.
  if (status.data?.required && !status.data.account) return <Navigate to={`/setup${location.search}`} replace />;

  const codeReady = recovery ? code.replace(/[^a-z0-9]/gi, '').length === 12 : code.length === 6;

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
              const r = await api.post<{ totp_required?: boolean; recovery_codes_left?: number }>('/api/auth/login', { username, password, code: needsCode ? code : undefined });
              if (r.totp_required) {
                setNeedsCode(true);
                return;
              }
              if (r.recovery_codes_left !== undefined) {
                toast.warning(`Has usado un código de recuperación. Te quedan ${r.recovery_codes_left}.`, {
                  description: 'Si perdiste el móvil, configura de nuevo la verificación en dos pasos en Ajustes.',
                  duration: 10_000,
                });
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
                  {recovery ? <KeyRound className="size-5" /> : <ShieldCheck className="size-5" />}
                </div>
                <div>
                  <h1 className="text-lg font-semibold">Verificación en dos pasos</h1>
                  <p className="text-[13px] text-muted">
                    {recovery ? 'Escribe uno de tus códigos de recuperación (cada uno sirve una vez).' : 'Escribe el código de 6 dígitos de tu app de autenticación.'}
                  </p>
                </div>
              </div>
              {error != null && <ErrorBox error={error} />}
              {recovery ? (
                <Input
                  key="recovery"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toLowerCase().slice(0, 16))}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  placeholder="xxxx-xxxx-xxxx"
                  className="h-12 text-center font-mono text-lg tracking-wider"
                />
              ) : (
                <Input
                  key="totp"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="123456"
                  className="h-12 text-center font-mono text-2xl tracking-[0.4em]"
                />
              )}
              <Button variant="primary" className="w-full" loading={busy} disabled={!codeReady} type="submit">
                Verificar
              </Button>
              <div className="flex justify-between text-[13px]">
                <button
                  type="button"
                  className="text-muted hover:text-fg"
                  onClick={() => {
                    setNeedsCode(false);
                    setRecovery(false);
                    setCode('');
                    setError(null);
                  }}
                >
                  Volver
                </button>
                <button
                  type="button"
                  className="text-muted hover:text-fg"
                  onClick={() => {
                    setRecovery((r) => !r);
                    setCode('');
                    setError(null);
                  }}
                >
                  {recovery ? 'Usar la app' : '¿Sin el móvil? Usa un código de recuperación'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <h1 className="text-lg font-semibold">Iniciar sesión</h1>
                <p className="text-[13px] text-muted">Accede al panel de administración del servidor.</p>
              </div>
              {error != null && <ErrorBox error={error} />}
              <Field label="Usuario">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required />
              </Field>
              <Field label="Contraseña">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
              <Button variant="primary" className="w-full" loading={busy} type="submit">
                Entrar
              </Button>
            </>
          )}
        </form>
        <p className="mt-6 text-center text-xs text-muted">¿Olvidaste la contraseña? Pide una nueva al administrador del panel.</p>
      </div>
    </div>
  );
}
