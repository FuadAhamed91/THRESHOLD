import {
  BoxGeometry,
  DoubleSide,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEFAULT_LAYOUT } from '../../geometry/coordinateSystem';
import { buildFallbackEntrance } from './fallbackEntrance';

export interface EntranceAssets {
  readonly root: Object3D;
  readonly doorPivot: Object3D;
  readonly parcel: Object3D;
  readonly cutaway: Mesh[];
  readonly markers: Map<string, Vector3>;
  readonly avatar: Object3D;
  /** True when the Blender GLB failed to load and a procedural massing model is shown. */
  readonly fallback: boolean;
}

const ENTRANCE_URL = '/models/threshold_entrance.glb';
const AVATAR_URL = '/models/wheelchair_avatar.glb';

function tuneMaterial(mat: Material): void {
  const m = mat as MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return;
  const name = m.name;
  if (name === 'M_Grass') m.side = DoubleSide;
  if (name === 'M_Tile' || name === 'M_Pavers') {
    m.envMapIntensity = 0.9;
    m.roughness = 1;
  }
  if (name === 'M_Stone') m.normalScale.setScalar(1.25);
  if (name === 'M_InteriorGlow') m.emissiveIntensity = 0.32;
  if (name === 'M_LED') m.emissiveIntensity = 0.85;
  if (name === 'M_SconceGlow') m.emissiveIntensity = 6;
  if (name === 'M_RingBlue') m.emissiveIntensity = 7;
  if (name === 'M_Pendant') m.emissiveIntensity = 5;
  if (name === 'M_MetalBlack' || name === 'M_Bronze' || name === 'M_Aluminium') m.envMapIntensity = 1.4;
}

export async function loadAssets(onProgress: (p: number) => void): Promise<EntranceAssets> {
  const manager = new LoadingManager();
  manager.onProgress = (_url, loaded, total) => onProgress(total ? loaded / total : 0);
  const draco = new DRACOLoader(manager);
  draco.setDecoderPath(DRACO_GLTF_CONFIG); // decoder shipped with three.js, bundled by Vite
  draco.preload();
  const loader = new GLTFLoader(manager);
  loader.setDRACOLoader(draco);

  const [entrance, avatar] = await Promise.allSettled([loader.loadAsync(ENTRANCE_URL), loader.loadAsync(AVATAR_URL)]);
  draco.dispose();

  let root: Object3D;
  let fallback = false;
  if (entrance.status === 'fulfilled') {
    root = entrance.value.scene;
  } else {
    console.warn('[THRESHOLD] entrance GLB failed to load, using procedural fallback', entrance.reason);
    root = buildFallbackEntrance();
    fallback = true;
  }
  root.name = 'Entrance';

  const cutaway: Mesh[] = [];
  const markers = new Map<string, Vector3>();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (/^(LIGHT_|CAM_)/.test(obj.name)) markers.set(obj.name, obj.getWorldPosition(new Vector3()));
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach(tuneMaterial);
    const emissive = mats.some((m) => (m as MeshStandardMaterial).emissiveIntensity > 1 && (m as MeshStandardMaterial).emissive?.getHex() !== 0);
    const isGround = /^(Lawn|Garden_Beds|Planter_Soil)/.test(mesh.name);
    mesh.castShadow = !emissive && !isGround && !/^(Grasses|Background_Foliage|Upper_|Roof)/.test(mesh.name);
    mesh.receiveShadow = !emissive;
    const role = mesh.userData.threshold_role ?? mesh.parent?.userData?.threshold_role;
    if (role === 'cutaway') cutaway.push(mesh);
  });

  const doorPivot = root.getObjectByName('Door_Pivot') ?? new Group();
  let parcel = root.getObjectByName('Parcel');
  if (!parcel) {
    const s = DEFAULT_LAYOUT.parcel.size;
    const geo = new BoxGeometry(s.width, s.height, s.depth);
    geo.translate(0, s.height / 2, 0);
    parcel = new Mesh(geo, new MeshStandardMaterial({ color: '#a0703f', roughness: 0.85 }));
    parcel.name = 'Parcel';
    root.add(parcel);
  }
  parcel.castShadow = true;

  let avatarRoot: Object3D;
  if (avatar.status === 'fulfilled') {
    avatarRoot = avatar.value.scene;
  } else {
    console.warn('[THRESHOLD] avatar GLB failed to load', avatar.reason);
    avatarRoot = new Group();
    const body = new Mesh(new BoxGeometry(0.66, 1.2, 1.0), new MeshStandardMaterial({ color: '#7fa7ff' }));
    body.position.y = 0.6;
    avatarRoot.add(body);
  }
  avatarRoot.name = 'Avatar';
  onProgress(1);
  return { root, doorPivot, parcel, cutaway, markers, avatar: avatarRoot, fallback };
}
