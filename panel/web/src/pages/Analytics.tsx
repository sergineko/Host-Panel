import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Domain, type TrafficPoint } from '../lib/api';
import { bytes, compact } from '../lib/format';
import { Badge, Card, ErrorBox, PageHeader, Select, Spinner, Table, Td, cx } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';

interface Live {
  ts: number;
  host: string;
  method: string;
  uri: string;
  status: number;
  size: number;
  duration: number;
  ip: string;
  ua: string;
}

const statusTone = (s: number) => (s === 403 || s === 429 ? 'danger' : s >= 500 ? 'danger' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');

export default function Analytics() {
  const [hours, setHours] = useState(24);
  const [host, setHost] = useState('');
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains') });
  const q = useQuery({
    queryKey: ['analytics', hours, host],
    queryFn: () => api.get<{ series: TrafficPoint[]; topHosts: { host: string; requests: number; bytes: number; blocked: number }[] }>(`/api/analytics?hours=${hours}&host=${encodeURIComponent(host)}`),
    refetchInterval: 30000,
  });
  const live = useQuery({ queryKey: ['live', host], queryFn: () => api.get<Live[]>(`/api/analytics/live?host=${encodeURIComponent(host)}`), refetchInterval: 4000 });

  const totals = q.data?.series.reduce(
    (a, s) => ({ requests: a.requests + s.requests, bytes: a.bytes + s.bytes, blocked: a.blocked + s.blocked, errors: a.errors + s.s5xx }),
    { requests: 0, bytes: 0, blocked: 0, errors: 0 },
  );

  return (
    <>
      <PageHeader
        title="Analítica"
        description="Tráfico servido por el proxy, en tiempo real."
        actions={
          <>
            <Select className="w-48" value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">Todos los dominios</option>
              {domains.data?.map((d) => (
                <option key={d.id}>{d.name}</option>
              ))}
            </Select>
            <Select className="w-36" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={24}>24 horas</option>
              <option value={72}>3 días</option>
              <option value={168}>7 días</option>
              <option value={720}>30 días</option>
            </Select>
          </>
        }
      />
      {q.error && <ErrorBox error={q.error} />}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Peticiones', compact(totals?.requests ?? 0)],
          ['Datos servidos', bytes(totals?.bytes ?? 0)],
          ['Amenazas bloqueadas', compact(totals?.blocked ?? 0)],
          ['Errores 5xx', compact(totals?.errors ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-4">
            <div className="text-[13px] text-muted">{label}</div>
            <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Peticiones por hora" className="lg:col-span-2">
          {q.isLoading ? <Spinner /> : <TrafficChart series={q.data!.series} height={200} />}
        </Card>
        <Card title="Hosts con más tráfico" padded={false}>
          <ul className="divide-y divide-border">
            {q.data?.topHosts.map((h) => (
              <li key={h.host} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
                <span className="truncate">{h.host}</span>
                <span className="tabular text-muted">{compact(h.requests)}</span>
              </li>
            ))}
            {!q.data?.topHosts.length && <li className="px-4 py-6 text-center text-[13px] text-muted">Sin datos todavía.</li>}
          </ul>
        </Card>
        <Card title={<span className="flex items-center gap-2">Peticiones en vivo <span className="size-1.5 animate-pulse rounded-full bg-ok" /></span>} padded={false} className="lg:col-span-3">
          <div className="max-h-[420px] overflow-y-auto">
            <Table head={['Hora', 'Estado', 'Host', 'Petición', 'IP', 'Tamaño']}>
              {live.data?.map((r, i) => (
                <tr key={`${r.ts}-${i}`} className={cx(r.status === 403 && 'bg-danger-soft/40')}>
                  <Td className="tabular text-xs whitespace-nowrap text-muted">{new Date(r.ts * 1000).toLocaleTimeString()}</Td>
                  <Td><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
                  <Td className="text-[13px]">{r.host}</Td>
                  <Td className="max-w-xs">
                    <code className="block truncate font-mono text-xs" title={`${r.uri}\n${r.ua}`}>
                      <span className="text-muted">{r.method}</span> {r.uri}
                    </code>
                  </Td>
                  <Td className="font-mono text-xs text-muted">{r.ip}</Td>
                  <Td className="tabular text-xs text-muted">{bytes(r.size)}</Td>
                </tr>
              ))}
            </Table>
            {!live.data?.length && <p className="px-4 py-8 text-center text-[13px] text-muted">Esperando tráfico…</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
