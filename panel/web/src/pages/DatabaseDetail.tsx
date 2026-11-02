import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Download, Play, Table2, Upload } from 'lucide-react';
import { api, upload, type DatabaseInfo, type QueryResult } from '../lib/api';
import { bytes, compact } from '../lib/format';
import { CodeBlock, TokensPanel } from '../components/TokensPanel';
import { Badge, Button, Callout, Card, Copyable, Empty, ErrorBox, Field, PageHeader, Spinner, Tabs, Textarea, cx } from '../components/ui';

interface TableInfo {
  name: string;
  rows: number;
  size: number;
  engine: string;
}

function cell(v: unknown) {
  if (v === null || v === undefined) return <span className="text-muted italic">NULL</span>;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function ResultTable({ result }: { result: QueryResult }) {
  if (!result.columns.length) {
    return (
      <p className="px-4 py-3 text-[13px]">
        ✔ {result.affectedRows} fila{result.affectedRows === 1 ? '' : 's'} afectada{result.affectedRows === 1 ? '' : 's'}
        {result.insertId ? ` · id insertado ${result.insertId}` : ''} <span className="text-muted">· {result.durationMs} ms</span>
      </p>
    );
  }
  return (
    <div>
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full text-left font-mono text-[12.5px]">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {result.columns.map((c) => (
                <th key={c} className="border-b border-border px-3 py-2 font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.rows.map((r, i) => (
              <tr key={i} className="hover:bg-surface-2/50">
                {r.map((v, j) => (
                  <td key={j} className="max-w-xs truncate px-3 py-1.5 whitespace-nowrap">
                    {cell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        {result.rowCount} fila{result.rowCount === 1 ? '' : 's'} · {result.durationMs} ms{result.truncated ? ' · se muestran las primeras 1000' : ''}
      </p>
    </div>
  );
}

function Console({ db, tables }: { db: DatabaseInfo; tables: TableInfo[] }) {
  const [sql, setSql] = useState(() => (tables[0] ? `SELECT * FROM ${tables[0].name} LIMIT 50;` : 'SHOW TABLES;'));
  const [history, setHistory] = useState<string[]>([]);
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (text: string) => api.post<QueryResult>(`/api/databases/${db.id}/query`, { sql: text.trim().replace(/;\s*$/, '') }),
    onSuccess: (_r, text) => {
      setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 15));
      if (!/^\s*(select|show|describe|desc|explain)\b/i.test(text)) qc.invalidateQueries({ queryKey: ['db-tables', db.id] });
    },
  });
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <Textarea
          className="min-h-36 rounded-none border-0 border-b !ring-0"
          value={sql}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              run.mutate(sql);
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs text-muted">Una sentencia por ejecución · Ctrl + Enter · se ejecuta como el usuario {db.username}</span>
          <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} loading={run.isPending} onClick={() => run.mutate(sql)}>
            Ejecutar
          </Button>
        </div>
      </Card>
      {run.error && <ErrorBox error={run.error} />}
      {run.data && (
        <Card padded={false}>
          <ResultTable result={run.data} />
        </Card>
      )}
      {history.length > 0 && (
        <Card title="Historial" padded={false}>
          <ul className="divide-y divide-border">
            {history.map((h) => (
              <li key={h}>
                <button className="w-full truncate px-4 py-2 text-left font-mono text-xs text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setSql(h)}>
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Tables({ db, tables }: { db: DatabaseInfo; tables: TableInfo[] }) {
  const [table, setTable] = useState<string | null>(tables[0]?.name ?? null);
  const [page, setPage] = useState(0);
  const rows = useQuery({
    queryKey: ['db-rows', db.id, table, page],
    queryFn: () => api.get<QueryResult>(`/api/databases/${db.id}/tables/${table}?page=${page}`),
    enabled: !!table,
  });
  if (!tables.length) return <Card><Empty icon={<Table2 className="size-6" />} title="Sin tablas" description="Crea tablas desde la consola SQL, importa un .sql o deja que tu aplicación las cree." /></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card padded={false} className="h-fit">
        <ul className="max-h-[520px] overflow-y-auto p-1.5">
          {tables.map((t) => (
            <li key={t.name}>
              <button
                className={cx('flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left', table === t.name ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}
                onClick={() => {
                  setTable(t.name);
                  setPage(0);
                }}
              >
                <span className="truncate font-mono text-[13px]">{t.name}</span>
                <span className="tabular text-xs text-muted">{compact(t.rows)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        padded={false}
        title={<span className="font-mono">{table}</span>}
        actions={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular text-xs text-muted">Página {page + 1}</span>
            <Button size="sm" variant="ghost" disabled={(rows.data?.rowCount ?? 0) < 50} onClick={() => setPage(page + 1)} aria-label="Página siguiente">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        }
      >
        {rows.isLoading ? <Spinner /> : rows.error ? <div className="p-4"><ErrorBox error={rows.error} /></div> : rows.data && <ResultTable result={rows.data} />}
      </Card>
    </div>
  );
}

function ApiTab({ db }: { db: DatabaseInfo }) {
  return (
    <TokensPanel basePath={`/api/databases/${db.id}`}>
      <Card title="API HTTP" description="Consultas SQL por HTTP con un token.">
        <p className="mb-3 text-[13px] text-muted">
          Consulta la base de datos con <code className="font-mono">fetch</code> desde cualquier sitio: funciones serverless, apps móviles o sitios en otros servidores. Usa parámetros <code className="font-mono">?</code> para evitar inyecciones SQL. Varias sentencias en un array se ejecutan en una transacción.
        </p>
        <Field label="Endpoint">
          <Copyable value={db.api_url ?? ''} />
        </Field>
        <div className="mt-4 space-y-3">
          <CodeBlock>{`const res = await fetch('${db.api_url}', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${TOKEN}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: 'SELECT * FROM productos WHERE precio < ?', params: [20] }),
});
const { result } = await res.json();
console.log(result[0].results); // [{ id: 1, nombre: 'Camiseta', precio: 19.9 }]`}</CodeBlock>
          <CodeBlock>{`# Transacción (todo o nada)
curl -X POST ${db.api_url} -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '[
  { "sql": "UPDATE cuentas SET saldo = saldo - ? WHERE id = ?", "params": [50, 1] },
  { "sql": "UPDATE cuentas SET saldo = saldo + ? WHERE id = ?", "params": [50, 2] }
]'`}</CodeBlock>
        </div>
      </Card>
    </TokensPanel>
  );
}

function Connection({ db }: { db: DatabaseInfo }) {
  const qc = useQueryClient();
  const [hosts, setHosts] = useState(db.remote_hosts.join('\n'));
  const [importing, setImporting] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const saveRemote = useMutation({
    mutationFn: () => api.put(`/api/databases/${db.id}/remote`, { hosts: hosts.split(/[\s,]+/).filter(Boolean) }),
    onSuccess: () => {
      toast.success('Acceso remoto actualizado');
      qc.invalidateQueries({ queryKey: ['database', db.id] });
    },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Conexión desde este servidor">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[13px]">
          <dt className="text-muted">Servidor</dt>
          <dd><Copyable value="localhost" /></dd>
          <dt className="text-muted">Puerto</dt>
          <dd><Copyable value="3306" /></dd>
          <dt className="text-muted">Base de datos</dt>
          <dd><Copyable value={db.name} /></dd>
          <dt className="text-muted">Usuario</dt>
          <dd><Copyable value={db.username} /></dd>
        </dl>
        <p className="mt-3 text-xs text-muted">La contraseña solo se muestra al crearla o regenerarla (botón de la llave en la lista).</p>
      </Card>

      <Card title="Acceso remoto (otros VPS)">
        {saveRemote.error && <ErrorBox error={saveRemote.error} />}
        <Field label="IPs permitidas" hint={`Una por línea. Desde ellas conectarán a ${db.host ?? 'la IP del servidor'}:3306; el cortafuegos bloquea al resto.`}>
          <Textarea className="min-h-24" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="198.51.100.20" />
        </Field>
        {!db.has_password && <p className="mt-2 text-xs text-warn">Regenera la contraseña antes de activar el acceso remoto.</p>}
        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" loading={saveRemote.isPending} onClick={() => saveRemote.mutate()}>
            Guardar
          </Button>
        </div>
      </Card>

      <Card title="Exportar e importar" className="lg:col-span-2">
        <div className="flex flex-wrap items-center gap-3">
          <a href={`/api/databases/${db.id}/export`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3.5 font-medium hover:bg-surface-2">
            <Download className="size-4" /> Descargar copia (.sql)
          </a>
          <Button icon={<Upload className="size-4" />} loading={importing !== null} onClick={() => file.current?.click()}>
            {importing !== null ? `Importando ${Math.round(importing * 100)} %` : 'Importar .sql'}
          </Button>
          <input
            ref={file}
            type="file"
            accept=".sql,application/sql,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setImporting(0);
              try {
                await upload(`/api/databases/${db.id}/import`, f, setImporting, 'POST');
                toast.success(`${f.name} importado`);
                qc.invalidateQueries({ queryKey: ['db-tables', db.id] });
              } catch (err) {
                toast.error((err as Error).message);
              } finally {
                setImporting(null);
              }
            }}
          />
          <span className="text-xs text-muted">La copia es consistente (sin bloquear la web). La importación se ejecuta con el usuario de la base de datos.</span>
        </div>
      </Card>
    </div>
  );
}

export default function DatabaseDetail() {
  const { id } = useParams();
  const dbId = Number(id);
  const [tab, setTab] = useState<'console' | 'tables' | 'api' | 'connection'>('tables');
  const q = useQuery({ queryKey: ['database', dbId], queryFn: () => api.get<DatabaseInfo>(`/api/databases/${dbId}`) });
  const tables = useQuery({ queryKey: ['db-tables', dbId], queryFn: () => api.get<TableInfo[]>(`/api/databases/${dbId}/tables`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const db = q.data!;
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{db.name}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            MariaDB · usuario <span className="font-mono">{db.username}</span> · {tables.data?.length ?? 0} tablas · {bytes(tables.data?.reduce((a, t) => a + t.size, 0) ?? 0)}
            {db.remote_hosts.length > 0 && <Badge tone="info">Acceso remoto</Badge>}
          </span>
        }
      />
      {!db.has_password && (
        <Callout tone="warn" className="mb-4" title="Falta la contraseña">
          Esta base de datos se creó antes de la consola: regenera su contraseña (llave en la lista) para usar la consola, la API y el acceso remoto.
        </Callout>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tables', label: 'Tablas' },
          { id: 'console', label: 'Consola SQL' },
          { id: 'api', label: 'API HTTP' },
          { id: 'connection', label: 'Conexión y copias' },
        ]}
      />
      {tables.isLoading ? <Spinner /> : tab === 'tables' && <Tables db={db} tables={tables.data ?? []} />}
      {tab === 'console' && <Console db={db} tables={tables.data ?? []} />}
      {tab === 'api' && <ApiTab db={db} />}
      {tab === 'connection' && <Connection db={db} />}
    </>
  );
}
