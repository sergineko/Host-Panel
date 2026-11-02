import { AlertTriangle, Clock, Lock, RefreshCw } from 'lucide-react';
import { CertificateList, certHasProblem, useCertificates } from '../components/Certificates';
import { Callout, PageHeader, StatCard } from '../components/ui';

export default function Certificates() {
  const q = useCertificates();
  const list = q.data?.certificates ?? [];
  const count = (f: (c: (typeof list)[number]) => boolean) => list.filter(f).length;
  return (
    <>
      <PageHeader
        title="Certificados SSL"
        description="Cada dominio vinculado a un sitio, Worker, balanceador o proxy recibe su propio certificado de Let's Encrypt, que se renueva solo."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Válidos" value={count((c) => c.state === 'valid')} icon={<Lock />} tone="bg-ok-soft text-ok" />
        <StatCard label="Renovando" value={count((c) => c.state === 'renewing')} icon={<RefreshCw />} tone="bg-info-soft text-info" />
        <StatCard label="Emitiendo" value={count((c) => c.state === 'pending')} icon={<Clock />} tone="bg-warn-soft text-warn" />
        <StatCard label="Con problemas" value={count(certHasProblem)} icon={<AlertTriangle />} tone="bg-danger-soft text-danger" />
      </div>
      <Callout className="mb-5" title="Cómo funciona">
        Al vincular un dominio, el servidor pide su certificado a Let's Encrypt en cuanto el DNS apunta aquí
        {q.data ? (
          <>
            {' '}
            (registro A → <span className="font-mono">{q.data.server_ip}</span>
            {q.data.server_ipv6 && (
              <>
                , AAAA → <span className="font-mono">{q.data.server_ipv6}</span>
              </>
            )}
            )
          </>
        ) : null}
        . Los certificados duran 90 días y se renuevan automáticamente cuando les queda un tercio de vida; si una renovación falla, se reintenta sola. Los puertos 80 y 443 deben estar abiertos.
      </Callout>
      <CertificateList title="Dominios" />
    </>
  );
}
