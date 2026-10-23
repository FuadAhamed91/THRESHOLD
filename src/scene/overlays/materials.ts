import { AdditiveBlending, Color, DoubleSide, NormalBlending, ShaderMaterial, Vector2, type ColorRepresentation } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * Shared uniforms for every analytical overlay: time for flow animation and a
 * scan front (plan z) used by the "analysis sweep".
 */
export const overlayUniforms = {
  uTime: { value: 0 },
  uScanZ: { value: -100 },
  uScanWidth: { value: 0.6 },
};

export const PALETTE = {
  route: '#3b8bff',
  routeEdge: '#7cc0ff',
  path: '#38d6f5',
  clear: '#34e0a1',
  conflict: '#ff4d61',
  caution: '#ffb547',
  estimate: '#f7c55a',
  neutral: '#9fc4ff',
  safe: '#34e0a1',
  grid: '#5aa9ff',
} as const;

export type FillPattern = 'solid' | 'hatch' | 'flow' | 'grid' | 'dots';
const PATTERN_ID: Record<FillPattern, number> = { solid: 0, hatch: 1, flow: 2, grid: 3, dots: 4 };

export interface FillOptions {
  color: ColorRepresentation;
  opacity?: number;
  intensity?: number;
  pattern?: FillPattern;
  flowDir?: [number, number];
  additive?: boolean;
}

/**
 * Floor-projected fill. Patterns are computed in world space so they stay
 * stable as geometry is rebuilt. `uReveal` grows the fill radially from
 * `uRevealOrigin` for draw-on animations.
 */
export function createFillMaterial(opts: FillOptions): ShaderMaterial {
  const mat = new ShaderMaterial({
    uniforms: {
      ...overlayUniforms,
      uColor: { value: new Color(opts.color) },
      uOpacity: { value: opts.opacity ?? 0.22 },
      uIntensity: { value: opts.intensity ?? 1.4 },
      uPattern: { value: PATTERN_ID[opts.pattern ?? 'solid'] },
      uFlowDir: { value: new Vector2(...(opts.flowDir ?? [0, -1])) },
      uFade: { value: 1 },
      uReveal: { value: 1 },
      uRevealOrigin: { value: new Vector2(0, 0) },
      uRevealRadius: { value: 12 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity, uIntensity, uTime, uFade, uReveal, uRevealRadius, uScanZ, uScanWidth;
      uniform int uPattern;
      uniform vec2 uFlowDir, uRevealOrigin;
      varying vec3 vWorld;
      void main() {
        vec2 p = vWorld.xz;
        float a = 1.0;
        if (uPattern == 1) {
          float s = fract((p.x + p.y) * 9.0);
          a = 0.45 + 0.55 * smoothstep(0.42, 0.5, s) * (1.0 - smoothstep(0.82, 0.9, s));
        } else if (uPattern == 2) {
          float along = dot(p, normalize(uFlowDir));
          float across = dot(p, vec2(-uFlowDir.y, uFlowDir.x));
          float chev = fract(along * 1.6 - abs(across) * 1.2 - uTime * 0.55);
          a = 0.55 + 0.45 * smoothstep(0.0, 0.08, chev) * (1.0 - smoothstep(0.18, 0.3, chev));
        } else if (uPattern == 3) {
          vec2 g = abs(fract(p * 10.0 - 0.5) - 0.5) / max(fwidth(p * 10.0), vec2(1e-4));
          vec2 G = abs(fract(p * 2.0 - 0.5) - 0.5) / max(fwidth(p * 2.0), vec2(1e-4));
          float minor = 1.0 - min(min(g.x, g.y), 1.0);
          float major = 1.0 - min(min(G.x, G.y), 1.0);
          a = minor * 0.35 + major * 0.9;
        } else if (uPattern == 4) {
          vec2 c = fract(p * 8.0) - 0.5;
          a = 1.0 - smoothstep(0.08, 0.14, length(c));
        }
        float d = distance(p, uRevealOrigin);
        float reveal = 1.0 - smoothstep(uReveal * uRevealRadius - 0.25, uReveal * uRevealRadius, d);
        float sd = (p.y - uScanZ) / max(uScanWidth, 0.01);
        float scan = exp(-sd * sd);
        vec3 col = uColor * (uIntensity + scan * 2.5);
        float alpha = uOpacity * a * reveal * uFade + scan * 0.25 * uFade * reveal;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: opts.additive ? AdditiveBlending : NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  mat.userData.overlay = true;
  return mat;
}

const lineMaterials = new Set<LineMaterial>();

export interface LineOptions {
  color: ColorRepresentation;
  width?: number; // pixels
  opacity?: number;
  intensity?: number;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  depthTest?: boolean;
}

/** Screen-space fat line; colour may exceed 1 so it blooms. */
export function createLineMaterial(opts: LineOptions): LineMaterial {
  const color = new Color(opts.color).multiplyScalar(opts.intensity ?? 1.6);
  const mat = new LineMaterial({
    color: color.getHex(),
    linewidth: opts.width ?? 2,
    transparent: true,
    opacity: opts.opacity ?? 0.95,
    dashed: opts.dashed ?? false,
    dashSize: opts.dashSize ?? 0.12,
    gapSize: opts.gapSize ?? 0.08,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    worldUnits: false,
  });
  // getHex() clamps; restore HDR intensity for bloom.
  mat.color.copy(color);
  mat.resolution.set(window.innerWidth, window.innerHeight);
  lineMaterials.add(mat);
  mat.addEventListener('dispose', () => lineMaterials.delete(mat));
  return mat;
}

export function setLineResolution(width: number, height: number): void {
  for (const m of lineMaterials) m.resolution.set(width, height);
}

/** Marker points (A* exploration) revealed in visiting order. */
export function createSearchMaterial(color: ColorRepresentation): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uProgress: { value: 0 },
      uCount: { value: 1 },
      uSize: { value: 5 },
      uFade: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aOrder;
      uniform float uProgress, uCount, uSize, uPixelRatio;
      varying float vAge;
      void main() {
        float shown = uProgress * uCount;
        vAge = clamp((shown - aOrder) / (uCount * 0.08 + 1.0), 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(-mv.z, 0.5);
        gl_PointSize = aOrder <= shown ? min(uSize * uPixelRatio * (0.6 + 0.4 * (1.0 - vAge)) * (6.0 / depth), 14.0 * uPixelRatio) : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFade;
      varying float vAge;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c);
        if (r > 0.5) discard;
        float glow = 1.0 - smoothstep(0.1, 0.5, r);
        float alpha = glow * mix(0.95, 0.22, vAge) * uFade;
        gl_FragColor = vec4(uColor * mix(3.0, 1.2, vAge), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
