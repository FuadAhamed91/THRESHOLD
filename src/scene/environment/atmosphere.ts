import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Group,
  SRGBColorSpace,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PMREMGenerator,
  PlaneGeometry,
  PointLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  type WebGLRenderer,
} from 'three';
import { DEFAULT_LAYOUT } from '../../geometry/coordinateSystem';

const WARM = new Color('#ffb06a');
const WARM_SOFT = new Color('#ffc48a');

/** Night sky dome: navy zenith, a faint teal horizon glow and sparse stars. */
export function createSky(): Mesh {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new Color('#01030a') },
      uMid: { value: new Color('#06122a') },
      uHorizon: { value: new Color('#123155') },
      uGlow: { value: new Color('#1c4a6e') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uMid, uHorizon, uGlow;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.25, h));
        col = mix(col, uZenith, smoothstep(0.25, 0.9, h));
        col += uGlow * exp(-abs(h) * 14.0) * 0.55;
        vec3 cell = floor(vDir * 380.0);
        float star = step(0.9975, hash(cell)) * smoothstep(0.08, 0.5, h);
        col += vec3(0.75, 0.85, 1.0) * star * hash(cell + 1.0) * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new Mesh(new SphereGeometry(80, 48, 24), mat);
  sky.name = 'Sky';
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

/**
 * Prefiltered environment for reflections: a dim night gradient with warm
 * rectangles standing in for the lit facade, so metals and the porcelain
 * floor pick up believable highlights.
 */
export function createEnvironment(renderer: WebGLRenderer) {
  const env = new Scene();
  const dome = new Mesh(
    new SphereGeometry(20, 32, 16),
    new ShaderMaterial({
      side: BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader:
        'varying vec3 vP; void main(){ float h = vP.y; vec3 c = mix(vec3(0.05,0.08,0.14), vec3(0.006,0.012,0.03), smoothstep(-0.1,0.8,h)); c = mix(c, vec3(0.012,0.012,0.014), smoothstep(0.0,-0.3,h)); gl_FragColor = vec4(c,1.0);} ',
    }),
  );
  env.add(dome);
  const card = (w: number, h: number, color: string, intensity: number, pos: [number, number, number], rotY = 0) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) }));
    m.position.set(...pos);
    m.rotation.y = rotY;
    m.lookAt(0, pos[1], 0);
    env.add(m);
  };
  card(6, 2.4, '#ffb070', 1.6, [0, 1.8, -9]);
  card(2, 1.2, '#ffd2a0', 3.2, [-6, 3.0, -7]);
  card(9, 0.6, '#5f8fd0', 0.35, [0, 7, 8]);
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035);
  pmrem.dispose();
  env.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    (m.material as MeshBasicMaterial | undefined)?.dispose?.();
  });
  return rt;
}

export function createFog(): FogExp2 {
  return new FogExp2('#050b17', 0.026);
}

function gradientTexture(kind: 'radial' | 'edge'): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad =
    kind === 'radial' ? g.createRadialGradient(64, 64, 0, 64, 64, 64) : g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, 'rgba(255,190,120,1)');
  grad.addColorStop(kind === 'radial' ? 0.35 : 0.25, 'rgba(255,170,100,0.45)');
  grad.addColorStop(1, 'rgba(255,150,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * Light pools under the path bollards and the warm wash the handrail LEDs throw
 * on the ramp deck: additive floor decals instead of a dozen point lights.
 */
function createLightPools(): Group {
  const L = DEFAULT_LAYOUT;
  const pools = new Group();
  pools.name = 'LightPools';
  const radial = new MeshBasicMaterial({ map: gradientTexture('radial'), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.55 });
  for (const b of L.fixtures.bollards) {
    const m = new Mesh(new PlaneGeometry(1.9, 1.9), radial);
    m.rotation.x = -Math.PI / 2;
    m.position.set(b.x, 0.02, b.z);
    m.userData.excludeFromAO = true;
    m.renderOrder = 3;
    pools.add(m);
  }
  const edge = new MeshBasicMaterial({ map: gradientTexture('edge'), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.32 });
  const r = L.ramp;
  const len = Math.hypot(r.zBottom - r.zTop, L.levels.landing);
  const pitch = Math.atan2(L.levels.landing, r.zBottom - r.zTop);
  for (const side of [-1, 1]) {
    const m = new Mesh(new PlaneGeometry(0.42, len), edge);
    // lie on the sloped deck; flip the right-hand strip so its bright edge faces the rail
    m.rotation.set(-Math.PI / 2 + pitch, 0, side > 0 ? Math.PI : 0, 'XYZ');
    m.position.set(side * (r.xMax - 0.21), L.levels.landing / 2 + 0.012, (r.zTop + r.zBottom) / 2);
    m.userData.excludeFromAO = true;
    m.renderOrder = 3;
    pools.add(m);
  }
  return pools;
}

export interface EntranceLights {
  readonly group: Object3D;
  readonly interior: PointLight;
  readonly moon: DirectionalLight;
  readonly spots: SpotLight[];
  /** Overall dimmer for the architectural lighting (cutaway mode lowers it). */
  setArchitecturalLevel(level: number): void;
}

/**
 * Night lighting rig, placed from the same fixture positions the Blender
 * model uses: wall sconces (up/down wash), canopy downlights, path bollards,
 * handrail LED strips, the foyer pendant and a cool moon key.
 */
export function createLights(quality: 'high' | 'balanced'): EntranceLights {
  const group = new Object3D();
  group.name = 'Lights';
  const L = DEFAULT_LAYOUT;
  const spots: SpotLight[] = [];
  const base = new Map<Object3D, number>();
  const track = <T extends { intensity: number } & Object3D>(l: T): T => {
    base.set(l, l.intensity);
    group.add(l);
    return l;
  };

  track(new HemisphereLight('#2a4a7c', '#0a0c10', 0.55));
  const moon = track(new DirectionalLight('#9db8ff', 0.55));
  moon.position.set(-7, 11, 6);
  moon.target.position.set(0, 0, 2.5);
  group.add(moon.target);
  moon.castShadow = true;
  moon.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
  moon.shadow.camera.left = -7;
  moon.shadow.camera.right = 7;
  moon.shadow.camera.top = 8;
  moon.shadow.camera.bottom = -6;
  moon.shadow.camera.near = 2;
  moon.shadow.camera.far = 30;
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.02;
  moon.shadow.radius = 3;

  // Real lights are kept to the few that matter (every light enlarges every
  // shader); bollard pools and the handrail LED wash are baked-style decals.
  const zf = L.facade.outerZ;
  L.fixtures.sconces.forEach((s, i) => {
    const down = track(new SpotLight(WARM, 14, 7, 0.95, 0.75, 2));
    down.position.set(s.x, s.y - 0.18, s.z + 0.02);
    down.target.position.set(s.x, 0, zf + 0.9);
    group.add(down.target);
    down.castShadow = i === 0 && quality === 'high';
    down.shadow.mapSize.set(1024, 1024);
    down.shadow.bias = -0.0006;
    down.shadow.normalBias = 0.02;
    down.shadow.camera.near = 0.05;
    spots.push(down);
    const up = track(new SpotLight(WARM_SOFT, 9, 4, 0.55, 0.85, 2));
    up.position.set(s.x, s.y + 0.18, s.z + 0.01);
    up.target.position.set(s.x, 4, zf + 0.25);
    group.add(up.target);
    spots.push(up);
  });

  L.fixtures.downlights.forEach((d, i) => {
    if (i !== 1) return; // the centre downlight carries the landing; the others are emissive only
    const spot = track(new SpotLight(WARM_SOFT, 30, 7, 1.05, 0.85, 2));
    spot.position.set(d.x, d.y - 0.03, d.z);
    spot.target.position.set(d.x, 0, d.z + 0.15);
    group.add(spot.target);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0005;
    spot.shadow.normalBias = 0.02;
    spot.shadow.camera.near = 0.1;
    spots.push(spot);
  });

  const fx = L.fixtures.interior;
  const interior = track(new PointLight('#ffb36b', 3.2, 6, 2));
  interior.position.set(fx.x, fx.y - 0.2, fx.z);

  const pools = createLightPools();
  group.add(pools);

  return {
    group,
    interior,
    moon,
    spots,
    setArchitecturalLevel(level: number) {
      for (const [light, intensity] of base) {
        if (light === moon) continue;
        (light as unknown as { intensity: number }).intensity = intensity * level;
      }
    },
  };
}
