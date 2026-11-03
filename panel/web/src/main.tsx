import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { ApiError } from './lib/api';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { clientCanOpen, isStaffRole, useMe } from './lib/me';
import { BrandingEffect } from './lib/branding';

// Every other page is a separate chunk, loaded on first visit (smaller initial download).
const Setup = lazy(() => import('./pages/Setup'));
const Clients = lazy(() => import('./pages/Clients'));
const ClientHome = lazy(() => import('./pages/ClientHome'));
const LicenseRequired = lazy(() => import('./pages/LicenseRequired'));
const Domains = lazy(() => import('./pages/Domains'));
const DomainDetail = lazy(() => import('./pages/DomainDetail'));
const Sites = lazy(() => import('./pages/Sites'));
const SiteDetail = lazy(() => import('./pages/SiteDetail'));
const SiteNew = lazy(() => import('./pages/SiteNew'));
const Proxy = lazy(() => import('./pages/Proxy'));
const Security = lazy(() => import('./pages/Security'));
const Mail = lazy(() => import('./pages/Mail'));
const Databases = lazy(() => import('./pages/Databases'));
const DatabaseDetail = lazy(() => import('./pages/DatabaseDetail'));
const Storage = lazy(() => import('./pages/Storage'));
const BucketDetail = lazy(() => import('./pages/BucketDetail'));
const Servers = lazy(() => import('./pages/Servers'));
const Analytics = lazy(() => import('./pages/Analytics'));
const SystemPage = lazy(() => import('./pages/System'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Workers = lazy(() => import('./pages/Workers'));
const WorkerDetail = lazy(() => import('./pages/WorkerDetail'));
const Queues = lazy(() => import('./pages/Queues'));
const QueueDetail = lazy(() => import('./pages/QueueDetail'));
const NosqlList = lazy(() => import('./pages/Nosql').then((m) => ({ default: m.NosqlList })));
const NosqlDetail = lazy(() => import('./pages/Nosql').then((m) => ({ default: m.NosqlDetail })));
const LoadBalancers = lazy(() => import('./pages/LoadBalancers'));
const Certificates = lazy(() => import('./pages/Certificates'));
const KvList = lazy(() => import('./pages/Kv').then((m) => ({ default: m.KvList })));
const KvDetail = lazy(() => import('./pages/Kv').then((m) => ({ default: m.KvDetail })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function Protected() {
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  useEffect(() => {
    const onUnauthorized = () => navigate('/login');
    window.addEventListener('hp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hp:unauthorized', onUnauthorized);
  }, [navigate]);

  if (me.isLoading) return <Spinner className="min-h-screen items-center" />;
  if (me.isError) return <Navigate to="/login" replace />;
  // First-run wizard not finished: nothing else until it is.
  if (me.data!.setup_pending) return <Navigate to="/setup" replace />;
  if (!me.data!.license_ok) {
    return (
      <Suspense fallback={<Spinner className="min-h-screen items-center" />}>
        <LicenseRequired me={me.data!} />
      </Suspense>
    );
  }
  // A client opening a staff-only section (old link, typed URL) goes back to its home.
  if (!isStaffRole(me.data!.role) && !clientCanOpen(location.pathname)) return <Navigate to="/" replace />;
  return <Layout username={me.data!.username} role={me.data!.role} clientName={me.data!.client?.name} />;
}

/** Owner and team see the server overview; a client sees its own resources. */
function Home() {
  const me = useMe();
  return isStaffRole(me.data?.role) ? <Dashboard /> : <ClientHome />;
}

function ThemedToaster() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" richColors closeButton />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/setup"
            element={
              <Suspense fallback={<Spinner className="min-h-screen items-center" />}>
                <Setup />
              </Suspense>
            }
          />
          <Route element={<Protected />}>
            <Route index element={<Home />} />
            <Route path="clients" element={<Clients />} />
            <Route path="domains" element={<Domains />} />
            <Route path="domains/:id" element={<DomainDetail />} />
            <Route path="sites" element={<Sites />} />
            <Route path="sites/new" element={<SiteNew />} />
            <Route path="sites/:id" element={<SiteDetail />} />
            <Route path="proxy" element={<Proxy />} />
            <Route path="security" element={<Security />} />
            <Route path="mail" element={<Mail />} />
            <Route path="databases" element={<Databases />} />
            <Route path="databases/:id" element={<DatabaseDetail />} />
            <Route path="nosql" element={<NosqlList />} />
            <Route path="nosql/:id" element={<NosqlDetail />} />
            <Route path="load-balancers" element={<LoadBalancers />} />
            <Route path="certificates" element={<Certificates />} />
            <Route path="storage" element={<Storage />} />
            <Route path="storage/:id" element={<BucketDetail />} />
            <Route path="servers" element={<Servers />} />
            <Route path="workers" element={<Workers />} />
            <Route path="workers/:id" element={<WorkerDetail />} />
            <Route path="queues" element={<Queues />} />
            <Route path="queues/:id" element={<QueueDetail />} />
            <Route path="kv" element={<KvList />} />
            <Route path="kv/:id" element={<KvDetail />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <ThemedToaster />
      <BrandingEffect />
    </QueryClientProvider>
  </StrictMode>,
);
