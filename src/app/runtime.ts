import type { Director } from '../animation/director';
import type { AnalysisService } from '../features/analysis/analysisService';
import type { Experience } from '../scene/Experience';

/** Long-lived imperative objects shared by the canvas and the UI panels. */
export const runtime: {
  exp: Experience | null;
  director: Director | null;
  analysis: AnalysisService | null;
} = { exp: null, director: null, analysis: null };
