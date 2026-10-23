import { Radio, WifiOff } from 'lucide-react';
import { backendEnabled } from '../integrations/ring/client';
import { useThreshold } from '../state/store';
import { Wordmark } from './Wordmark';

const STATIC_NOTE =
  'This deploy has no backend: Ring delivery events are simulated in the browser and labelled as such. ' +
  'Run the FastAPI adapter in server/ to receive signed Ring webhooks.';

function ConnectionBadge() {
  const connection = useThreshold((s) => s.connection);
  const integration = useThreshold((s) => s.integration);
  const live = connection === 'online' && integration?.mode === 'live';
  let label: string;
  let detail: string;
  let color: string;
  if (!backendEnabled) {
    label = 'Simulation mode';
    detail = 'static demo · in-browser Ring simulator';
    color = 'text-estimate';
  } else if (connection !== 'online') {
    label = 'Simulation mode';
    detail = connection === 'connecting' ? 'connecting to backend…' : 'backend offline · in-browser simulation';
    color = 'text-estimate';
  } else if (live) {
    label = 'Ring integration live';
    detail = integration?.webhook.signingKeyConfigured ? 'webhook signature verification on' : 'API credentials configured';
    color = 'text-clear';
  } else {
    label = 'Simulation mode';
    detail = 'backend online · no Ring credentials';
    color = 'text-estimate';
  }
  return (
    <div className="glass flex items-center gap-2.5 rounded-xl px-3 py-2" title={integration?.notes?.join('\n') ?? (backendEnabled ? '' : STATIC_NOTE)}>
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color} pulse-dot`} style={{ background: 'currentColor' }} />
      <div className="leading-tight">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-text-1">
          {backendEnabled && connection === 'offline' ? <WifiOff size={12} className="text-text-3" /> : <Radio size={12} className={color} />}
          {label}
        </div>
        <div className="text-[10.5px] text-text-3">{detail}</div>
      </div>
    </div>
  );
}

export function TopBar() {
  const phase = useThreshold((s) => s.phase);
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4 md:p-5">
      <div
        className={`glass pointer-events-auto rounded-2xl px-4 py-2.5 transition-opacity duration-700 ${phase === 'intro' || phase === 'loading' ? 'opacity-0' : 'opacity-100'}`}
      >
        <Wordmark size={17} />
      </div>
      <div className="pointer-events-auto">
        <ConnectionBadge />
      </div>
    </header>
  );
}
