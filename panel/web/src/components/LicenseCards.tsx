import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, ImageUp, Lock, Palette } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/me';
import { DEFAULT_NAME } from '../lib/branding';
import { Badge, Button, Callout, Card, ErrorBox, Field, Input, Spinner, Textarea, cx } from './ui';

export interface Plan {
  id: 'personal' | 'profesional' | 'empresa' | 'reseller';
  name: string;
  max: number | null;
  included: number;
  branding: boolean;
}
export interface LicenseInfo {
  plan: Plan;
  license: { id: string; email: string; issued_at: string; expires_at: string | null } | null;
  used: number;
  max: number | null;
  included: number;
  extra: number;
  over_limit: boolean;
  plans: Plan[];
}

export const useLicense = () => useQuery({ queryKey: ['license'], queryFn: () => api.get<LicenseInfo>('/api/license') });

/** "3 de 5 accesos" with a bar, or "62 accesos (50 incluidos + 12 extra)". */
export function AccessUsage({ info, compact }: { info: LicenseInfo; compact?: boolean }) {
  const limited = info.max !== null;
  const pct = limited ? Math.min(100, (info.used / info.max!) * 100) : Math.min(100, (info.used / info.included) * 100);
  const full = limited && info.used >= info.max!;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <span>
          <strong className="text-base tabular-nums">{info.used}</strong>
          {limited ? ` de ${info.max} ${info.max === 1 ? 'acceso' : 'accesos'} en uso` : ` accesos en uso (${info.included} incluidos${info.extra ? ` + ${info.extra} extra` : ''})`}
        </span>
        {!compact && <span className="text-xs text-muted">Cuenta cada usuario que puede entrar: titular, equipo y clientes.</span>}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cx('h-full rounded-full transition-[width]', info.over_limit ? 'bg-danger' : full ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function LicenseCard() {
  const qc = useQueryClient();
  const me = useMe();
  const q = useLicense();
  const [token, setToken] = useState('');
  const install = useMutation({
    mutationFn: () => api.put<LicenseInfo>('/api/license', { token }),
    onSuccess: () => {
      toast.success('Licencia instalada');
      setToken('');
      qc.invalidateQueries({ queryKey: ['license'] });
      qc.invalidateQueries({ queryKey: ['branding'] });
      qc.invalidateQueries({ queryKey: ['branding-public'] });
    },
  });
  if (q.isLoading) return <Card title="Licencia"><Spinner /></Card>;
  if (q.error) return <Card title="Licencia"><ErrorBox error={q.error} /></Card>;
  const info = q.data!;

  return (
    <Card title="Licencia" icon={<BadgeCheck />} actions={<Badge tone={info.license ? 'ok' : 'warn'} dot>Plan {info.plan.name}</Badge>}>
      <div className="space-y-4">
        <AccessUsage info={info} />
        {info.over_limit && (
          <Callout tone="warn" title="Hay más accesos de los que incluye tu plan">
            Los que ya existen siguen funcionando, pero no podrás crear ni reactivar más hasta bajar de {info.max} o cambiar de plan.
          </Callout>
        )}
        {info.license ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">Licencia</dt>
            <dd className="font-mono">{info.license.id}</dd>
            <dt className="text-muted">Titular</dt>
            <dd>{info.license.email}</dd>
            {info.license.expires_at && (
              <>
                <dt className="text-muted">Pagada hasta</dt>
                <dd>{new Date(info.license.expires_at).toLocaleDateString('es-ES', { dateStyle: 'long', timeZone: 'UTC' })}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-[13px] text-muted">Sin licencia el panel funciona con el plan Personal (1 acceso).</p>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Plan</th>
                <th className="px-3 py-1.5 text-left font-medium">Accesos</th>
                <th className="px-3 py-1.5 text-left font-medium">Marca propia</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {info.plans.map((p) => (
                <tr key={p.id} className={p.id === info.plan.id ? 'bg-accent-soft' : ''}>
                  <td className="px-3 py-1.5 font-medium">{p.name}</td>
                  <td className="px-3 py-1.5">{p.max === null ? `${p.included} incluidos + extra por cada uno` : p.max === 1 ? '1' : `Hasta ${p.max}`}</td>
                  <td className="px-3 py-1.5">{p.branding ? 'Sí' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {me.data?.role === 'owner' && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              install.mutate();
            }}
          >
            <Field label={info.license ? 'Cambiar de licencia' : 'Instalar licencia'} hint="Pega la licencia completa que recibiste al contratar.">
              <Textarea value={token} onChange={(e) => setToken(e.target.value.trim())} className="min-h-16 font-mono text-xs" spellCheck={false} />
            </Field>
            {install.error && <ErrorBox error={install.error} />}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={token.length < 20} loading={install.isPending}>
                Instalar
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

interface BrandingForm {
  name: string;
  logo: string | null;
  color: string | null;
}

export function BrandingCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['branding'], queryFn: () => api.get<BrandingForm & { allowed: boolean }>('/api/branding') });
  const [form, setForm] = useState<BrandingForm>({ name: DEFAULT_NAME, logo: null, color: null });
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (q.data) setForm({ name: q.data.name, logo: q.data.logo, color: q.data.color });
  }, [q.data]);
  const done = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ['branding'] });
    qc.invalidateQueries({ queryKey: ['branding-public'] });
  };
  const save = useMutation({ mutationFn: () => api.put('/api/branding', form), onSuccess: () => done('Marca guardada') });
  const reset = useMutation({ mutationFn: () => api.del('/api/branding'), onSuccess: () => done('Marca restablecida') });

  if (q.isLoading) return <Card title="Marca del panel"><Spinner /></Card>;
  if (q.error) return <Card title="Marca del panel"><ErrorBox error={q.error} /></Card>;
  const allowed = q.data!.allowed;

  return (
    <Card title="Marca del panel" icon={<Palette />} description="Tu nombre, logo y color en lugar de los de HostPanel, también en la pantalla de acceso de tus clientes.">
      {!allowed && (
        <Callout tone="info" title="Incluida en el plan Reseller" className="mb-4">
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3.5" /> Con tu plan actual el panel muestra la marca HostPanel.
          </span>
        </Callout>
      )}
      <fieldset disabled={!allowed} className="space-y-4 disabled:opacity-60">
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          {form.logo ? (
            <img src={form.logo} alt="" className="size-10 rounded-lg object-contain" />
          ) : (
            <div className="grid size-10 place-items-center rounded-lg text-lg font-bold text-white" style={{ background: form.color ?? 'var(--accent)' }}>
              {form.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{form.name || DEFAULT_NAME}</div>
            <div className="text-xs text-muted">Vista previa</div>
          </div>
        </div>
        <Field label="Nombre del panel">
          <Input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Panel de Mi Empresa" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Logo" hint="PNG, JPG, WEBP o SVG cuadrado, máximo 200 KB.">
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (file.size > 200 * 1024) {
                    setFileError('El archivo pesa más de 200 KB');
                    return;
                  }
                  setFileError('');
                  const reader = new FileReader();
                  reader.onload = () => setForm((f) => ({ ...f, logo: String(reader.result) }));
                  reader.readAsDataURL(file);
                }}
              />
              <Button type="button" size="sm" icon={<ImageUp className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                Subir logo
              </Button>
              {form.logo && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, logo: null })}>
                  Quitar
                </Button>
              )}
            </div>
            {fileError && <p className="mt-1 text-xs text-danger">{fileError}</p>}
          </Field>
          <Field label="Color principal">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="color"
                value={form.color ?? '#ea6a10'}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-1"
                aria-label="Color principal"
              />
              <span className="font-mono text-[13px]">{form.color ?? 'predeterminado'}</span>
              {form.color && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, color: null })}>
                  Predeterminado
                </Button>
              )}
            </div>
          </Field>
        </div>
        {(save.error || reset.error) && <ErrorBox error={save.error ?? reset.error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>
            Restablecer
          </Button>
          <Button type="button" variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={() => save.mutate()}>
            Guardar marca
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}
