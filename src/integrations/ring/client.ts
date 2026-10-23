import { parseRingEvent, parseStatus } from './normalize';
import type { BackendConnection, IntegrationStatus, NormalizedRingEvent } from './types';

/**
 * Ring adapter client. All Ring credentials live in the backend; the browser
 * only talks to its /api. In development Vite proxies /api to the FastAPI
 * server; a static production deploy (e.g. Vercel) runs the in-browser Ring
 * simulator unless VITE_THRESHOLD_API_BASE points at a deployed backend.
 */
const API_BASE = String(import.meta.env.VITE_THRESHOLD_API_BASE ?? '').replace(/\/$/, '');
export const backendEnabled = import.meta.env.DEV || API_BASE !== '';
const api = (path: string) => `${API_BASE}${path}`;

export interface RingStreamHandlers {
  onEvent: (event: NormalizedRingEvent) => void;
  onStatus: (status: IntegrationStatus) => void;
  onConnection: (state: BackendConnection) => void;
}

export function connectRingStream(handlers: RingStreamHandlers): () => void {
  if (!backendEnabled) {
    handlers.onConnection('offline');
    return () => {};
  }
  let source: EventSource | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    handlers.onConnection('connecting');
    source = new EventSource(api('/api/events/stream'));
    source.addEventListener('hello', (msg) => {
      retry = 0;
      handlers.onConnection('online');
      try {
        const status = parseStatus(JSON.parse((msg as MessageEvent).data));
        if (status) handlers.onStatus(status);
      } catch {
        /* malformed hello: keep the connection, ignore the payload */
      }
    });
    source.addEventListener('ring-event', (msg) => {
      try {
        const event = parseRingEvent(JSON.parse((msg as MessageEvent).data));
        if (event) handlers.onEvent(event);
      } catch {
        /* reject malformed events */
      }
    });
    source.onerror = () => {
      source?.close();
      source = null;
      handlers.onConnection('offline');
      if (closed) return;
      const delay = Math.min(30000, 1500 * 2 ** retry++);
      timer = setTimeout(open, delay);
    };
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
  };
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? res.statusText;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchIntegrationStatus(signal?: AbortSignal): Promise<IntegrationStatus | null> {
  const res = await fetch(api('/api/integration/status'), { signal });
  return parseStatus(await json(res));
}

/** Ask the backend to emit a simulated event (labelled simulated end to end). */
export async function requestServerSimulation(scenario: 'A' | 'B' | 'C'): Promise<NormalizedRingEvent | null> {
  const res = await fetch(api('/api/simulate/delivery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  return parseRingEvent(await json(res));
}

/**
 * Request a fresh still from the Ring camera at the event time (documented
 * image-download endpoint, proxied by the backend). Only works with configured
 * credentials and a real device; returns an object URL for the JPEG.
 */
export async function requestRingSnapshot(deviceId: string, timestamp: number): Promise<{ url: string; origin: string | null }> {
  const res = await fetch(api('/api/ring/snapshot'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, timestamp }),
  });
  if (!res.ok) await json(res);
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), origin: res.headers.get('X-Media-Origin') };
}
