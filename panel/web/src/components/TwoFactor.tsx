import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { renderSVG } from 'uqr';
import { Check, Copy, Download, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Copyable, ErrorBox, Field, Input, Spinner } from './ui';

/** Apps that read the QR code (all use standard TOTP: SHA-1, 6 digits, 30 s). */
export const AUTH_APPS = 'Contraseñas de Apple (iPhone, iPad y Mac), Microsoft Authenticator, Google Authenticator, 1Password, Bitwarden o Authy';

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP": easier to type by hand. */
const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/** One-time recovery codes, shown right after they are generated. */
export function RecoveryCodes({ codes, onConfirm, confirmLabel = 'Los he guardado' }: { codes: string[]; onConfirm?: () => void; confirmLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = `Códigos de recuperación de HostPanel (${location.host})\nCada código sirve una sola vez.\n\n${codes.join('\n')}\n`;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Si pierdes el móvil, entra con uno de estos códigos en lugar del de la app. <strong className="text-fg">Cada uno sirve una vez</strong> y no se
        volverán a mostrar: guárdalos en tu gestor de contraseñas o imprímelos.
      </p>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border bg-surface-2 p-3 font-mono text-[13.5px] tabular-nums">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          Copiar
        </Button>
        <Button
          size="sm"
          icon={<Download className="size-3.5" />}
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'hostpanel-codigos-recuperacion.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Descargar .txt
        </Button>
      </div>
      {onConfirm && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            He guardado los códigos en un lugar seguro
          </label>
          <Button variant="primary" disabled={!saved} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Enrolment: QR code (or "add on this device" link, which opens Apple Passwords on iPhone/Mac
 * and the authenticator app on Android), the code check, then the recovery codes.
 */
export function TotpEnroll({ onDone, doneLabel }: { onDone: () => void; doneLabel?: string }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; uri: string }>('/api/auth/2fa/setup'), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api.post<{ recovery_codes: string[] }>('/api/auth/2fa/enable', { code }),
    onSuccess: (r) => setCodes(r.recovery_codes),
  });
  const qr = useMemo(() => (setup ? renderSVG(setup.uri, { border: 1 }) : ''), [setup]);
  // Once only: a second call would replace the secret the QR shows.
  const started = useRef(false);
  const { mutate: begin } = start;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, [begin]);

  if (codes) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 font-medium text-ok">
          <Check className="size-4" /> Verificación en dos pasos activada
        </div>
        <RecoveryCodes codes={codes} onConfirm={onDone} confirmLabel={doneLabel ?? 'Terminar'} />
      </div>
    );
  }
  if (start.error) return <ErrorBox error={start.error} />;
  if (!setup) return <Spinner />;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) enable.mutate();
      }}
    >
      <div className="grid items-start gap-4 sm:grid-cols-[176px_1fr]">
        <div className="mx-auto w-44 rounded-lg border border-border bg-white p-2" dangerouslySetInnerHTML={{ __html: qr }} aria-label="Código QR para la app de autenticación" />
        <div className="space-y-3 text-[13px]">
          <p>
            <strong>1.</strong> Escanea el código con la cámara del móvil o con tu app: <span className="text-muted">{AUTH_APPS}</span>.
          </p>
          <p className="text-muted">
            En un iPhone, iPad o Mac la cámara lo guarda directamente en <strong className="text-fg">Contraseñas</strong>, y después el código se rellena solo al
            iniciar sesión.
          </p>
          <a
            href={setup.uri}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[13px] font-medium shadow-card hover:bg-surface-2"
          >
            <Smartphone className="size-3.5" /> Añadir en este dispositivo
          </a>
          <Field label="¿No puedes escanearlo? Escribe esta clave (tipo: basada en tiempo)">
            <Copyable value={groupSecret(setup.secret)} />
          </Field>
        </div>
      </div>
      <Field label="2. Escribe el código de 6 dígitos que muestra la app">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className="h-11 text-center font-mono text-xl tracking-[0.35em]"
        />
      </Field>
      {enable.error && <ErrorBox error={enable.error} />}
      <div className="flex justify-end">
        <Button variant="primary" type="submit" disabled={code.length !== 6} loading={enable.isPending}>
          Verificar y activar
        </Button>
      </div>
    </form>
  );
}
