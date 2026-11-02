import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { api, type Job } from '../lib/api';
import { cx } from './ui';

/** Live log of a background job (PHP install, update…). Polls while it runs. */
export function JobLog({ jobId, onDone, className }: { jobId: number; onDone?: (job: Job) => void; className?: string }) {
  const doneRef = useRef(false);
  const preRef = useRef<HTMLPreElement>(null);
  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<Job>(`/api/jobs/${jobId}`),
    // While an update restarts the panel, requests fail for a few seconds: keep polling.
    refetchInterval: (query) => (query.state.data?.status === 'running' || !query.state.data ? 1500 : false),
    retry: true,
    retryDelay: 2000,
  });
  const job = q.data;

  useEffect(() => {
    if (job && job.status !== 'running' && !doneRef.current) {
      doneRef.current = true;
      onDone?.(job);
    }
  }, [job, onDone]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.log]);

  const lines = (job?.log ?? '').replace(/^HP_JOB_DONE.*$/m, '').trim();
  return (
    <div className={cx('overflow-hidden rounded-md border border-border', className)}>
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-[13px]">
        {!job || job.status === 'running' ? (
          <Loader2 className="size-4 animate-spin text-info" />
        ) : job.status === 'success' ? (
          <CheckCircle2 className="size-4 text-ok" />
        ) : (
          <XCircle className="size-4 text-danger" />
        )}
        <span className="font-medium">{job?.title ?? 'Cargando…'}</span>
        <span className="ml-auto text-xs text-muted">
          {!job || job.status === 'running' ? 'En curso' : job.status === 'success' ? 'Completado' : 'Con errores'}
        </span>
      </div>
      <pre ref={preRef} className="max-h-80 overflow-auto bg-[#0b0d12] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#cfd5e1]">
        {lines || 'Esperando salida…'}
      </pre>
    </div>
  );
}
