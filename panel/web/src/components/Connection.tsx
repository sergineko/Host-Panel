import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Crown, Globe, Mail, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { api, type Delegation, type ServerIdentity } from '../lib/api';
import { CodeBlock } from './TokensPanel';
import { JobLog } from './JobLog';
import { Badge, Button, Callout, Card, ChoiceCard, Copyable, ErrorBox, Field, Input, Select, Spinner, Table, Td, cx } from './ui';

export function useIdentity() {
  return useQuery({ queryKey: ['identity'], queryFn: () => api.get<ServerIdentity>('/api/server/identity') });
}

// --- main domain of the server ---------------------------------------------------------------

/** Chooses the server's main domain (nameservers, mail and panel hostnames come from it). */
export function MainDomainCard() {
  const qc = useQueryClient();
  const q = useIdentity();
  const [domainId, setDomainId] = useState<number | ''>('');
  const [email, setEmail] = useState('');
  const [changing, setChanging] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<{ job_id: number }>('/api/server/main-domain', { domain_id: Number(domainId), email: email.trim() || undefined }),
    onSuccess: (r) => setJobId(r.job_id),
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const id = q.data!;
  const activeJob = jobId ?? id.job?.id ?? null;
  const ready = id.nameservers_ready && id.mail_ready;
  const candidates = id.candidates ?? [];
  const placeholderEmail = !id.admin_email || /@(example\.(com|org|net)|localhost)$/i.test(id.admin_email);

  return (
    <Card
      icon={<Crown />}
      title="Dominio principal del servidor"
      description="De él salen los nameservers de todos tus dominios, el servidor de correo y la dirección del panel."
    >
      {activeJob !== null && (
        <div className="mb-4">
          <JobLog
            jobId={activeJob}
            onDone={(job) => {
              setJobId(null);
              setChanging(false);
              qc.invalidateQueries();
              if (job.status === 'success') toast.success('Dominio principal configurado');
              else toast.error('No se pudo configurar el dominio principal');
            }}
          />
          <p className="mt-2 text-xs text-muted">El panel se reinicia al terminar; si la página deja de responder unos segundos, es normal.</p>
        </div>
      )}
      {ready && !changing ? (
        <div className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            {[
              ['Dominio principal', id.base_domain],
              ['Panel', id.panel_domain],
              ['Servidor de correo', id.mail_hostname],
              ['Nameservers', id.nameservers.join(' · ')],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="truncate font-mono text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setChanging(true)} disabled={activeJob !== null}>
              Cambiar dominio principal
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {!ready && (
            <Callout tone="warn" title="Este servidor todavía no tiene dominio principal">
              Sin él no hay nameservers propios ni servidor de correo. Elige uno de tus dominios (por ejemplo, el de tu empresa): el
              servidor pasará a ser <span className="font-mono">ns1</span>, <span className="font-mono">ns2</span>,{' '}
              <span className="font-mono">mail</span> y <span className="font-mono">panel</span> de ese dominio.
            </Callout>
          )}
          {candidates.length === 0 ? (
            <p className="text-[13px] text-muted">
              Primero <Link to="/domains" className="font-medium text-accent hover:underline">añade un dominio</Link> con el DNS gestionado por el panel.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Dominio">
                  <Select value={domainId} onChange={(e) => setDomainId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Elige un dominio…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Email de contacto (SSL y correo)" hint={placeholderEmail ? 'Recomendado: el actual no es válido para Let\'s Encrypt.' : `Actual: ${id.admin_email}`}>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />
                </Field>
              </div>
              {domainId !== '' && (
                <div className="rounded-lg border border-border p-3 text-[13px]">
                  <div className="mb-1.5 font-medium">Se configurará:</div>
                  {(() => {
                    const name = candidates.find((c) => c.id === domainId)?.name ?? '';
                    return (
                      <ul className="space-y-1 text-muted">
                        <li><span className="font-mono text-fg">ns1.{name}</span> y <span className="font-mono text-fg">ns2.{name}</span> → nameservers de todos tus dominios</li>
                        <li><span className="font-mono text-fg">mail.{name}</span> → servidor de correo (se instala si falta) y MX de todos tus dominios</li>
                        <li><span className="font-mono text-fg">panel.{name}</span> → acceso al panel con SSL</li>
                      </ul>
                    );
                  })()}
                </div>
              )}
              <div className="flex justify-end gap-2">
                {changing && <Button onClick={() => setChanging(false)}>Cancelar</Button>}
                <Button variant="primary" disabled={domainId === '' || activeJob !== null} loading={start.isPending} onClick={() => start.mutate()}>
                  Usar como dominio principal
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// --- connect one domain ------------------------------------------------------------------------

function Step({ done, title, children }: { done: boolean; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" /> : <Circle className="mt-0.5 size-5 shrink-0 text-border-strong" />}
      <div className="min-w-0 flex-1">
        <div className={cx('font-medium', done && 'text-muted line-through decoration-muted/40')}>{title}</div>
        {children && <div className="mt-1.5 text-[13px] text-muted">{children}</div>}
      </div>
    </li>
  );
}

/** How to point a domain at this server, with a live check of what the internet sees. */
export function DomainConnection({ domainId }: { domainId: number }) {
  const q = useQuery({ queryKey: ['delegation', domainId], queryFn: () => api.get<Delegation>(`/api/domains/${domainId}/delegation`), refetchInterval: 60_000 });
  const [method, setMethod] = useState<'ns' | 'records'>('ns');
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const id = d.identity;

  if (!id.nameservers_ready) {
    return (
      <div className="space-y-4">
        <Callout tone="warn" title="Primero elige el dominio principal del servidor">
          Este servidor se instaló solo con su IP, así que aún no tiene nameservers propios (<span className="font-mono">ns1</span>/
          <span className="font-mono">ns2</span>) ni servidor de correo. Elige un dominio principal y después vuelve aquí.
        </Callout>
        <MainDomainCard />
      </div>
    );
  }

  const status = d.delegated
    ? { tone: 'ok' as const, title: 'Conectado', text: `${d.domain} ya usa los nameservers de este servidor. DNS, web y correo se gestionan desde el panel.` }
    : d.points_here && method === 'records'
      ? { tone: 'info' as const, title: 'Conectado con DNS externo', text: 'La web apunta aquí. Comprueba que has copiado también los registros de correo.' }
      : { tone: 'warn' as const, title: 'Pendiente de conectar', text: 'Sigue uno de los dos métodos de abajo. Los cambios de nameservers tardan entre unos minutos y 48 horas en propagarse.' };

  return (
    <div className="space-y-4">
      <Callout
        tone={status.tone}
        title={status.title}
        action={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={q.isFetching} onClick={() => q.refetch()}>
            Comprobar
          </Button>
        }
      >
        {status.text}
        <div className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <span>
            Nameservers actuales:{' '}
            <span className="font-mono">{d.current_nameservers.length ? d.current_nameservers.join(', ') : 'ninguno (¿dominio sin registrar?)'}</span>
          </span>
          <span>
            Web (A): <span className={cx('font-mono', d.points_here ? 'text-ok' : '')}>{d.public_a.join(', ') || '—'}</span>
          </span>
          <span>
            Correo (MX): <span className={cx('font-mono', d.mail_ok ? 'text-ok' : '')}>{d.public_mx.join(', ') || '—'}</span>
          </span>
        </div>
      </Callout>

      <div className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          selected={method === 'ns'}
          onClick={() => setMethod('ns')}
          icon={<Server />}
          title="Cambiar los nameservers"
          badge={<Badge tone="ok">Recomendado</Badge>}
          description="Todo (web, correo, subdominios, SSL) se gestiona desde aquí y se configura solo."
        />
        <ChoiceCard
          selected={method === 'records'}
          onClick={() => setMethod('records')}
          icon={<Globe />}
          title="Mantener el DNS donde está"
          description="Copias los registros en tu proveedor actual (Cloudflare, tu registrador…). Los cambios futuros los haces tú allí."
        />
      </div>

      {method === 'ns' ? (
        <Card title="Pasos en tu registrador" icon={<Server />} description={`Donde compraste ${d.domain} (GoDaddy, Namecheap, IONOS, DonDominio, OVH…)`}>
          <ol className="space-y-5">
            {d.is_main && (
              <Step done={d.delegated} title="1. Registra los nameservers propios (glue records)">
                Como <span className="font-mono text-fg">{d.domain}</span> es el dominio principal, sus nameservers están dentro de él mismo. Busca en
                tu registrador «Nameservers propios», «Child nameservers», «Glue records» o «Registrar host» y crea:
                <div className="mt-2 overflow-hidden rounded-lg border border-border">
                  <Table head={['Nombre del host', 'IPv4', ...(id.server_ipv6 ? ['IPv6'] : [])]}>
                    {d.glue.map((g) => (
                      <tr key={g.host}>
                        <Td>
                          <Copyable value={g.host} />
                        </Td>
                        <Td>
                          <Copyable value={g.ipv4} />
                        </Td>
                        {id.server_ipv6 && <Td>{g.ipv6 && <Copyable value={g.ipv6} />}</Td>}
                      </tr>
                    ))}
                  </Table>
                </div>
                <p className="mt-2 text-xs">Los dos apuntan a este mismo servidor; los registradores exigen dos nombres, no dos máquinas.</p>
              </Step>
            )}
            <Step done={d.delegated} title={`${d.is_main ? '2' : '1'}. Cambia los nameservers del dominio`}>
              En la configuración DNS de <span className="font-mono text-fg">{d.domain}</span>, elige «Nameservers personalizados» y pon exactamente:
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {d.expected_nameservers.map((ns) => (
                  <Copyable key={ns} value={ns} />
                ))}
              </div>
              {!d.is_main && id.base_domain && (
                <p className="mt-2 text-xs">
                  Estos nameservers ya existen porque pertenecen a tu dominio principal (<span className="font-mono">{id.base_domain}</span>). No hace falta crear nada más.
                </p>
              )}
            </Step>
            <Step done={d.delegated && d.mail_ok} title={`${d.is_main ? '3' : '2'}. Espera a que se propague`}>
              Suele tardar menos de una hora (como mucho 48 h). Esta página lo comprueba sola; cuando termine, los certificados SSL y el correo
              empezarán a funcionar sin hacer nada más.
            </Step>
          </ol>
        </Card>
      ) : (
        <Card
          title="Registros para tu proveedor DNS"
          icon={<Globe />}
          description="Crea estos registros en el DNS que ya usas. Incluyen web, correo (MX, SPF, DKIM, DMARC) y autoconfiguración."
          padded={false}
        >
          {d.records.length === 0 ? (
            <p className="p-4 text-[13px] text-muted">
              Crea al menos un registro A de <span className="font-mono">{d.domain}</span> hacia <span className="font-mono">{id.server_ip}</span>.
            </p>
          ) : (
            <Table head={['Nombre', 'Tipo', 'Valor']}>
              {d.records.map((r, i) => (
                <tr key={i}>
                  <Td className="font-mono text-[12.5px] whitespace-nowrap">{r.name === '@' ? d.domain : `${r.name}.${d.domain}`}</Td>
                  <Td>
                    <Badge>{r.type}</Badge>
                  </Td>
                  <Td className="max-w-md">
                    <Copyable value={r.content} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <p className="border-t border-border px-4 py-3 text-xs text-muted">
            Si usas Cloudflare, deja los registros de correo (MX, mail, autoconfig) como «Solo DNS» (nube gris): el correo no pasa por su proxy.
          </p>
        </Card>
      )}

      {d.is_main && id.mail_hostname && (
        <Card title="Reverse DNS (PTR) del servidor" icon={<Mail />} description="Imprescindible para que Gmail y Outlook acepten tu correo.">
          <p className="mb-3 text-[13px] text-muted">
            No se configura en el registrador sino en el proveedor del VPS (Hetzner, OVH, DigitalOcean, Contabo…), en la sección «Reverse DNS» o «PTR» de la
            IP. Pon:
          </p>
          <CodeBlock>{`${id.server_ip}  →  ${id.mail_hostname}${id.server_ipv6 ? `\n${id.server_ipv6}  →  ${id.mail_hostname}` : ''}`}</CodeBlock>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5" /> Los certificados SSL de cada dominio se piden solos en cuanto el DNS apunta aquí.
      </p>
    </div>
  );
}
