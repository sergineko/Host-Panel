import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { Button, ErrorBox, PageHeader } from '../components/ui';
import { SiteForm, type SiteFormValue } from '../components/SiteForm';

export default function SiteNew() {
  const [params] = useSearchParams();
  const host = params.get('host');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [value, setValue] = useState<SiteFormValue>({
    name: host ?? '',
    hostnames: host ? [host, `www.${host}`] : [],
    type: 'static',
    spa: false,
    repo_url: '',
    branch: 'main',
    install_command: '',
    build_command: '',
    output_dir: '',
    start_command: '',
    env: {},
    memory_mb: 512,
    auto_deploy: true,
  });

  const create = useMutation({
    mutationFn: () => api.post<Site & { deployment_id: number }>('/api/sites', value),
    onSuccess: (site) => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      toast.success('Sitio creado. Primer despliegue en marcha.');
      navigate(`/sites/${site.id}?deployment=${site.deployment_id}`);
    },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/sites" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Sitios
      </Link>
      <PageHeader title="Nuevo sitio" description="Conecta un repositorio y se desplegará automáticamente con SSL." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-4"
      >
        <SiteForm value={value} onChange={setValue} />
        {create.error && <ErrorBox error={create.error} />}
        <div className="flex justify-end gap-2">
          <Link to="/sites">
            <Button type="button">Cancelar</Button>
          </Link>
          <Button variant="primary" type="submit" loading={create.isPending} disabled={!value.name || !value.hostnames.length}>
            Crear y desplegar
          </Button>
        </div>
      </form>
    </div>
  );
}
