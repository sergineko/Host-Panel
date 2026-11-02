import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Clock, Lock, LockOpen, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type CertInfo, type CertOverview, type CertState } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Callout, Card, Empty, ErrorBox, Spinner, cx } from './ui';

const fmt = (iso: string) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });

export const certStateStyle: Record<CertState, { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral'; icon: typeof Lock }> = {
  valid: { label: 'Válido', tone: 'ok', icon: Lock },
  renewing: { label: 'Renovando', tone: 'info', icon: RefreshCw },
  expired: { label: 'Caducado', tone: 'danger', icon: LockOpen },
  pending: { label: 'Emitiendo', tone: 'warn', icon: Clock },
  error: { label: 'Con error', tone: 'danger', icon: AlertTriangle },
};

export const certHasProblem = (c: CertInfo) => c.state === 'error' || c.state === 'expired' || (c.state === 'pending' && !c.dns.ok);

export function useCertificates(hosts?: string[]) {
  const key = hosts ? hosts.join(',') : '';
  return useQuery({
    queryKey: ['certificates', key],
    queryFn: () => api.get<CertOverview>(`/api/certificates${hosts ? `?hosts=${encodeURIComponent(key)}` : ''}`),
    // Refresh more often while something is being issued.
    refetchInterval: (q) => (q.state.data?.certificates.some((c) => c.state === 'pending' || c.state === 'renewing') ? 20_000 : 120_000),
  });
}

function CertRow({ c, showOwner }: { c: CertInfo; showOwner: boolean }) {
  const st = certStateStyle[c.state];
  const Icon = st.icon;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg [&>svg]:size-4', {
          ok: 'bg-ok-soft text-ok',
          info: 'bg-info-soft text-info',
          warn: 'bg-warn-soft text-warn',
          danger: 'bg-danger-soft text-danger',
          neutral: 'bg-surface-2 text-muted',
        }[st.tone])}>
          <Icon />
        </span>
        <div className="min-w-0 flex-1">
          <a href={`https://${c.host}`} target="_blank" rel="noreferrer" className="font-mono text-[13.5px] font-medium hover:text-accent">
            {c.host}
          </a>
          <div className="truncate text-xs text-muted">
            {showOwner &&
              (c.owner_link ? (
                <Link to={c.owner_link} className="hover:text-accent">
                  {c.owner}
                </Link>
              ) : (
                c.owner
              ))}
            {showOwner && c.issuer && ' · '}
            {c.issuer}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-right">
          {c.not_after && c.state !== 'expired' && (
            <span className="tabular text-xs text-muted">
              Caduca el {fmt(c.not_after)} ({c.days_left} d)
            </span>
          )}
          <Badge tone={st.tone} dot>
            {st.label}
          </Badge>
        </div>
      </div>
      {c.renews_from && c.state === 'valid' && (
        <p className="mt-1.5 pl-11 text-xs text-muted">Se renovará automáticamente a partir del {fmt(c.renews_from)}.</p>
      )}
      {c.state === 'renewing' && <p className="mt-1.5 pl-11 text-xs text-info">Dentro del periodo de renovación: Caddy está pidiendo el certificado nuevo.</p>}
      {c.state === 'pending' && c.dns.ok && <p className="mt-1.5 pl-11 text-xs text-muted">El DNS es correcto; Let's Encrypt suele emitirlo en menos de un minuto.</p>}
      {(c.error || (!c.dns.ok && c.state !== 'valid')) && (
        <div className="mt-2 space-y-1.5 pl-11 text-[12.5px]">
          {!c.dns.ok && c.dns.problem && (
            <p className="flex items-start gap-1.5 text-danger">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {c.dns.problem}
            </p>
          )}
          {c.error && (
            <>
              <p className="text-fg/85">{c.error.hint}</p>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none hover:text-fg">
                  Último intento {timeAgo(c.error.at)}
                  {c.error.retry_at && ` · próximo intento ${new Date(c.error.retry_at) > new Date() ? `hacia las ${new Date(c.error.retry_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : 'en breve'}`}
                </summary>
                <code className="mt-1 block font-mono break-all">{c.error.message}</code>
              </details>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Certificate status for some hostnames (a site) or all of them. */
export function CertificateList({ hosts, title = 'Certificados SSL', showOwner = !hosts }: { hosts?: string[]; title?: string; showOwner?: boolean }) {
  const qc = useQueryClient();
  const q = useCertificates(hosts);
  const retry = useMutation({
    mutationFn: () => api.post('/api/certificates/retry'),
    onSuccess: () => {
      toast.success("Solicitando de nuevo los certificados a Let's Encrypt");
      setTimeout(() => qc.invalidateQueries({ queryKey: ['certificates'] }), 4000);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const list = q.data?.certificates ?? [];
  const failing = list.filter((c) => c.state !== 'valid' && c.state !== 'renewing');
  return (
    <Card
      padded={false}
      icon={<ShieldCheck />}
      title={title}
      description="Let's Encrypt: uno por dominio, emitido y renovado automáticamente."
      actions={
        <>
          <Button size="sm" variant="ghost" aria-label="Actualizar" loading={q.isFetching} onClick={() => q.refetch()}>
            <RefreshCw className="size-3.5" />
          </Button>
          {failing.length > 0 && (
            <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
              Reintentar ahora
            </Button>
          )}
        </>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="p-4">
          <ErrorBox error={q.error} />
        </div>
      ) : list.length === 0 ? (
        <Empty icon={<Lock className="size-6" />} title="Sin dominios" description="Cuando vincules un dominio, su certificado se pedirá automáticamente." />
      ) : (
        <ul className="divide-y divide-border">
          {list.map((c) => (
            <CertRow key={c.host} c={c} showOwner={showOwner} />
          ))}
        </ul>
      )}
      {q.data && !q.data.email && (
        <div className="border-t border-border p-3">
          <Callout tone="info">
            Sin email de contacto para Let's Encrypt ({q.data.configured_email || 'vacío'} no es válido). Los certificados se emiten igual, pero no recibirás avisos de caducidad. Cambia{' '}
            <code className="font-mono">HP_ADMIN_EMAIL</code> en <code className="font-mono">/etc/hostpanel/hostpanel.env</code>.
          </Callout>
        </div>
      )}
    </Card>
  );
}
