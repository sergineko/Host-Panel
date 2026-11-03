import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import type { Me } from '../lib/me';
import { Logo } from '../components/Layout';
import { LicenseChooser, type LicenseInfo } from '../components/LicenseCards';
import { Button, Callout, Card, ErrorBox, Spinner } from '../components/ui';

/** Shown instead of the panel while there is no valid licence. Websites and mail keep working. */
export default function LicenseRequired({ me }: { me: Me }) {
  const qc = useQueryClient();
  const owner = me.role === 'owner';
  const info = useQuery({ queryKey: ['license'], queryFn: () => api.get<LicenseInfo>('/api/license'), enabled: owner });
  const install = useMutation({
    mutationFn: (token: string) => api.put('/api/license', { token }),
    onSuccess: async () => {
      toast.success('Licencia activada');
      await qc.invalidateQueries();
    },
  });
  const logout = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,var(--accent-soft),transparent_55%)] px-4 py-10">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card title="El panel necesita una licencia" icon={<BadgeCheck />}>
          <div className="space-y-4">
            <Callout tone="info">Las webs, el correo y el DNS siguen funcionando con normalidad. Solo el panel queda bloqueado hasta activar una licencia.</Callout>
            {!owner ? (
              <p className="text-[13px] text-muted">Avisa al titular del panel para que active una licencia.</p>
            ) : info.isLoading ? (
              <Spinner />
            ) : info.error ? (
              <ErrorBox error={info.error} />
            ) : (
              <LicenseChooser plans={info.data!.plans} storeUrl={info.data!.store_url} onActivate={(t) => install.mutate(t)} pending={install.isPending} error={install.error} />
            )}
          </div>
        </Card>
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" icon={<LogOut className="size-3.5" />} onClick={logout}>
            Cerrar sesión
          </Button>
        </div>
      </div>
    </div>
  );
}
