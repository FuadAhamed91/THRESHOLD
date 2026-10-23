/// <reference lib="webworker" />
import { analyzeEntrance } from '../../geometry/analyze';
import { DEFAULT_MODEL } from '../../geometry/entranceModel';
import type { AnalysisRequest, AnalysisResponse } from './protocol';

// The geometry engine runs off the main thread so dragging stays at 60 fps.
self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, parcel, placement, requiredClearWidth } = event.data;
  try {
    const result = analyzeEntrance({ model: DEFAULT_MODEL, parcel, placement, requiredClearWidth });
    const response: AnalysisResponse = { id, result };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, [result.path.explored.buffer]);
  } catch (err) {
    const response: AnalysisResponse = { id, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
