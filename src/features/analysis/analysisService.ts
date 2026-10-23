import { analyzeEntrance } from '../../geometry/analyze';
import { DEFAULT_MODEL } from '../../geometry/entranceModel';
import type { AnalysisResult, ParcelPose, Placement } from '../../geometry/types';
import type { AnalysisRequest, AnalysisResponse } from './protocol';

type Input = Omit<AnalysisRequest, 'id'>;

/**
 * Latest-wins analysis scheduler. While one request is in flight, newer
 * requests replace each other; only the most recent is computed next, so a
 * fast drag never builds a backlog. Falls back to the main thread if workers
 * are unavailable.
 */
export class AnalysisService {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight: { id: number; resolve: (r: AnalysisResult) => void; reject: (e: Error) => void } | null = null;
  private queued: { input: Input; resolve: (r: AnalysisResult) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<AnalysisResponse>) => this.handle(e.data);
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  analyze(input: Input): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      if (this.inFlight) {
        this.queued?.reject(new SupersededError());
        this.queued = { input, resolve, reject };
        return;
      }
      this.dispatch(input, resolve, reject);
    });
  }

  /** Synchronous computation on the calling thread (tests, fallbacks). */
  static analyzeNow(parcel: ParcelPose | null, placement: Placement, requiredClearWidth: number): AnalysisResult {
    return analyzeEntrance({ model: DEFAULT_MODEL, parcel, placement, requiredClearWidth });
  }

  private dispatch(input: Input, resolve: (r: AnalysisResult) => void, reject: (e: Error) => void) {
    const id = this.nextId++;
    if (!this.worker) {
      try {
        resolve(AnalysisService.analyzeNow(input.parcel, input.placement, input.requiredClearWidth));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    this.inFlight = { id, resolve, reject };
    const msg: AnalysisRequest = { id, ...input };
    this.worker.postMessage(msg);
  }

  private handle(msg: AnalysisResponse) {
    const current = this.inFlight;
    if (!current || current.id !== msg.id) return;
    this.inFlight = null;
    if (msg.result) current.resolve(msg.result);
    else current.reject(new Error(msg.error ?? 'analysis failed'));
    const q = this.queued;
    this.queued = null;
    if (q) this.dispatch(q.input, q.resolve, q.reject);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}

export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer analysis request');
  }
}
