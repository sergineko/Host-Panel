import { useState } from 'react';
import type { TrafficPoint } from '../lib/api';
import { compact } from '../lib/format';

/** Hourly stacked bars: allowed requests + blocked requests, with hover readout. */
export function TrafficChart({ series, height = 160 }: { series: TrafficPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.requests));
  const active = hover !== null ? series[hover] : null;
  const total = series.reduce((a, s) => a + s.requests, 0);

  return (
    <div>
      <div className="mb-3 flex h-10 items-end justify-between gap-4">
        <div>
          <div className="text-xs text-muted">{active ? new Date(active.hour * 1000).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Total del periodo'}</div>
          <div className="tabular text-lg font-semibold">{compact(active ? active.requests : total)} <span className="text-[13px] font-normal text-muted">peticiones</span></div>
        </div>
        {active && (
          <div className="tabular text-right text-xs text-muted">
            <div>
              <span className="text-danger">{active.blocked}</span> bloqueadas · {active.s5xx} errores 5xx
            </div>
          </div>
        )}
      </div>
      <div className="flex items-end gap-[2px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => {
          const h = (s.requests / max) * 100;
          const blocked = s.requests ? (s.blocked / s.requests) * h : 0;
          return (
            <div key={s.hour} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
              <div className={`flex flex-col justify-end rounded-t-[2px] transition-opacity ${hover !== null && hover !== i ? 'opacity-50' : ''}`} style={{ height: `${Math.max(h, s.requests ? 2 : 0.5)}%` }}>
                <div className="bg-danger/80" style={{ height: `${h ? (blocked / h) * 100 : 0}%` }} />
                <div className="flex-1 bg-accent" style={{ minHeight: s.requests ? 1 : 0 }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>{series[0] && new Date(series[0].hour * 1000).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        <span>ahora</span>
      </div>
    </div>
  );
}
