import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Globe, ShieldCheck } from 'lucide-react';
import { api, type Domain, type IpRule } from '../lib/api';
import { Card, Empty, PageHeader, Select, Spinner } from '../components/ui';
import { IpRulesTable, SecurityPanel } from '../components/SecurityPanel';

export default function Security() {
  const [params, setParams] = useSearchParams();
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains') });
  const globalRules = useQuery({ queryKey: ['ip-rules-global'], queryFn: () => api.get<IpRule[]>('/api/ip-rules') });
  const selected = Number(params.get('domain')) || domains.data?.[0]?.id;

  return (
    <>
      <PageHeader title="Seguridad / WAF" description="Firewall OWASP, límite de peticiones, bloqueo de IPs y bots, y modo bajo ataque por dominio." />

      <Card title="Reglas de IP globales (todos los dominios)" padded={false} className="mb-6">
        {globalRules.isLoading ? <Spinner /> : <IpRulesTable rules={globalRules.data ?? []} domainId={null} queryKey={['ip-rules-global']} />}
      </Card>

      {domains.isLoading ? (
        <Spinner />
      ) : !domains.data?.length ? (
        <Card>
          <Empty
            icon={<Globe className="size-6" />}
            title="Añade un dominio para configurar su seguridad"
            action={
              <Link to="/domains" className="text-accent hover:underline">
                Ir a dominios
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <ShieldCheck className="size-5 text-accent" />
            <Select className="max-w-xs" value={selected} onChange={(e) => setParams({ domain: e.target.value })}>
              {domains.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-muted">Se aplica al dominio y a todos sus subdominios.</span>
          </div>
          {selected && <SecurityPanel key={selected} domainId={selected} />}
        </>
      )}
    </>
  );
}
