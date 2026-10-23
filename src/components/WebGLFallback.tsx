import { MonitorX } from 'lucide-react';
import { useEffect } from 'react';
import { AnalysisService } from '../features/analysis/analysisService';
import { useThreshold } from '../state/store';
import { PlanView } from './PlanView';
import { Wordmark } from './Wordmark';

/**
 * Without WebGL the 3D experience cannot run, but the geometry engine still
 * can: show its result as a plan so the analysis remains inspectable.
 */
export function WebGLFallback() {
  const error = useThreshold((s) => s.webglError);
  const analysis = useThreshold((s) => s.analysis);
  useEffect(() => {
    if (!error) return;
    const s = useThreshold.getState();
    s.setAnalysis(AnalysisService.analyzeNow(s.parcel, s.placement, s.requiredClearWidth));
  }, [error]);
  if (!error) return null;
  return (
    <div className="absolute inset-0 z-50 overflow-auto bg-cream-100 p-6">
      <div className="mx-auto max-w-2xl">
        <Wordmark size={26} />
        <div className="glass mt-6 flex items-start gap-3 rounded-2xl p-4">
          <MonitorX className="mt-0.5 shrink-0 text-caution" size={20} />
          <div>
            <div className="font-semibold">3D view unavailable</div>
            <div className="mt-1 text-[13px] text-text-2">{error} The geometry engine still runs: below is its plan-view result for the current scenario.</div>
          </div>
        </div>
        <div className="glass mt-4 overflow-hidden rounded-2xl">
          <PlanView result={analysis} height={420} />
        </div>
        {analysis && (
          <ul className="mt-4 space-y-1.5 text-[13px]">
            {analysis.findings.map((f) => (
              <li key={f.code + f.title}>
                <span className="font-semibold">{f.title}.</span> <span className="text-text-2">{f.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
