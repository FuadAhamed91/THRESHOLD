import type { ReactNode } from 'react';
import { CircleCheck, CircleX, CircleDot, TriangleAlert } from 'lucide-react';

export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-clear',
  bad: 'text-conflict',
  warn: 'text-caution',
  info: 'text-scan',
  muted: 'text-text-3',
};

/** Status communicated by text AND shape, never colour alone. */
export function StatusIcon({ tone, size = 16 }: { tone: Tone; size?: number }) {
  const cls = TONE_CLASS[tone];
  if (tone === 'ok') return <CircleCheck size={size} className={cls} aria-hidden />;
  if (tone === 'bad') return <CircleX size={size} className={cls} aria-hidden />;
  if (tone === 'warn') return <TriangleAlert size={size} className={cls} aria-hidden />;
  return <CircleDot size={size} className={cls} aria-hidden />;
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const bg: Record<Tone, string> = {
    ok: 'bg-clear/12 border-clear/40 text-clear',
    bad: 'bg-conflict/10 border-conflict/40 text-conflict',
    warn: 'bg-caution/12 border-caution/45 text-caution',
    info: 'bg-scan/10 border-scan/40 text-scan',
    muted: 'bg-black/5 border-line text-text-2',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase ${bg[tone]}`}>
      {children}
    </span>
  );
}

export function Panel({ children, className = '', strong = false }: { children: ReactNode; className?: string; strong?: boolean }) {
  return <section className={`${strong ? 'glass-strong' : 'glass'} rounded-2xl ${className}`}>{children}</section>;
}

export function Divider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-black/10 to-transparent" />;
}
