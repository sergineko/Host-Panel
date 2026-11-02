import { useState } from 'react';
import { compact } from '../lib/format';
import { cx } from './ui';

export interface BarPoint {
  hour: number;
  value: number;
  /** Part of `value` drawn in the warning colour (errors, failures). */
  bad?: number;
}

/** Hourly bars with a hover readout (Workers requests, queue messages…). */
export function BarChart({ series, label, badLabel, height = 120 }: { series: BarPoint[]; label: string; badLabel?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.value));
  const active = hover !== null ? series[hover] : null;
  const total = series.reduce((a, s) => a + s.value, 0);
  const totalBad = series.reduce((a, s) => a + (s.bad ?? 0), 0);
  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-xs text-muted">{active ? new Date(active.hour * 1000).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Total del periodo'}</div>
          <div className="tabular text-lg font-semibold">
            {compact(active ? active.value : total)} <span className="text-[13px] font-normal text-muted">{label}</span>
          </div>
        </div>
        {badLabel && (
          <div className="tabular text-xs text-muted">
            <span className={cx((active ? active.bad : totalBad) ? 'text-danger' : '')}>{compact((active ? active.bad : totalBad) ?? 0)}</span> {badLabel}
          </div>
        )}
      </div>
      <div className="flex items-end gap-[2px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => {
          const h = (s.value / max) * 100;
          const bad = s.value ? ((s.bad ?? 0) / s.value) * h : 0;
          return (
            <div key={s.hour} className="flex h-full flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(i)}>
              <div className={cx('flex w-full flex-col justify-end overflow-hidden rounded-t-sm', hover === i ? 'opacity-100' : 'opacity-85')} style={{ height: `${Math.max(h, s.value ? 2 : 0)}%` }}>
                <div className="w-full bg-danger" style={{ height: `${h ? (bad / h) * 100 : 0}%` }} />
                <div className="w-full flex-1 bg-accent" />
              </div>
              {!s.value && <div className="h-px w-full bg-border" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
