import { HalfFloatType, Vector2, WebGLRenderTarget, type Camera, type Material, type Mesh, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// GTAOPass hides points/lines during its G-buffer pass via these (untyped) hooks.
type VisibilityHooks = { _overrideVisibility(): void; _restoreVisibility(): void };
const gtaoBase = GTAOPass.prototype as unknown as VisibilityHooks;

/** GTAO that ignores analytical overlays and faded (transparent) architecture. */
class SceneAOPass extends GTAOPass {
  private hidden: Object3D[] = [];
  _overrideVisibility(): void {
    gtaoBase._overrideVisibility.call(this);
    (this.scene as Scene).traverseVisible((obj) => {
      const mesh = obj as Mesh;
      if (obj.userData.excludeFromAO) {
        this.hidden.push(obj);
        return;
      }
      if (!mesh.isMesh) return;
      const mat = mesh.material as Material | Material[];
      const mats = Array.isArray(mat) ? mat : [mat];
      if (mats.some((m) => m.transparent && m.opacity < 0.98)) this.hidden.push(obj);
    });
    for (const o of this.hidden) o.visible = false;
  }
  _restoreVisibility(): void {
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
    gtaoBase._restoreVisibility.call(this);
  }
}

/**
 * Safety net before bloom: a single NaN/Inf pixel would otherwise be blurred
 * across the whole frame by the bloom mip chain.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 48.0), c.a);
    }
  `,
};

/** Filmic grade: gentle contrast, cool shadows / warm highlights, vignette, fine grain. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.025 },
    uSaturation: { value: 1.04 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uSaturation;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      // split tone in linear HDR before tone mapping
      vec3 shadowTint = vec3(0.92, 0.98, 1.08);
      vec3 highTint = vec3(1.05, 1.0, 0.94);
      c.rgb *= mix(shadowTint, highTint, smoothstep(0.02, 0.6, l));
      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * smoothstep(0.25, 0.85, length(d * vec2(1.15, 1.0)));
      c.rgb *= vig;
      c.rgb += (hash(vUv * 1024.0 + uTime) - 0.5) * uGrain * (0.25 + l);
      gl_FragColor = c;
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly ao: GTAOPass;
  readonly bloom: UnrealBloomPass;
  private grade: ShaderPass;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number, quality: 'high' | 'balanced') {
    const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: quality === 'high' ? 4 : 0 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new SceneAOPass(scene, camera, width, height);
    this.ao.blendIntensity = 0.75;
    this.ao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: quality === 'high' ? 12 : 8, distanceFallOff: 1 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: quality === 'high' ? 12 : 8 });
    this.composer.addPass(this.ao);
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(new Vector2(width, height), 0.42, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  setAOEnabled(enabled: boolean): void {
    this.ao.enabled = enabled;
  }

  render(time: number): void {
    this.grade.uniforms.uTime.value = time % 100;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
