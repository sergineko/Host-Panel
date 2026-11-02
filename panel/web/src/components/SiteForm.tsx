import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, FileCode, Hexagon, Plus, Server, Trash2 } from 'lucide-react';
import { api, type ServerNode, type Site, type SiteType } from '../lib/api';
import { Badge, Button, Card, Field, Input, Select, Toggle, cx } from './ui';

export interface SiteFormValue {
  name: string;
  hostnames: string[];
  type: SiteType;
  spa: boolean;
  repo_url: string;
  branch: string;
  repo_token?: string;
  install_command: string;
  build_command: string;
  output_dir: string;
  start_command: string;
  env: Record<string, string>;
  memory_mb: number;
  auto_deploy: boolean;
  php_version: string;
  server_ids: number[];
  lb_policy: string;
}

export function siteToForm(s: Site): SiteFormValue {
  return {
    name: s.name,
    hostnames: s.hostnames,
    type: s.type,
    spa: s.spa,
    repo_url: s.repo_url,
    branch: s.branch,
    install_command: s.install_command,
    build_command: s.build_command,
    output_dir: s.output_dir,
    start_command: s.start_command,
    env: s.env,
    memory_mb: s.memory_mb,
    auto_deploy: s.auto_deploy,
    php_version: s.php_version,
    server_ids: s.server_ids,
    lb_policy: s.lb_policy,
  };
}

const lbPolicies = [
  { id: 'round_robin', label: 'Por turnos', desc: 'Reparte las peticiones por igual.' },
  { id: 'least_conn', label: 'Menos conexiones', desc: 'Envía al servidor menos ocupado.' },
  { id: 'ip_hash', label: 'Por IP del visitante', desc: 'Cada visitante va siempre al mismo servidor (sesiones).' },
  { id: 'first', label: 'Principal y respaldo', desc: 'Todo al primero; los demás solo si cae.' },
];

/** Where the site runs: this server and/or remote VPS, plus PHP version and balancing. */
function Placement({ value, set }: { value: SiteFormValue; set: <K extends keyof SiteFormValue>(k: K, v: SiteFormValue[K]) => void }) {
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.get<{ local: ServerNode; servers: ServerNode[] }>('/api/servers') });
  const php = useQuery({ queryKey: ['php'], queryFn: () => api.get<{ default: string; versions: { version: string; installed: boolean }[] }>('/api/php'), enabled: value.type === 'php' });
  const all = servers.data ? [servers.data.local, ...servers.data.servers] : [];
  const toggle = (id: number) => {
    const has = value.server_ids.includes(id);
    const next = has ? value.server_ids.filter((x) => x !== id) : [...value.server_ids, id];
    if (next.length) set('server_ids', next);
  };
  return (
    <Card title="Servidores y rendimiento">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Dónde se ejecuta</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {all.map((s) => {
              const checked = value.server_ids.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  className={cx('flex items-center gap-3 rounded-md border p-3 text-left transition-colors', checked ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
                >
                  <span className={cx('grid size-4 shrink-0 place-items-center rounded border', checked ? 'border-accent bg-accent text-accent-fg' : 'border-border')}>
                    {checked && <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2.5 6.5l2.5 2.5 4.5-5" /></svg>}
                  </span>
                  <Server className={cx('size-4 shrink-0', checked ? 'text-accent' : 'text-muted')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.name}</span>
                    <span className="block truncate font-mono text-xs text-muted">{s.host}</span>
                  </span>
                  {s.status !== 'online' && <Badge tone="danger">Sin conexión</Badge>}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {servers.data && !servers.data.servers.length
              ? 'Añade VPS en Servidores para desplegar fuera de este servidor o repartir la carga.'
              : 'El código se compila aquí y se copia a cada servidor elegido. SSL, WAF y analítica siguen en este servidor.'}
          </p>
        </div>
        {value.server_ids.length > 1 && (
          <Field label="Balanceo de carga" hint="Los servidores que no responden se retiran automáticamente y vuelven al recuperarse.">
            <Select value={value.lb_policy} onChange={(e) => set('lb_policy', e.target.value)}>
              {lbPolicies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.desc}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {value.type === 'php' && (
          <Field label="Versión de PHP" hint="Instala más versiones en Sistema → PHP. En los VPS se instala sola si falta.">
            <Select value={value.php_version} onChange={(e) => set('php_version', e.target.value)}>
              <option value="">Por defecto del servidor{php.data ? ` (PHP ${php.data.default})` : ''}</option>
              {php.data?.versions
                .filter((v) => v.installed)
                .map((v) => (
                  <option key={v.version} value={v.version}>
                    PHP {v.version}
                  </option>
                ))}
            </Select>
          </Field>
        )}
      </div>
    </Card>
  );
}

const typeOptions: { id: SiteType; label: string; desc: string; icon: ReactNode }[] = [
  { id: 'static', label: 'Estático', desc: 'HTML, React, Vue, Astro…', icon: <FileCode className="size-5" /> },
  { id: 'php', label: 'PHP', desc: 'WordPress, Laravel…', icon: <Code2 className="size-5" /> },
  { id: 'node', label: 'Node.js', desc: 'Next.js, Express, Nuxt…', icon: <Hexagon className="size-5" /> },
];

const presets: { label: string; type: SiteType; values: Partial<SiteFormValue> }[] = [
  { label: 'Vite / React', type: 'static', values: { build_command: 'npm run build', output_dir: 'dist', spa: true } },
  { label: 'Astro', type: 'static', values: { build_command: 'npm run build', output_dir: 'dist', spa: false } },
  { label: 'HTML plano', type: 'static', values: { build_command: '', output_dir: '', spa: false } },
  { label: 'Laravel', type: 'php', values: { build_command: '', output_dir: 'public' } },
  { label: 'WordPress', type: 'php', values: { build_command: '', output_dir: '' } },
  { label: 'Next.js', type: 'node', values: { build_command: 'npm run build', start_command: 'npm start' } },
  { label: 'Express', type: 'node', values: { build_command: '', start_command: 'node index.js' } },
];

function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [rows, setRows] = useState(() => Object.entries(value).map(([k, v]) => ({ k, v })));
  const commit = (next: { k: string; v: string }[]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.k).map((r) => [r.k, r.v])));
  };
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input className="w-2/5 font-mono text-[13px]" placeholder="NOMBRE" value={r.k} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
          <Input className="flex-1 font-mono text-[13px]" placeholder="valor" value={r.v} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <Button type="button" variant="ghost" aria-label="Quitar variable" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows([...rows, { k: '', v: '' }])}>
        Añadir variable
      </Button>
    </div>
  );
}

export function SiteForm({ value, onChange, editing, hasToken }: { value: SiteFormValue; onChange: (v: SiteFormValue) => void; editing?: boolean; hasToken?: boolean }) {
  const set = <K extends keyof SiteFormValue>(k: K, v: SiteFormValue[K]) => onChange({ ...value, [k]: v });
  const [hostDraft, setHostDraft] = useState('');
  const addHost = () => {
    const h = hostDraft.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (h && !value.hostnames.includes(h)) set('hostnames', [...value.hostnames, h]);
    setHostDraft('');
  };

  return (
    <div className="space-y-4">
      <Card title="General">
        <div className="space-y-4">
          <Field label="Nombre">
            <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="Mi web" />
          </Field>
          <Field label="Dominios del sitio" hint="El certificado SSL se emite automáticamente para cada uno.">
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-surface p-1.5 focus-within:border-accent">
              {value.hostnames.map((h) => (
                <span key={h} className="inline-flex items-center gap-1 rounded bg-surface-2 py-1 pr-1 pl-2 text-[13px]">
                  {h}
                  <button type="button" className="rounded p-0.5 text-muted hover:text-danger" aria-label={`Quitar ${h}`} onClick={() => set('hostnames', value.hostnames.filter((x) => x !== h))}>
                    <Trash2 className="size-3" />
                  </button>
                </span>
              ))}
              <input
                className="min-w-40 flex-1 bg-transparent px-1.5 outline-none"
                value={hostDraft}
                placeholder={value.hostnames.length ? 'Añadir otro…' : 'midominio.com'}
                onChange={(e) => setHostDraft(e.target.value)}
                onBlur={addHost}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                    e.preventDefault();
                    addHost();
                  }
                }}
              />
            </div>
          </Field>
          {!editing && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Tipo</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {typeOptions.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => set('type', t.id)}
                    className={cx('flex items-center gap-3 rounded-md border p-3 text-left transition-colors', value.type === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
                  >
                    <span className={value.type === t.id ? 'text-accent' : 'text-muted'}>{t.icon}</span>
                    <span>
                      <span className="block font-medium">{t.label}</span>
                      <span className="block text-[12.5px] text-muted">{t.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Plantillas:</span>
                {presets
                  .filter((p) => p.type === value.type)
                  .map((p) => (
                    <button key={p.label} type="button" className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-accent hover:text-accent" onClick={() => onChange({ ...value, ...p.values })}>
                      {p.label}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Repositorio Git">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="URL del repositorio" className="sm:col-span-2" hint="Déjalo vacío para subir los archivos manualmente.">
            <Input value={value.repo_url} onChange={(e) => set('repo_url', e.target.value.trim())} placeholder="https://github.com/usuario/repo.git" />
          </Field>
          <Field label="Rama">
            <Input value={value.branch} onChange={(e) => set('branch', e.target.value.trim())} placeholder="main" />
          </Field>
          <Field
            label="Token de acceso (repos privados)"
            className="sm:col-span-3"
            hint={hasToken ? 'Hay un token guardado. Escribe uno nuevo para reemplazarlo.' : 'GitHub → Settings → Developer settings → Fine-grained token con permiso "Contents: read".'}
          >
            <Input type="password" autoComplete="off" value={value.repo_token ?? ''} onChange={(e) => set('repo_token', e.target.value || undefined)} placeholder={hasToken ? '••••••••' : 'github_pat_…'} />
          </Field>
        </div>
        <div className="mt-2 border-t border-border">
          <Toggle checked={value.auto_deploy} onChange={(v) => set('auto_deploy', v)} label="Despliegue automático" description="Despliega en cada push a la rama mediante el webhook de GitHub." />
        </div>
      </Card>

      <Card title="Compilación y ejecución">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Comando de instalación" hint="Vacío = automático (npm ci / composer install)">
            <Input className="font-mono text-[13px]" value={value.install_command} onChange={(e) => set('install_command', e.target.value)} placeholder="automático" />
          </Field>
          <Field label="Comando de build">
            <Input className="font-mono text-[13px]" value={value.build_command} onChange={(e) => set('build_command', e.target.value)} placeholder="npm run build" />
          </Field>
          {value.type !== 'node' && (
            <Field label={value.type === 'php' ? 'Directorio público' : 'Directorio de salida'} hint={value.type === 'php' ? 'public para Laravel, vacío para WordPress' : 'dist, build, out…'}>
              <Input className="font-mono text-[13px]" value={value.output_dir} onChange={(e) => set('output_dir', e.target.value.trim())} placeholder={value.type === 'php' ? 'public' : 'dist'} />
            </Field>
          )}
          {value.type === 'node' && (
            <>
              <Field label="Comando de arranque" hint="La app debe escuchar en process.env.PORT">
                <Input className="font-mono text-[13px]" value={value.start_command} onChange={(e) => set('start_command', e.target.value)} placeholder="npm start" />
              </Field>
              <Field label="Límite de memoria (MB)">
                <Input type="number" min={64} value={value.memory_mb} onChange={(e) => set('memory_mb', Number(e.target.value))} />
              </Field>
            </>
          )}
        </div>
        {value.type === 'static' && (
          <div className="mt-2 border-t border-border">
            <Toggle checked={value.spa} onChange={(v) => set('spa', v)} label="Aplicación de una sola página (SPA)" description="Las rutas que no existen sirven index.html (React Router, Vue Router…)." />
          </div>
        )}
      </Card>

      <Placement value={value} set={set} />

      <Card title="Variables de entorno">
        <p className="mb-3 text-[13px] text-muted">Disponibles durante el build y en ejecución. Se guardan en un archivo que solo puede leer el usuario del sitio.</p>
        <EnvEditor value={value.env} onChange={(env) => set('env', env)} />
      </Card>
    </div>
  );
}
