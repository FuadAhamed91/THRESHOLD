import { useMemo } from 'react';
import { DEFAULT_MODEL } from '../geometry/entranceModel';
import type { AnalysisResult, Vec2 } from '../geometry/types';

const VIEW = { x0: -2.05, x1: 2.05, z0: -1.25, z1: 3.35 };
const W = VIEW.x1 - VIEW.x0;
const H = VIEW.z1 - VIEW.z0;

const pts = (poly: readonly Vec2[]) => poly.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`).join(' ');

/**
 * Top-down plan of the analysed area, drawn straight from the geometry
 * engine's output (house at the top, street below). Also serves as the
 * no-WebGL fallback visual.
 */
export function PlanView({ result, height = 230 }: { result: AnalysisResult | null; height?: number }) {
  const m = DEFAULT_MODEL;
  const statics = useMemo(
    () => ({
      walk: pts(m.walkable.polygon),
      corridor: pts(m.route.corridor),
      safe: pts(m.safeDropZone.polygon),
      planters: m.obstacles.map((o) => pts(o.polygon)),
    }),
    [m],
  );
  const r = result && result.status !== 'invalid' ? result : null;
  const doorBad = r?.door.physicallyBlocked;
  const parcelBad = r && (r.door.physicallyBlocked || r.route.intrudes) && r.placement.source !== 'estimated_prior';
  const parcelColor = !r ? '#9fc4ff' : r.placement.source === 'estimated_prior' ? '#f7c55a' : parcelBad ? '#ff4d61' : r.safeZone.contained ? '#34e0a1' : '#9fc4ff';
  const route = r ? (r.path.found ? r.path.points : r.path.reachable) : [];
  const routeColor = r?.status === 'clear' ? '#34e0a1' : '#38d6f5';
  return (
    <svg viewBox={`${VIEW.x0} ${VIEW.z0} ${W} ${H}`} style={{ height, width: '100%' }} className="block" role="img" aria-label="Plan view of the analysed entrance">
      <defs>
        <pattern id="pv-hatch" width="0.08" height="0.08" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.08" stroke="#ff4d61" strokeWidth="0.03" />
        </pattern>
      </defs>
      <rect x={VIEW.x0} y={VIEW.z0} width={W} height={H} fill="#050a15" />
      <rect x={-2.05} y={-0.3} width={4.1} height={0.3} fill="#1a2438" />
      <polygon points={statics.walk} fill="#0e1830" stroke="#2b3d5e" strokeWidth={0.02} />
      <polygon points={statics.corridor} fill="#3b8bff" fillOpacity={0.16} stroke="#7cc0ff" strokeOpacity={0.6} strokeWidth={0.015} />
      <polygon points={statics.safe} fill="#34e0a1" fillOpacity={0.1} stroke="#34e0a1" strokeWidth={0.02} strokeDasharray="0.07 0.05" />
      {statics.planters.map((p, i) => (
        <polygon key={i} points={p} fill="#1f2a3f" stroke="#41557a" strokeWidth={0.015} />
      ))}
      {r && (
        <>
          <polygon points={pts(r.door.swingRegion)} fill={doorBad ? '#ff4d61' : '#9fc4ff'} fillOpacity={0.14} stroke={doorBad ? '#ff4d61' : '#9fc4ff'} strokeWidth={0.015} />
          <polygon points={pts(r.door.leafAtMaxOpening)} fill={doorBad ? '#ff4d61' : '#c9d8f2'} />
          {route.length > 1 && (
            <polyline points={pts(route)} fill="none" stroke={routeColor} strokeWidth={0.045} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {!r.path.found && r.path.blockedContinuation.length > 1 && (
            <polyline points={pts(r.path.blockedContinuation)} fill="none" stroke="#ff4d61" strokeWidth={0.03} strokeDasharray="0.08 0.06" />
          )}
          {r.placement.uncertaintyRadius > 0.08 && r.parcel && (
            <circle cx={r.parcel.center.x} cy={r.parcel.center.z} r={r.placement.uncertaintyRadius} fill="#f7c55a" fillOpacity={0.06} stroke="#f7c55a" strokeWidth={0.015} strokeDasharray="0.06 0.05" />
          )}
          {r.parcelFootprint.length > 2 && <polygon points={pts(r.parcelFootprint)} fill={parcelColor} fillOpacity={0.55} stroke={parcelColor} strokeWidth={0.02} />}
          {r.route.overlapPolygon.length > 2 && <polygon points={pts(r.route.overlapPolygon)} fill="url(#pv-hatch)" />}
          {r.clearance.pinch && (
            <line
              x1={r.clearance.pinch.a.x}
              y1={r.clearance.pinch.a.z}
              x2={r.clearance.pinch.b.x}
              y2={r.clearance.pinch.b.z}
              stroke={r.clearance.meetsRequirement ? '#34e0a1' : '#ff4d61'}
              strokeWidth={0.03}
            />
          )}
        </>
      )}
      <text x={0} y={-0.62} textAnchor="middle" fontSize={0.17} fill="#62779a" fontFamily="Inter Variable">
        HOUSE
      </text>
      <text x={0} y={3.22} textAnchor="middle" fontSize={0.15} fill="#62779a" fontFamily="Inter Variable">
        ↓ ramp to street
      </text>
    </svg>
  );
}
