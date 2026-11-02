import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { api, type IpRule, type Security } from '../lib/api';
import { Badge, Button, Card, ErrorBox, Field, Input, Select, Spinner, StickyActions, Table, Td, Toggle, cx } from './ui';

const FLAGS = ['block_bots', 'under_attack', 'security_headers', 'hsts', 'compression', 'block_sensitive', 'hotlink', 'cache_static'] as const;
type Flag = (typeof FLAGS)[number];
type Form = Omit<Security, 'ip_rules' | Flag> & Record<Flag, boolean>;

function toForm(s: Security): Form {
  const { ip_rules: _rules, ...rest } = s;
  const form = { ...rest } as unknown as Form;
  for (const f of FLAGS) form[f] = !!s[f];
  return form;
}

const cacheOptions = [
  { value: 3600, label: '1 hora' },
  { value: 86400, label: '1 día' },
  { value: 604800, label: '1 semana' },
  { value: 2592000, label: '1 mes' },
  { value: 31536000, label: '1 año (archivos con hash)' },
];

const wafModes = [
  { id: 'off', label: 'Desactivado', desc: 'Sin inspección de peticiones.' },
  { id: 'detect', label: 'Solo detectar', desc: 'Registra ataques sin bloquear. Útil para probar.' },
  { id: 'block', label: 'Bloquear', desc: 'Bloquea inyecciones SQL, XSS, RCE, LFI… (OWASP CRS).' },
] as const;

export function IpRulesTable({ rules, domainId, queryKey }: { rules: IpRule[]; domainId: number | null; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [cidr, setCidr] = useState('');
  const [action, setAction] = useState<'block' | 'allow'>('block');
  const [note, setNote] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/api/ip-rules', { domain_id: domainId, cidr, action, note }),
    onSuccess: () => {
      toast.success('Regla añadida');
      setCidr('');
      setNote('');
      qc.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/ip-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2 border-b border-border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="IP o rango CIDR" className="min-w-44 flex-1">
          <Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="203.0.113.0/24" />
        </Field>
        <Field label="Acción" className="w-36">
          <Select value={action} onChange={(e) => setAction(e.target.value as 'block' | 'allow')}>
            <option value="block">Bloquear</option>
            <option value="allow">Permitir siempre</option>
          </Select>
        </Field>
        <Field label="Nota" className="min-w-40 flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
        </Field>
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!cidr} icon={<Plus className="size-4" />}>
          Añadir
        </Button>
      </form>
      {add.error && (
        <div className="px-4 pt-3">
          <ErrorBox error={add.error} />
        </div>
      )}
      {rules.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">Sin reglas de IP.</p>
      ) : (
        <Table head={['IP / rango', 'Acción', 'Nota', '']}>
          {rules.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-[13px]">{r.cidr}</Td>
              <Td>{r.action === 'block' ? <Badge tone="danger">Bloquear</Badge> : <Badge tone="ok">Permitir</Badge>}</Td>
              <Td className="text-muted">{r.note}</Td>
              <Td className="w-10">
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)} aria-label="Eliminar regla">
                  <Trash2 className="size-3.5" />
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export function SecurityPanel({ domainId }: { domainId: number }) {
  const qc = useQueryClient();
  const key = ['security', domainId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Security>(`/api/domains/${domainId}/security`) });
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (q.data) setForm(toForm(q.data));
  }, [q.data]);

  const save = useMutation({
    mutationFn: (f: Form) => api.put(`/api/domains/${domainId}/security`, f),
    onSuccess: () => {
      toast.success('Seguridad actualizada y aplicada');
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading || !form) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const original = q.data ? toForm(q.data) : null;
  const dirty = !!original && (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== original[k]);

  return (
    <div className="space-y-4">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4 transition-colors',
          form.under_attack ? 'border-danger/40 bg-danger-soft' : 'border-border bg-surface',
        )}
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className={cx('mt-0.5 size-5', form.under_attack ? 'text-danger' : 'text-muted')} />
          <div>
            <div className="font-semibold">Modo "bajo ataque"</div>
            <p className="text-[13px] text-muted">Muestra un reto de JavaScript antes de entrar. Frena bots y ataques DDoS de capa 7.</p>
          </div>
        </div>
        <Button
          variant={form.under_attack ? 'danger' : 'secondary'}
          loading={save.isPending}
          onClick={() => {
            const next = { ...form, under_attack: !form.under_attack };
            setForm(next);
            save.mutate(next);
          }}
        >
          {form.under_attack ? 'Desactivar' : 'Activar'}
        </Button>
      </div>

      <Card title="Firewall de aplicaciones web (WAF)">
        <div className="grid gap-2 sm:grid-cols-3">
          {wafModes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => set('waf_mode', m.id)}
              className={cx(
                'rounded-md border p-3 text-left transition-colors',
                form.waf_mode === m.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2',
              )}
            >
              <div className="font-medium">{m.label}</div>
              <div className="mt-0.5 text-[12.5px] text-muted">{m.desc}</div>
            </button>
          ))}
        </div>
        {form.waf_mode !== 'off' && (
          <Field
            label={`Nivel de paranoia: ${form.paranoia}`}
            className="mt-4"
            hint="1 = recomendado (casi sin falsos positivos). 4 = máxima protección, puede bloquear tráfico legítimo."
          >
            <input type="range" min={1} max={4} value={form.paranoia} onChange={(e) => set('paranoia', Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </Field>
        )}
      </Card>

      <Card title="Protección">
        <div className="divide-y divide-border">
          <div className="flex flex-wrap items-center justify-between gap-4 py-3">
            <div>
              <div className="font-medium">Límite de peticiones</div>
              <div className="text-[13px] text-muted">Peticiones por minuto y por IP antes de responder 429. 0 = sin límite.</div>
            </div>
            <Input type="number" min={0} className="!w-32" value={form.rate_limit_rpm} onChange={(e) => set('rate_limit_rpm', Number(e.target.value))} />
          </div>
          <Toggle checked={form.block_bots} onChange={(v) => set('block_bots', v)} label="Bloquear bots maliciosos" description="Escáneres de vulnerabilidades (sqlmap, nikto, wpscan…) y crawlers agresivos." />
          <Toggle checked={form.block_sensitive} onChange={(v) => set('block_sensitive', v)} label="Proteger archivos sensibles" description="Bloquea .git, .env, copias de seguridad (.sql, .bak), composer.json y similares aunque estén publicados por error." />
          <Toggle checked={form.hotlink} onChange={(v) => set('hotlink', v)} label="Protección contra hotlinking" description="Impide que otras webs incrusten tus imágenes y consuman tu ancho de banda." />
          <div className="flex flex-wrap items-center justify-between gap-4 py-3">
            <div>
              <div className="font-medium">Tamaño máximo de subida</div>
              <div className="text-[13px] text-muted">Rechaza peticiones con cuerpos mayores (MB). 0 = sin límite propio.</div>
            </div>
            <Input type="number" min={0} className="!w-32" value={form.max_body_mb} onChange={(e) => set('max_body_mb', Number(e.target.value))} />
          </div>
          <Toggle checked={form.security_headers} onChange={(v) => set('security_headers', v)} label="Cabeceras de seguridad" description="X-Frame-Options, X-Content-Type-Options, Referrer-Policy. Oculta la cabecera Server." />
          <Toggle checked={form.hsts} onChange={(v) => set('hsts', v)} label="HSTS" description="Obliga a los navegadores a usar siempre HTTPS durante un año (incluye subdominios)." />
        </div>
      </Card>

      <Card title="Rendimiento">
        <div className="divide-y divide-border">
          <Toggle checked={form.compression} onChange={(v) => set('compression', v)} label="Compresión zstd / gzip" description="Reduce el tamaño de HTML, CSS, JS y JSON entre un 60 y un 80 %." />
          <Toggle checked={form.cache_static} onChange={(v) => set('cache_static', v)} label="Caché de archivos estáticos" description="Indica al navegador que guarde imágenes, CSS, JS y fuentes. Solo si tu app no define su propia caché." />
          {form.cache_static && (
            <div className="flex flex-wrap items-center justify-between gap-4 py-3">
              <div className="font-medium">Duración de la caché</div>
              <Select className="!w-56" value={form.cache_ttl} onChange={(e) => set('cache_ttl', Number(e.target.value))}>
                {cacheOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="py-3 text-[13px] text-muted">HTTP/3 (QUIC), TLS 1.3 y OCSP stapling están activos siempre en todos los dominios.</div>
        </div>
      </Card>

      <StickyActions>
        {dirty && <span className="mr-auto self-center text-[13px] text-muted">Cambios sin guardar</span>}
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
          Guardar y aplicar
        </Button>
      </StickyActions>

      <Card title="Reglas de IP de este dominio" padded={false}>
        <IpRulesTable rules={q.data!.ip_rules} domainId={domainId} queryKey={key} />
      </Card>
    </div>
  );
}
