import {
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from 'three';

const W = 640;
const H = 400;

const lensMaterial = new ShaderMaterial({
  uniforms: { tSrc: { value: null }, uK: { value: 0.32 }, uExposure: { value: 1.25 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc; uniform float uK, uExposure; varying vec2 vUv;
    vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    void main() {
      vec2 c = (vUv - 0.5) * 2.0;
      float r2 = dot(c, c);
      vec2 uv = 0.5 + 0.5 * c * (1.0 + uK * r2) / (1.0 + uK * 2.0);
      vec3 col = texture2D(tSrc, uv).rgb * uExposure;
      col = aces(col);
      col = pow(col, vec3(1.0 / 2.2));
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 0.82) * vec3(0.98, 1.0, 1.03);
      col *= 1.0 - 0.55 * smoothstep(0.6, 1.45, length(c));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});

/**
 * Render what the front-door camera would see, from the doorbell lens in the
 * 3D model, through a wide-angle lens profile. Used ONLY as a clearly labelled
 * simulated view; a live Ring snapshot replaces it when the integration is
 * configured.
 */
export async function renderDoorbellView(
  renderer: WebGLRenderer,
  scene: Scene,
  lens: Vector3,
  lookAt: Vector3,
  hide: Object3D[],
  stamp: { title: string; time: string; footer: string },
): Promise<string> {
  const cam = new PerspectiveCamera(108, W / H, 0.02, 60);
  const dir = lookAt.clone().sub(lens).normalize();
  cam.position.copy(lens).addScaledVector(dir, 0.03);
  cam.lookAt(lookAt);
  cam.updateMatrixWorld();

  const hdr = new WebGLRenderTarget(W, H, { type: HalfFloatType });
  const ldr = new WebGLRenderTarget(W, H, { type: UnsignedByteType });
  const restore = hide.map((o) => [o, o.visible] as const);
  for (const o of hide) o.visible = false;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(hdr);
  renderer.clear();
  renderer.render(scene, cam);
  for (const [o, v] of restore) o.visible = v;

  lensMaterial.uniforms.tSrc.value = hdr.texture;
  const quad = new Mesh(new PlaneGeometry(2, 2), lensMaterial);
  const post = new Scene();
  post.add(quad);
  renderer.setRenderTarget(ldr);
  renderer.render(post, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(prevTarget);
  const pixels = new Uint8Array(W * H * 4);
  // Asynchronous readback (PBO + fence): never stalls the main thread on the GPU.
  await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, W, H, pixels);
  hdr.dispose();
  ldr.dispose();
  quad.geometry.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  // CPU-backed canvas + async encode: no synchronous GPU readback on the main thread.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    img.data.set(pixels.subarray(src, src + W * 4), y * W * 4);
  }
  ctx.putImageData(img, 0, 0);
  ctx.font = '600 15px "JetBrains Mono Variable", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillText(stamp.title, 16, 28);
  const tw = ctx.measureText(stamp.time).width;
  ctx.fillText(stamp.time, W - tw - 16, 28);
  ctx.font = '500 12px "JetBrains Mono Variable", monospace';
  ctx.fillStyle = 'rgba(255,214,140,0.95)';
  ctx.fillText(stamp.footer, 16, H - 16);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  return blob ? URL.createObjectURL(blob) : '';
}
