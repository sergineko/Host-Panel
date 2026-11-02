import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { api, ApiError } from './lib/api';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Domains from './pages/Domains';
import DomainDetail from './pages/DomainDetail';
import Sites from './pages/Sites';
import SiteDetail from './pages/SiteDetail';
import SiteNew from './pages/SiteNew';
import Proxy from './pages/Proxy';
import Security from './pages/Security';
import Mail from './pages/Mail';
import Databases from './pages/Databases';
import Analytics from './pages/Analytics';
import SettingsPage from './pages/Settings';

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
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ username: string }>('/api/auth/me') });
  useEffect(() => {
    const onUnauthorized = () => navigate('/login');
    window.addEventListener('hp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hp:unauthorized', onUnauthorized);
  }, [navigate]);

  if (me.isLoading) return <Spinner className="min-h-screen items-center" />;
  if (me.isError) return <Navigate to="/login" replace />;
  return <Layout username={me.data!.username} />;
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
          <Route element={<Protected />}>
            <Route index element={<Dashboard />} />
            <Route path="domains" element={<Domains />} />
            <Route path="domains/:id" element={<DomainDetail />} />
            <Route path="sites" element={<Sites />} />
            <Route path="sites/new" element={<SiteNew />} />
            <Route path="sites/:id" element={<SiteDetail />} />
            <Route path="proxy" element={<Proxy />} />
            <Route path="security" element={<Security />} />
            <Route path="mail" element={<Mail />} />
            <Route path="databases" element={<Databases />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <ThemedToaster />
    </QueryClientProvider>
  </StrictMode>,
);
