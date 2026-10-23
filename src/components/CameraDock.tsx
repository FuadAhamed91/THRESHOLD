import { Box, Camera, Eye, Grid3x3, Layers, Map as MapIcon, Scan, Sparkles, Tag, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { runtime } from '../app/runtime';
import type { ShotId } from '../scene/camera/shots';
import { useThreshold } from '../state/store';

const SHOT_ICONS: Array<[ShotId, string, ReactNode]> = [
  ['hero', 'Hero', <Camera key="h" size={14} />],
  ['delivery', 'Delivery', <Box key="d" size={14} />],
  ['analysis', 'Analysis', <Scan key="a" size={14} />],
  ['cutaway', 'Cutaway', <Layers key="c" size={14} />],
  ['plan', 'Plan', <MapIcon key="p" size={14} />],
  ['resolution', 'Resolution', <Sparkles key="r" size={14} />],
];

/** Camera compositions and overlay layers (explore mode). */
export function CameraDock() {
  const phase = useThreshold((s) => s.phase);
  const shot = useThreshold((s) => s.shot);
  const layers = useThreshold((s) => s.layers);
  const cutaway = useThreshold((s) => s.cutaway);
  const toggle = useThreshold((s) => s.toggleLayer);
  if (phase !== 'explore') return null;

  const go = (id: ShotId) => {
    useThreshold.setState({ shot: id, cameraMode: 'manual' });
    runtime.exp?.flyTo(id, useThreshold.getState().reducedMotion ? 0.4 : 2.2);
  };
  const setCutaway = (v: boolean) => {
    useThreshold.setState({ cutaway: v });
    runtime.exp?.cutaway.animateTo(v ? 1 : 0, 1.6);
    runtime.exp?.lights.setArchitecturalLevel(v ? 0.8 : 1);
  };

  return (
    <div className="glass-strong pointer-events-auto flex flex-wrap items-center gap-1 rounded-2xl px-2 py-2">
      {SHOT_ICONS.map(([id, label, icon]) => (
        <button key={id} className="icon-btn !w-auto gap-1.5 px-2.5 text-[11px]" data-active={shot === id} onClick={() => go(id)} title={`${label} view`}>
          {icon}
          <span className="hidden xl:inline">{label}</span>
        </button>
      ))}
      <span className="mx-1 h-6 w-px bg-black/10" />
      <button className="icon-btn" data-active={cutaway} onClick={() => setCutaway(!cutaway)} title="Architectural cutaway (C)" aria-pressed={cutaway}>
        <Eye size={15} />
      </button>
      <button className="icon-btn" data-active={layers.overlays} onClick={() => toggle('overlays')} title="Analysis overlays" aria-pressed={layers.overlays}>
        <Waypoints size={15} />
      </button>
      <button className="icon-btn" data-active={layers.grid} onClick={() => toggle('grid')} title="Measurement grid" aria-pressed={layers.grid}>
        <Grid3x3 size={15} />
      </button>
      <button className="icon-btn" data-active={layers.search} onClick={() => toggle('search')} title="Show pathfinding search" aria-pressed={layers.search}>
        <Scan size={15} />
      </button>
      <button className="icon-btn" data-active={layers.labels} onClick={() => toggle('labels')} title="Measurement labels" aria-pressed={layers.labels}>
        <Tag size={15} />
      </button>
    </div>
  );
}
