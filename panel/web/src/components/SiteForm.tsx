import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, FileCode, Hexagon, Plus, Server, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, type NodeOverview, type ServerNode, type Site, type SiteType } from '../lib/api';
import { Badge, Button, Card, ChoiceCard, Field, Input, Select, Toggle, cx } from './ui';

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
  node_version: string;
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
    node_version: s.node_version || 'latest',
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
function Placement({ value, set, localOnly }: { value: SiteFormValue; set: <K extends keyof SiteFormValue>(k: K, v: SiteFormValue[K]) => void; localOnly?: boolean }) {
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.get<{ local: ServerNode; servers: ServerNode[] }>('/api/servers') });
  const php = useQuery({ queryKey: ['php'], queryFn: () => api.get<{ default: string; versions: { version: string; installed: boolean }[] }>('/api/php'), enabled: value.type === 'php' });
  const all = servers.data ? [servers.data.local, ...servers.data.servers] : [];
  const toggle = (id: number) => {
    const has = value.server_ids.includes(id);
    const next = has ? value.server_ids.filter((x) => x !== id) : [...value.server_ids, id];
    if (next.length) set('server_ids', next);
  };
  return (
    <Card title={localOnly ? 'PHP' : 'Servidores y rendimiento'}>
      <div className="space-y-4">
        {!localOnly && (
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
        )}
        {!localOnly && value.server_ids.length > 1 && (
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

/** Node.js version for builds and Node apps: latest installed, system, a major line or an exact version. */
function NodeVersionField({ value, onChange, needed }: { value: string; onChange: (v: string) => void; needed: 'run' | 'build' }) {
  const q = useQuery({ queryKey: ['nodejs'], queryFn: () => api.get<NodeOverview>('/api/nodejs') });
  const list = q.data?.installed ?? [];
  const majors = [...new Set(list.map((n) => n.version.split('.')[0]!))];
  const system = list.find((n) => n.system);
  const known = value === 'latest' || value === 'system' || majors.includes(value) || list.some((n) => n.version === value);
  const resolved =
    value === 'latest'
      ? list[0]?.version
      : value === 'system'
        ? (system ?? list[0])?.version
        : /^\d+$/.test(value)
          ? list.find((n) => n.version.split('.')[0] === value)?.version
          : list.find((n) => n.version === value)?.version;
  return (
    <Field
      label="Versión de Node.js"
      hint={
        <>
          {needed === 'run' ? 'Con ella se compila y se ejecuta la app.' : 'Con ella se ejecutan los comandos de instalación y build.'}{' '}
          {resolved ? (
            <>
              Ahora: <span className="font-mono text-fg">{resolved}</span>.
            </>
          ) : q.data ? (
            <span className="text-danger">Esa versión no está instalada.</span>
          ) : null}{' '}
          Gestiona las versiones en{' '}
          <Link to="/system?tab=node" className="text-accent hover:underline">
            Sistema → Node.js
          </Link>
          .
        </>
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="latest">Siempre la última instalada{list[0] ? ` (ahora ${list[0].version})` : ''}</option>
        {system && <option value="system">La del sistema ({system.version})</option>}
        {majors.length > 0 && (
          <optgroup label="Última de una versión mayor">
            {majors.map((m) => (
              <option key={m} value={m}>
                Node.js {m}.x (la más alta instalada)
              </option>
            ))}
          </optgroup>
        )}
        {list.length > 0 && (
          <optgroup label="Versión exacta">
            {list.map((n) => (
              <option key={n.version} value={n.version}>
                Node.js {n.version}
              </option>
            ))}
          </optgroup>
        )}
        {!known && <option value={value}>{value} (no instalada)</option>}
      </Select>
    </Field>
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
  { label: 'PHP genérico', type: 'php', values: { build_command: '', output_dir: '' } },
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
          <Input className="!w-2/5 font-mono text-[13px]" placeholder="NOMBRE" value={r.k} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
          <Input className="min-w-0 !flex-1 font-mono text-[13px]" placeholder="valor" value={r.v} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
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

/** Domain chips: type a domain and press Enter, comma or space. */
export function HostnamesInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const h = draft.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (h && !value.includes(h)) onChange([...value, h]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-surface p-1.5 focus-within:border-accent">
      {value.map((h) => (
        <span key={h} className="inline-flex items-center gap-1 rounded bg-surface-2 py-1 pr-1 pl-2 text-[13px]">
          {h}
          <button type="button" className="rounded p-0.5 text-muted hover:text-danger" aria-label={`Quitar ${h}`} onClick={() => onChange(value.filter((x) => x !== h))}>
            <Trash2 className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-40 flex-1 bg-transparent px-1.5 outline-none focus-visible:outline-none"
        value={draft}
        placeholder={value.length ? 'Añadir otro…' : 'midominio.com'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

export function SiteForm({
  value,
  onChange,
  editing,
  hasToken,
  wordpress,
}: {
  value: SiteFormValue;
  onChange: (v: SiteFormValue) => void;
  editing?: boolean;
  hasToken?: boolean;
  /** WordPress sites: no repository, build or extra servers. */
  wordpress?: boolean;
}) {
  const set = <K extends keyof SiteFormValue>(k: K, v: SiteFormValue[K]) => onChange({ ...value, [k]: v });

  return (
    <div className="space-y-4">
      <Card title="General">
        <div className="space-y-4">
          <Field label="Nombre">
            <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="Mi web" />
          </Field>
          <Field label="Dominios del sitio" hint="Cada dominio recibe su propio certificado de Let's Encrypt, que se renueva solo. Apunta su DNS a este servidor.">
            <HostnamesInput value={value.hostnames} onChange={(h) => set('hostnames', h)} />
          </Field>
          {!editing && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Tipo</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {typeOptions.map((t) => (
                  <ChoiceCard key={t.id} selected={value.type === t.id} onClick={() => set('type', t.id)} icon={t.icon} title={t.label} description={t.desc} />
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

      {!wordpress && (
      <>
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
        {(value.type === 'node' || /\b(npm|npx|yarn|pnpm|node|corepack)\b/.test(`${value.install_command} ${value.build_command}`) || (value.type === 'static' && !!value.build_command)) && (
          <div className="mt-4">
            <NodeVersionField value={value.node_version} onChange={(v) => set('node_version', v)} needed={value.type === 'node' ? 'run' : 'build'} />
          </div>
        )}
        {value.type === 'static' && (
          <div className="mt-2 border-t border-border">
            <Toggle checked={value.spa} onChange={(v) => set('spa', v)} label="Aplicación de una sola página (SPA)" description="Las rutas que no existen sirven index.html (React Router, Vue Router…)." />
          </div>
        )}
      </Card>

      </>
      )}

      <Placement value={value} set={set} localOnly={wordpress} />

      {!wordpress && (
        <Card title="Variables de entorno">
          <p className="mb-3 text-[13px] text-muted">Disponibles durante el build y en ejecución. Se guardan en un archivo que solo puede leer el usuario del sitio.</p>
          <EnvEditor value={value.env} onChange={(env) => set('env', env)} />
        </Card>
      )}
    </div>
  );
}
