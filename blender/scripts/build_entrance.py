"""THRESHOLD asset build: calibrated entrance + wheelchair avatar → GLB.

Run (from the repository root):
    blender -b --factory-startup --python blender/scripts/build_entrance.py

Every dimension comes from src/config/entrance-layout.json, the same file the
geometry engine reads, so the rendered architecture and the analysed plan agree
to the millimetre. Coordinates below are written in the app's world frame
(Three.js: X right, Y up, Z toward the street) and converted with B().

Outputs
    public/models/threshold_entrance.glb   architecture, door, route, parcel, props
    public/models/wheelchair_avatar.glb    avatar with separately animatable wheels
    blender/source/threshold_entrance.blend (reproducible; not committed)
"""
from __future__ import annotations

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import avatar  # noqa: E402
import textures as tex  # noqa: E402
from bhelpers import (  # noqa: E402
    MATS, TEX, B, add_blob, add_box, add_cylinder, add_prism, add_torus, box_object, box_uv, coll,
    curve_tube, empty, export_glb, fit_uv, material, reset_scene, save_image, stats, text_object, to_object,
)

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def _arg(name: str, default: str) -> str:
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return argv[argv.index(name) + 1] if name in argv else default


LAYOUT_PATH = _arg('--layout', os.path.join(ROOT, 'src', 'config', 'entrance-layout.json'))
OUT_DIR = _arg('--out', os.path.join(ROOT, 'public', 'models'))
TEX_DIR = os.path.join(ROOT, 'blender', 'cache', 'textures')
SRC_DIR = os.path.join(ROOT, 'blender', 'source')
FAST = '--fast' in sys.argv  # 256 px textures for quick iteration

with open(LAYOUT_PATH, encoding='utf-8') as fh:
    LAY = json.load(fh)

GRADE = LAY['levels']['grade']
TOP = LAY['levels']['landing']


# ── textures & materials ─────────────────────────────────────────────────────

def build_textures() -> None:
    for key, gen in tex.GENERATORS.items():
        d = gen()
        if FAST:
            step = max(1, d['albedo'].shape[0] // 256)
            d = {k: (v[::step, ::step] if isinstance(v, np.ndarray) else v) for k, v in d.items()}
        imgs = {'albedo': save_image(f'{key}_albedo', tex.to_srgb(d['albedo']), 'sRGB', TEX_DIR)}
        if d.get('rough') is not None:
            imgs['rough'] = save_image(f'{key}_rough', np.repeat(d['rough'][..., None], 3, axis=-1), 'Non-Color', TEX_DIR)
        if d.get('normal') is not None:
            imgs['normal'] = save_image(f'{key}_normal', d['normal'], 'Non-Color', TEX_DIR)
        TEX[key] = imgs
        print(f'[textures] {key}', flush=True)


def build_materials() -> None:
    material('M_Stone', tex_key='ledgestone', normal_strength=1.4)
    material('M_Oak', tex_key='smoked_oak', normal_strength=0.8)
    material('M_Tile', tex_key='porcelain', normal_strength=0.8)
    material('M_Pavers', tex_key='pavers', normal_strength=0.9)
    material('M_Concrete', tex_key='concrete', normal_strength=0.7)
    material('M_Charcoal', tex_key='charcoal_panel', normal_strength=0.8)
    material('M_Lawn', tex_key='lawn', normal_strength=0.6)
    material('M_Mulch', tex_key='mulch', normal_strength=0.9)
    material('M_Foliage', tex_key='foliage', normal_strength=1.4)
    material('M_Bark', tex_key='bark', normal_strength=1.0)
    material('M_Cardboard', tex_key='cardboard', normal_strength=0.7)
    material('M_Coir', tex_key='coir', normal_strength=1.0)
    material('M_OakFloor', tex_key='oak_floor', normal_strength=0.5)
    material('M_Plaster', tex_key='plaster', normal_strength=0.3)
    material('M_InteriorGlow', tex_key='interior_glow', emission=(1, 1, 1), emission_strength=2.2, emissive_texture=True, rough=0.25)
    material('M_Grass', vcol=True, rough=0.7)
    material('M_MetalBlack', color=(0.018, 0.018, 0.02), metal=0.65, rough=0.42)
    material('M_Bronze', color=(0.32, 0.21, 0.12), metal=1.0, rough=0.3)
    material('M_Aluminium', color=(0.72, 0.72, 0.74), metal=1.0, rough=0.32)
    material('M_PlasticBlack', color=(0.012, 0.012, 0.014), rough=0.22)
    material('M_Lens', color=(0.0, 0.0, 0.0), rough=0.05, metal=0.2)
    material('M_LED', color=(1.0, 0.78, 0.5), emission=(1.0, 0.72, 0.42), emission_strength=14.0)
    material('M_SconceGlow', color=(1.0, 0.8, 0.55), emission=(1.0, 0.7, 0.4), emission_strength=18.0)
    material('M_RingBlue', color=(0.25, 0.65, 1.0), emission=(0.2, 0.62, 1.0), emission_strength=7.0)
    material('M_Pendant', color=(1.0, 0.85, 0.6), emission=(1.0, 0.72, 0.42), emission_strength=9.0)
    material('M_Artwork', color=(0.55, 0.32, 0.18), rough=0.6)


# ── architecture ─────────────────────────────────────────────────────────────

def slab_with_openings(name, xs, ys, openings, z_front, z_back, mat, collection, uv_scale, role=None):
    """Wall slab in the X–Y plane with rectangular openings, built as one clean manifold."""
    xs, ys = sorted(xs), sorted(ys)
    nx, ny = len(xs) - 1, len(ys) - 1

    def solid(i, j):
        if i < 0 or j < 0 or i >= nx or j >= ny:
            return False
        cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
        return not any(o[0] < cx < o[2] and o[1] < cy < o[3] for o in openings)

    bm = bmesh.new()
    front, back = {}, {}

    def vf(i, j):
        if (i, j) not in front:
            front[(i, j)] = bm.verts.new(B(xs[i], ys[j], z_front))
        return front[(i, j)]

    def vb(i, j):
        if (i, j) not in back:
            back[(i, j)] = bm.verts.new(B(xs[i], ys[j], z_back))
        return back[(i, j)]

    for i in range(nx):
        for j in range(ny):
            if not solid(i, j):
                continue
            bm.faces.new([vf(i, j), vf(i + 1, j), vf(i + 1, j + 1), vf(i, j + 1)])
            bm.faces.new([vb(i, j + 1), vb(i + 1, j + 1), vb(i + 1, j), vb(i, j)])
            if not solid(i - 1, j):
                bm.faces.new([vf(i, j), vf(i, j + 1), vb(i, j + 1), vb(i, j)])
            if not solid(i + 1, j):
                bm.faces.new([vf(i + 1, j + 1), vf(i + 1, j), vb(i + 1, j), vb(i + 1, j + 1)])
            if not solid(i, j - 1):
                bm.faces.new([vf(i + 1, j), vf(i, j), vb(i, j), vb(i + 1, j)])
            if not solid(i, j + 1):
                bm.faces.new([vf(i, j + 1), vf(i + 1, j + 1), vb(i + 1, j + 1), vb(i, j + 1)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    box_uv(bm, uv_scale)
    return to_object(name, bm, mat, collection, smooth=20, role=role)


def glow_panel(name, center, size, collection):
    """Interior-glow glazing: one gradient image stretched across the pane."""
    bm = bmesh.new()
    add_box(bm, center, size)
    fit_uv(bm)
    return to_object(name, bm, MATS['M_InteriorGlow'], collection, smooth=20, role='cutaway')


def build_architecture():
    arch = coll('Architecture')
    fac = LAY['facade']
    door = LAY['doorOpening']
    fw = door['frameWidth']
    zf, zb = fac['outerZ'], fac['outerZ'] - fac['thickness']
    stone = MATS['M_Stone']
    head = TOP + door['height'] + fw
    side_x0, side_x1 = 0.78, 1.18
    win = (2.1, 0.9, 4.0, 2.6)
    openings = [
        (door['xMin'] - fw, TOP, door['xMax'] + fw, head),
        (side_x0, TOP + 0.1, side_x1, head),
        win,
    ]
    xs = [fac['xMin'], door['xMin'] - fw, door['xMax'] + fw, side_x0, side_x1, win[0], win[2], fac['xMax']]
    ys = [GRADE, TOP, TOP + 0.1, win[1], win[3], head, fac['height']]
    slab_with_openings('Facade_Wall', xs, ys, openings, zf, zb, stone, arch, 1 / 1.2, role='cutaway')

    depth = 6.0
    for sx, name in ((fac['xMin'], 'Facade_Side_West'), (fac['xMax'], 'Facade_Side_East')):
        inset = 0.3 if sx > 0 else -0.3
        box_object(name, (sx - inset / 2, fac['height'] / 2, zb - (depth - fac['thickness']) / 2),
                   (0.3, fac['height'], depth - fac['thickness']), stone, arch, uv=1 / 1.2, role='cutaway')
    # roof slab with a thin metal coping
    box_object('Roof_Slab', (0, fac['height'] + 0.075, -depth / 2 + 0.02), (fac['xMax'] - fac['xMin'] + 0.04, 0.15, depth + 0.04),
               MATS['M_Charcoal'], arch, bevel=0.01, uv=1 / 1.2, role='cutaway')
    # set-back upper storey with a glowing window band
    up = box_object('Upper_Volume', (-1.4, fac['height'] + 0.15 + 1.45, -3.6), (6.4, 2.9, 5.0), MATS['M_Charcoal'], arch, uv=1 / 1.2, role='cutaway')
    up['threshold_role'] = 'cutaway'
    glow_panel('Upper_Window', (-1.6, fac['height'] + 1.75, -1.085), (4.4, 1.3, 0.02), arch)
    box_object('Upper_Window_Frame', (-1.6, fac['height'] + 1.75, -1.1), (4.56, 1.46, 0.02), MATS['M_MetalBlack'], arch, role='cutaway')
    mull = bmesh.new()
    for mx in (-2.7, -1.6, -0.5):
        add_box(mull, (mx, fac['height'] + 1.75, -1.07), (0.04, 1.3, 0.03))
    to_object('Upper_Window_Mullions', mull, MATS['M_MetalBlack'], arch, smooth=30, role='cutaway')

    # canopy: cantilevered concrete slab with an oak soffit
    cz0, cz1 = 0.0, 1.9
    box_object('Canopy', (-0.3, 3.115, (cz0 + cz1) / 2), (4.6, 0.23, cz1 - cz0), MATS['M_Concrete'], arch, bevel=0.012, uv=1 / 2.0, role='cutaway')
    box_object('Canopy_Soffit', (-0.3, 2.995, (cz0 + cz1) / 2 + 0.01), (4.5, 0.012, cz1 - cz0 - 0.04), MATS['M_Oak'], arch, uv=1 / 0.6, role='cutaway')

    # ground-floor window and frosted sidelight (interior glow)
    glow_panel('Window_Glass', ((win[0] + win[2]) / 2, (win[1] + win[3]) / 2, zf - 0.14), (win[2] - win[0], win[3] - win[1], 0.02), arch)
    frame_bm = bmesh.new()
    t = 0.05
    for (cx, cy, sx, sy) in (
        ((win[0] + win[2]) / 2, win[1] + t / 2, win[2] - win[0], t),
        ((win[0] + win[2]) / 2, win[3] - t / 2, win[2] - win[0], t),
        (win[0] + t / 2, (win[1] + win[3]) / 2, t, win[3] - win[1]),
        (win[2] - t / 2, (win[1] + win[3]) / 2, t, win[3] - win[1]),
        ((win[0] + win[2]) / 2, (win[1] + win[3]) / 2, 0.04, win[3] - win[1]),
    ):
        add_box(frame_bm, (cx, cy, zf - 0.08), (sx, sy, 0.1), bevel=0.004)
    to_object('Window_Frame', frame_bm, MATS['M_MetalBlack'], arch, smooth=40, role='cutaway')
    glow_panel('Sidelight_Glass', ((side_x0 + side_x1) / 2, (TOP + 0.1 + head) / 2, zf - 0.1), (side_x1 - side_x0, head - TOP - 0.1, 0.02), arch)
    sbm = bmesh.new()
    for (cx, cy, sx, sy) in (
        ((side_x0 + side_x1) / 2, TOP + 0.1 + 0.02, side_x1 - side_x0, 0.04),
        ((side_x0 + side_x1) / 2, head - 0.02, side_x1 - side_x0, 0.04),
        (side_x0 + 0.02, (TOP + 0.1 + head) / 2, 0.04, head - TOP - 0.1),
        (side_x1 - 0.02, (TOP + 0.1 + head) / 2, 0.04, head - TOP - 0.1),
    ):
        add_box(sbm, (cx, cy, zf - 0.05), (sx, sy, 0.08), bevel=0.004)
    to_object('Sidelight_Frame', sbm, MATS['M_MetalBlack'], arch, smooth=40, role='cutaway')

    # vertical oak slat screen
    slat = bmesh.new()
    x = -4.38
    while x < -2.8:
        add_box(slat, (x, 1.85, zf + 0.06), (0.045, 3.1, 0.05), bevel=0.004)
        x += 0.078
    bm_obj = to_object('Slat_Screen', slat, MATS['M_Oak'], arch, smooth=40, role='cutaway')
    _uv_existing(bm_obj, 1 / 0.6)

    text_object('House_Number', '18', 0.2, (-1.55, 1.62, zf + 0.012), MATS['M_Aluminium'], coll('DecorativeProps'), role='cutaway')

    # interior foyer, visible through the open door
    foy = LAY['foyer']
    inner = coll('Architecture')
    box_object('Foyer_Floor', (0, TOP - 0.025, (foy['zMin'] + zb) / 2), (foy['xMax'] - foy['xMin'] + 0.4, 0.05, zb - foy['zMin']),
               MATS['M_OakFloor'], inner, uv=1 / 0.6)
    box_object('Foyer_BackWall', (0, TOP + 1.4, foy['zMin'] - 0.05), (foy['xMax'] - foy['xMin'] + 0.4, 2.8, 0.1), MATS['M_Plaster'], inner, uv=1 / 1.0)
    for sx in (foy['xMin'] - 0.05, foy['xMax'] + 0.05):
        box_object('Foyer_SideWall', (sx, TOP + 1.4, (foy['zMin'] + zb) / 2), (0.1, 2.8, zb - foy['zMin']), MATS['M_Plaster'], inner, uv=1 / 1.0)
    box_object('Foyer_Ceiling', (0, TOP + 2.8, (foy['zMin'] + zb) / 2), (foy['xMax'] - foy['xMin'] + 0.4, 0.05, zb - foy['zMin']), MATS['M_Plaster'], inner, uv=1)
    box_object('Foyer_Artwork', (0.0, TOP + 1.55, foy['zMin'] + 0.012), (0.8, 0.6, 0.02), MATS['M_Artwork'], coll('DecorativeProps'), bevel=0.003)
    fx = LAY['fixtures']['interior']
    pb = bmesh.new()
    add_blob(pb, (fx['x'], fx['y'], fx['z']), 0.11, 3, subdiv=3, roughness=0.0)
    to_object('Foyer_Pendant', pb, MATS['M_Pendant'], coll('Lights'), smooth=60)
    curve_tube('Foyer_Pendant_Cord', [(fx['x'], fx['y'] + 0.1, fx['z']), (fx['x'], TOP + 2.78, fx['z'])], 0.004, MATS['M_MetalBlack'], coll('Lights'))
    empty('LIGHT_Interior', (fx['x'], fx['y'], fx['z']), coll('Lights'))


def _uv_existing(obj, scale):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    box_uv(bm, scale)
    bm.to_mesh(obj.data)
    bm.free()


# ── door ────────────────────────────────────────────────────────────────────

def build_door():
    dcol = coll('Door')
    d = LAY['door']
    op = LAY['doorOpening']
    fw = op['frameWidth']
    zf, zb = LAY['facade']['outerZ'], LAY['facade']['outerZ'] - LAY['facade']['thickness']
    head = TOP + op['height']
    frame = bmesh.new()
    add_box(frame, (op['xMin'] - fw / 2, (TOP + head + fw) / 2, zf - 0.07), (fw, head + fw - TOP, 0.14), bevel=0.004)
    add_box(frame, (op['xMax'] + fw / 2, (TOP + head + fw) / 2, zf - 0.07), (fw, head + fw - TOP, 0.14), bevel=0.004)
    add_box(frame, (0, head + fw / 2, zf - 0.07), (op['xMax'] - op['xMin'] + 2 * fw, fw, 0.14), bevel=0.004)
    to_object('Door_Frame', frame, MATS['M_MetalBlack'], dcol, smooth=40)
    # reveal lining through the wall depth
    lining = bmesh.new()
    add_box(lining, (op['xMin'] - 0.01, (TOP + head) / 2, (zf + zb) / 2 - 0.07), (0.02, head - TOP, zf - zb - 0.14))
    add_box(lining, (op['xMax'] + 0.01, (TOP + head) / 2, (zf + zb) / 2 - 0.07), (0.02, head - TOP, zf - zb - 0.14))
    add_box(lining, (0, head + 0.01, (zf + zb) / 2 - 0.07), (op['xMax'] - op['xMin'], 0.02, zf - zb - 0.14))
    box_uv(lining, 1 / 0.6)
    to_object('Door_Reveal', lining, MATS['M_Oak'], dcol, smooth=20)
    box_object('Door_Threshold', (0, TOP + 0.0025, (zf + zb) / 2), (op['xMax'] - op['xMin'], 0.005, zf - zb + 0.02), MATS['M_Aluminium'], coll('AccessibleRoute'), bevel=0.0015)

    # pivot at the hinge axis: rotate Door_Pivot about Y to open (rotation.y = −θ for this door)
    pivot = empty('Door_Pivot', (d['hinge']['x'], TOP, d['hinge']['z']), dcol, role='door-pivot')
    leaf = bmesh.new()
    w, t, h = d['width'], d['thickness'], d['height']
    add_box(leaf, (w / 2, d['undercut'] + (h - d['undercut']) / 2, -t / 2), (w - 0.004, h - d['undercut'], t), bevel=0.003, segments=2)
    # shallow vertical grooves on the outside face
    box_uv(leaf, 1 / 0.6)
    leaf_obj = to_object('Door_Leaf', leaf, MATS['M_Oak'], dcol, smooth=40, weighted=True, parent=pivot)
    leaf_obj['threshold_role'] = 'door-leaf'
    grooves = bmesh.new()
    for gx in (0.22, 0.44, 0.66, 0.88):
        add_box(grooves, (gx, (h + d['undercut']) / 2 + 0.05, 0.0005), (0.006, h - 0.4, 0.002))
    to_object('Door_Grooves', grooves, MATS['M_MetalBlack'], dcol, smooth=None, parent=pivot)
    hb = bmesh.new()
    hx, off = w - 0.16, 0.065
    add_cylinder(hb, (hx, 0.62, off), (hx, 1.92, off), 0.016, 20)
    add_cylinder(hb, (hx, 0.78, 0.0), (hx, 0.78, off), 0.009, 12)
    add_cylinder(hb, (hx, 1.76, 0.0), (hx, 1.76, off), 0.009, 12)
    add_cylinder(hb, (hx, 1.06, -t), (hx, 1.06, -t - 0.06), 0.012, 12)  # inside lever stub
    to_object('Door_Handle', hb, MATS['M_Bronze'], dcol, smooth=50, parent=pivot)
    lock = bmesh.new()
    add_cylinder(lock, (hx - 0.06, 1.1, 0.0), (hx - 0.06, 1.1, 0.006), 0.017, 20)
    to_object('Door_Lock', lock, MATS['M_Bronze'], dcol, smooth=50, parent=pivot)
    # hinge knuckles on the hinge axis (static, on the frame)
    hinges = bmesh.new()
    for hy in (0.28, 1.2, 2.12):
        add_cylinder(hinges, (d['hinge']['x'], TOP + hy - 0.06, d['hinge']['z'] + 0.006), (d['hinge']['x'], TOP + hy + 0.06, d['hinge']['z'] + 0.006), 0.012, 16)
    to_object('Door_Hinges', hinges, MATS['M_MetalBlack'], dcol, smooth=50)


# ── accessible route: landing, ramp, walkway ─────────────────────────────────

def ramp_y(z):
    r = LAY['ramp']
    if z <= r['zTop']:
        return TOP
    if z >= r['zBottom']:
        return GRADE
    return TOP + (GRADE - TOP) * (z - r['zTop']) / (r['zBottom'] - r['zTop'])


def build_route():
    rc = coll('AccessibleRoute')
    L, R, Wk = LAY['landing'], LAY['ramp'], LAY['walkway']
    tile, conc = MATS['M_Tile'], MATS['M_Concrete']

    def two_material(bm, top_index=0, side_index=1):
        for f in bm.faces:
            f.material_index = top_index if f.normal.z > 0.9 else side_index

    bm = bmesh.new()
    add_box(bm, ((L['xMin'] + L['xMax']) / 2, (GRADE + TOP) / 2 - 0.01, (L['zMin'] + L['zMax']) / 2),
            (L['xMax'] - L['xMin'], TOP - GRADE + 0.02, L['zMax'] - L['zMin']), bevel=0.006)
    bm.normal_update()
    box_uv(bm, 1 / 1.2)
    two_material(bm)
    to_object('Landing', bm, [tile, conc], rc, smooth=40, weighted=True)

    # ramp deck (sloped wedge)
    bm = bmesh.new()
    x0, x1 = R['xMin'], R['xMax']
    pts_b = [(x0, GRADE - 0.02, R['zTop']), (x1, GRADE - 0.02, R['zTop']), (x1, GRADE - 0.02, R['zBottom']), (x0, GRADE - 0.02, R['zBottom'])]
    vb = [bm.verts.new(B(*p)) for p in pts_b]
    vt = [bm.verts.new(B(x0, TOP, R['zTop'])), bm.verts.new(B(x1, TOP, R['zTop'])), bm.verts.new(B(x1, GRADE + 0.001, R['zBottom'])), bm.verts.new(B(x0, GRADE + 0.001, R['zBottom']))]
    bm.faces.new(list(reversed(vb)))
    bm.faces.new(vt)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    box_uv(bm, 1 / 1.2)
    for f in bm.faces:
        f.material_index = 0 if f.normal.z > 0.9 else 1
    to_object('Ramp_Deck', bm, [tile, conc], rc, smooth=20)

    # curbs / side walls of the ramp (edge protection, 100 mm upstand)
    for side in (-1, 1):
        cx0 = x1 if side > 0 else x0 - R['curbWidth']
        cx1 = cx0 + R['curbWidth']
        bm = bmesh.new()
        zs = [L['zMax'] - 0.0, R['zBottom']]
        bottom = [(cx0, GRADE - 0.02, zs[0]), (cx1, GRADE - 0.02, zs[0]), (cx1, GRADE - 0.02, zs[1]), (cx0, GRADE - 0.02, zs[1])]
        top = [(cx0, ramp_y(zs[0]) + R['curbHeight'], zs[0]), (cx1, ramp_y(zs[0]) + R['curbHeight'], zs[0]),
               (cx1, ramp_y(zs[1]) + R['curbHeight'] * 0.5, zs[1]), (cx0, ramp_y(zs[1]) + R['curbHeight'] * 0.5, zs[1])]
        add_prism(bm, bottom, top)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.normal_update()
        box_uv(bm, 1 / 2.0)
        to_object(f'Ramp_Curb_{"E" if side > 0 else "W"}', bm, conc, rc, smooth=20)

    # walkway pavers continuing to the street
    bm = bmesh.new()
    add_box(bm, (0, GRADE - 0.03, (Wk['zMin'] + 12.0) / 2), (Wk['xMax'] - Wk['xMin'], 0.06, 12.0 - Wk['zMin']), bevel=0.004)
    bm.normal_update()
    box_uv(bm, 1 / 1.2)
    two_material(bm)
    to_object('Walkway', bm, [MATS['M_Pavers'], conc], rc, smooth=40, weighted=True)


# ── railings ────────────────────────────────────────────────────────────────

def build_railings():
    rc = coll('Railings')
    R, L = LAY['ramp'], LAY['landing']
    metal = MATS['M_MetalBlack']
    hr = R['handrailHeight']
    posts = bmesh.new()
    bars = bmesh.new()
    leds = bmesh.new()
    for side in (-1, 1):
        x = side * (R['xMax'] + R['curbWidth'] / 2)
        # top handrail: 300 mm horizontal extensions at both ends, with returns
        zt0, zt1 = L['zMax'] - 0.30, R['zBottom'] + 0.30
        rail = [
            (x, TOP + hr - 0.12, zt0), (x, TOP + hr, zt0 + 0.02), (x, TOP + hr, R['zTop']),
            (x, GRADE + hr, R['zBottom']), (x, GRADE + hr, zt1 - 0.02), (x, GRADE + hr - 0.12, zt1),
        ]
        curve_tube(f'Handrail_{"E" if side > 0 else "W"}', rail, 0.021, metal, rc)
        low = [(x, TOP + 0.24, R['zTop'] + 0.02), (x, GRADE + 0.24, R['zBottom'] - 0.02)]
        curve_tube(f'Rail_Lower_{"E" if side > 0 else "W"}', low, 0.012, metal, rc)
        for z in (R['zTop'] + 0.06, R['zTop'] + 1.2, R['zTop'] + 2.4, R['zBottom'] - 0.06):
            y0 = ramp_y(z) + R['curbHeight'] * 0.6
            add_box(posts, (x, (y0 + ramp_y(z) + hr) / 2, z), (0.04, ramp_y(z) + hr - y0, 0.04), bevel=0.003)
        z = R['zTop'] + 0.11
        while z < R['zBottom'] - 0.08:
            y0 = ramp_y(z) + 0.24
            y1 = ramp_y(z) + hr - 0.03
            add_box(bars, (x, (y0 + y1) / 2, z), (0.012, y1 - y0, 0.03))
            z += 0.115
        # LED strip on the underside of the handrail, facing the deck
        inner = x - side * 0.008
        a, b = Vector((inner, TOP + hr - 0.024, R['zTop'])), Vector((inner, GRADE + hr - 0.024, R['zBottom']))
        add_cylinder(leds, tuple(a), tuple(b), 0.0095, 10)
    # guard rails along the open front edges of the landing
    for side in (-1, 1):
        xa, xb = side * (R['xMax'] + R['curbWidth']), side * L['xMax']
        lo, hi = min(xa, xb), max(xa, xb)
        zr = L['zMax'] - 0.03
        gh = 1.07
        curve_tube(f'Guard_Top_{"E" if side > 0 else "W"}', [(lo, TOP + gh, zr), (hi, TOP + gh, zr)], 0.021, metal, rc)
        curve_tube(f'Guard_Low_{"E" if side > 0 else "W"}', [(lo, TOP + 0.12, zr), (hi, TOP + 0.12, zr)], 0.012, metal, rc)
        for px in (lo + 0.03, hi - 0.03):
            add_box(posts, (px, TOP + gh / 2, zr), (0.04, gh, 0.04), bevel=0.003)
        xx = lo + 0.1
        while xx < hi - 0.06:
            add_box(bars, (xx, TOP + 0.12 + (gh - 0.15) / 2, zr), (0.03, gh - 0.15, 0.012))
            xx += 0.115
    to_object('Railing_Posts', posts, metal, rc, smooth=40)
    to_object('Railing_Balusters', bars, metal, rc, smooth=30)
    to_object('Railing_LED', leds, MATS['M_LED'], coll('Lights'), smooth=60)


# ── vegetation ──────────────────────────────────────────────────────────────

def grass_clump(bm, col_layer, base_app, radius, blades, height, seed):
    rng = np.random.default_rng(seed)
    for _ in range(blades):
        ang = rng.uniform(0, 2 * math.pi)
        rr = radius * math.sqrt(rng.uniform(0, 1))
        bx, bz = base_app[0] + math.cos(ang) * rr, base_app[2] + math.sin(ang) * rr
        h = height * rng.uniform(0.55, 1.0)
        lean = rng.uniform(0.15, 0.55) * h
        dirx, dirz = math.cos(ang + rng.uniform(-0.6, 0.6)), math.sin(ang + rng.uniform(-0.6, 0.6))
        width = rng.uniform(0.007, 0.012)
        side = Vector((-dirz, 0, dirx))
        segs = 5
        left, right = [], []
        for s in range(segs + 1):
            t = s / segs
            px = bx + dirx * lean * t * t
            pz = bz + dirz * lean * t * t
            py = base_app[1] + h * (t - 0.18 * t * t)
            w = width * (1 - t) + 0.0008
            left.append(bm.verts.new(B(px - side.x * w, py, pz - side.z * w)))
            right.append(bm.verts.new(B(px + side.x * w, py, pz + side.z * w)))
        for s in range(segs):
            f = bm.faces.new([left[s], right[s], right[s + 1], left[s + 1]])
            for loop in f.loops:
                idx = (left + right).index(loop.vert) % (segs + 1)
                t = idx / segs
                base = np.array([0.03, 0.045, 0.02])
                tip = np.array([0.30, 0.27, 0.12]) * rng.uniform(0.8, 1.15)
                c = base * (1 - t) + tip * t
                loop[col_layer] = (float(c[0]), float(c[1]), float(c[2]), 1.0)


def build_vegetation():
    vc = coll('Vegetation')
    foliage, mulch = MATS['M_Foliage'], MATS['M_Mulch']
    L, R = LAY['landing'], LAY['ramp']
    # raised side planters flanking the landing
    planter_walls = bmesh.new()
    soil = bmesh.new()
    for side in (-1, 1):
        x0 = L['xMax'] if side > 0 else -L['xMax'] - 1.0
        x1 = x0 + 1.0
        z0, z1 = 0.0, 2.3
        ht = 0.75
        for (cx, cz, sx, sz) in (
            ((x0 + x1) / 2, z1 - 0.04, x1 - x0, 0.08),
            ((x0 + x1) / 2, z0 + 0.04, x1 - x0, 0.08),
            (x0 + 0.04, (z0 + z1) / 2, 0.08, z1 - z0),
            (x1 - 0.04, (z0 + z1) / 2, 0.08, z1 - z0),
        ):
            add_box(planter_walls, (cx, ht / 2, cz), (sx, ht, sz), bevel=0.008)
        add_box(soil, ((x0 + x1) / 2, ht - 0.07, (z0 + z1) / 2), (x1 - x0 - 0.16, 0.02, z1 - z0 - 0.16))
    box_uv(planter_walls, 1 / 2.0)
    to_object('Planter_Walls', planter_walls, MATS['M_Concrete'], vc, smooth=40, weighted=True)
    box_uv(soil, 1 / 1.5)
    to_object('Planter_Soil', soil, mulch, vc, smooth=None)

    # pots on the landing (positions are analysis obstacles)
    pots = bmesh.new()
    balls = bmesh.new()
    for i, p in enumerate(LAY['planters']):
        c, s, h = p['center'], p['size'], p['height']
        add_box(pots, (c['x'], TOP + h / 2, c['z']), (s, h, s), bevel=0.012, segments=3)
        add_blob(balls, (c['x'], TOP + h + 0.24, c['z']), 0.31, 10 + i, subdiv=4, roughness=0.12)
    box_uv(pots, 1 / 1.2)
    to_object('Planter_Pots', pots, MATS['M_Charcoal'], coll('DecorativeProps'), smooth=40, weighted=True)
    box_uv(balls, 1 / 0.5)
    to_object('Topiary_Pots', balls, foliage, vc, smooth=70)

    # garden beds at grade beside the ramp
    beds = bmesh.new()
    for side in (-1, 1):
        x0 = R['xMax'] + R['curbWidth'] if side > 0 else -3.6
        x1 = 3.6 if side > 0 else -(R['xMax'] + R['curbWidth'])
        add_box(beds, ((x0 + x1) / 2, GRADE + 0.005, (2.3 + 5.6) / 2), (x1 - x0, 0.02, 5.6 - 2.3))
        add_box(beds, ((x0 + x1) / 2, GRADE + 0.005, (-0.0 + 2.3) / 2), (x1 - x0, 0.02, 2.3))
    box_uv(beds, 1 / 1.5)
    to_object('Garden_Beds', beds, mulch, vc, smooth=None)

    # grasses, shrubs, topiary in planters and beds
    gbm = bmesh.new()
    col = gbm.loops.layers.color.new('Col')
    clumps = []
    for side in (-1, 1):
        sx = L['xMax'] + 0.5 if side > 0 else -L['xMax'] - 0.5
        for i, zz in enumerate((0.35, 0.95, 1.6)):
            clumps.append(((sx + side * (0.12 if i % 2 else -0.1), 0.68, zz), 0.2, 70, 0.85))
        for i, zz in enumerate((2.75, 3.4, 4.1, 4.8)):
            bx = side * (1.6 + 0.35 * (i % 2))
            clumps.append(((bx, GRADE, zz), 0.26, 80, 0.95))
        for i, zz in enumerate((5.3,)):
            clumps.append(((side * 2.3, GRADE, zz), 0.3, 80, 1.0))
    for i, (base, rad, nb, hh) in enumerate(clumps):
        grass_clump(gbm, col, base, rad, nb, hh, seed=100 + i)
    to_object('Grasses', gbm, MATS['M_Grass'], vc, smooth=80)

    shrubs = bmesh.new()
    shrub_spots = [(-1.15, 2.6), (1.15, 2.7), (-2.6, 2.5), (2.8, 3.0), (-3.0, 5.3), (3.1, 5.0), (-1.25, 5.2), (1.25, 4.6)]
    for i, (sx, sz) in enumerate(shrub_spots):
        for k in range(3):
            ox = (k - 1) * 0.22
            add_blob(shrubs, (sx + ox, 0.22 + 0.05 * (k % 2), sz + 0.08 * ((k * 7) % 3 - 1)), 0.26 - 0.04 * (k % 2), 30 + i * 3 + k, subdiv=3, roughness=0.2, squash=0.85)
    for i, (sx, sz) in enumerate(((L['xMax'] + 0.5, 1.2), (-L['xMax'] - 0.5, 1.2))):
        add_blob(shrubs, (sx, 0.68 + 0.26, sz), 0.3, 60 + i, subdiv=4, roughness=0.1)
    box_uv(shrubs, 1 / 0.5)
    to_object('Shrubs', shrubs, foliage, vc, smooth=70)

    # multi-stem ornamental tree in the west bed
    trunk = bmesh.new()
    canopy = bmesh.new()
    base = (-2.5, GRADE, 4.0)
    for k, (dx, dz, lean) in enumerate(((0.0, 0.0, 0.1), (0.12, 0.08, -0.25), (-0.1, 0.1, 0.3))):
        pts = []
        for s in range(6):
            t = s / 5
            pts.append((base[0] + dx + lean * t * t * 1.4, base[1] + 2.9 * t, base[2] + dz + 0.25 * t * t * (k - 1)))
        for a, b in zip(pts, pts[1:]):
            add_cylinder(trunk, a, b, 0.05 * (1 - 0.5 * (pts.index(a) / 5)) + 0.012, 10)
    box_uv(trunk, 1 / 0.6)
    to_object('Tree_Trunks', trunk, MATS['M_Bark'], vc, smooth=60)
    for i, (dx, dy, dz, r) in enumerate(((0, 3.0, 0, 0.75), (0.5, 2.7, 0.3, 0.55), (-0.5, 2.8, -0.2, 0.6), (0.2, 3.4, -0.3, 0.55), (-0.25, 2.4, 0.45, 0.45))):
        add_blob(canopy, (base[0] + dx, dy, base[2] + dz), r, 80 + i, subdiv=4, roughness=0.18, squash=0.8)
    box_uv(canopy, 1 / 0.7)
    to_object('Tree_Canopy', canopy, foliage, vc, smooth=70)

    # lawn
    lawn = bmesh.new()
    add_box(lawn, (0, GRADE - 0.03, 4.5), (30.0, 0.04, 21.0))
    box_uv(lawn, 1 / 4.0)
    to_object('Lawn', lawn, MATS['M_Lawn'], vc, smooth=None)
    # boundary hedges and distant tree masses (silhouettes in the night fog)
    bg = bmesh.new()
    for side in (-1, 1):
        add_box(bg, (side * 6.2, 0.8, 4.0), (0.9, 1.6, 12.0), bevel=0.25, segments=3)
    for i, (x, z, r, y) in enumerate(((-8.5, -2.0, 2.4, 3.2), (8.8, -1.0, 2.6, 3.4), (-6.0, -9.0, 3.4, 5.0), (4.0, -10.0, 3.8, 5.6),
                                       (-1.5, -11.0, 3.2, 6.4), (10.5, 6.0, 2.2, 2.6), (-10.5, 7.0, 2.4, 2.8))):
        add_blob(bg, (x, y, z), r, 200 + i, subdiv=3, roughness=0.3, squash=1.1)
    box_uv(bg, 1 / 1.2)
    to_object('Background_Foliage', bg, foliage, vc, smooth=70)


# ── lights (fixtures) & doorbell ─────────────────────────────────────────────

def build_fixtures():
    lc = coll('Lights')
    fx = LAY['fixtures']
    zf = LAY['facade']['outerZ']
    body = bmesh.new()
    glow = bmesh.new()
    for i, s in enumerate(fx['sconces']):
        x, y = s['x'], s['y']
        add_box(body, (x, y, zf + 0.025), (0.09, 0.2, 0.05), bevel=0.005)  # wall plate
        add_cylinder(body, (x, y - 0.17, s['z']), (x, y + 0.17, s['z']), 0.045, 28)
        add_box(body, (x, y, zf + 0.05), (0.03, 0.03, 0.05))
        add_cylinder(glow, (x, y - 0.172, s['z']), (x, y - 0.168, s['z']), 0.038, 24)
        add_cylinder(glow, (x, y + 0.168, s['z']), (x, y + 0.172, s['z']), 0.038, 24)
        empty(f'LIGHT_Sconce_{i}', (x, y, s['z']), lc)
    for i, d in enumerate(fx['downlights']):
        add_cylinder(body, (d['x'], d['y'] - 0.004, d['z']), (d['x'], d['y'] + 0.002, d['z']), 0.06, 28)
        add_cylinder(glow, (d['x'], d['y'] - 0.007, d['z']), (d['x'], d['y'] - 0.004, d['z']), 0.045, 24)
        empty(f'LIGHT_Down_{i}', (d['x'], d['y'] - 0.02, d['z']), lc)
    for i, b in enumerate(fx['bollards']):
        add_box(body, (b['x'], 0.3, b['z']), (0.1, 0.6, 0.1), bevel=0.006)
        add_box(glow, (b['x'], 0.5, b['z']), (0.102, 0.05, 0.102))
        empty(f'LIGHT_Bollard_{i}', (b['x'], 0.5, b['z']), lc)
    to_object('Light_Fixtures', body, MATS['M_Bronze'], lc, smooth=45, role='cutaway')
    to_object('Light_Emitters', glow, MATS['M_SconceGlow'], lc, smooth=45)

    # Ring video doorbell: body, faceplate, camera lens and blue light ring
    rb = LAY['ringDoorbell']['position']
    dc = coll('DecorativeProps')
    x, y = rb['x'], rb['y']
    shell = bmesh.new()
    add_box(shell, (x, y - 0.03, zf + 0.012), (0.062, 0.13, 0.024), bevel=0.012, segments=4)
    to_object('RingDoorbell', shell, MATS['M_PlasticBlack'], dc, smooth=60, weighted=True)
    lens = bmesh.new()
    add_cylinder(lens, (x, y + 0.012, zf + 0.023), (x, y + 0.012, zf + 0.026), 0.011, 24)
    to_object('RingDoorbell_Lens', lens, MATS['M_Lens'], dc, smooth=60)
    ring = bmesh.new()
    add_torus(ring, (x, y - 0.055, zf + 0.025), (0, 0, 1), 0.016, 0.0028, 40, 8)
    to_object('RingDoorbell_Light', ring, MATS['M_RingBlue'], dc, smooth=80)
    btn = bmesh.new()
    add_cylinder(btn, (x, y - 0.055, zf + 0.023), (x, y - 0.055, zf + 0.026), 0.012, 24)
    to_object('RingDoorbell_Button', btn, MATS['M_PlasticBlack'], dc, smooth=60)
    empty('CAM_Doorbell', (rb['x'], rb['y'], rb['z']), dc)


# ── package & safe drop zone ────────────────────────────────────────────────

def build_parcel():
    pc = coll('Package')
    s = LAY['parcel']['size']
    w, h, d = s['width'], s['height'], s['depth']
    bm = bmesh.new()
    add_box(bm, (0, h / 2, 0), (w, h, d), bevel=0.004, segments=2)
    bm.normal_update()
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        for loop in f.loops:
            co = loop.vert.co  # Blender coords: x, y=−z_app, z=y_app
            xa, za, ya = co.x, -co.y, co.z
            if n.z > 0.7:  # top: tape runs along X through the centre
                u = 0.25 + (za / d) * 0.45
                v = 0.5 + (xa / w) * 0.95
            elif abs(n.x) > 0.7:  # ±X faces carry the tape down the middle
                u = 0.75 + (za / d) * 0.45
                v = ya / h
            elif abs(n.y) > 0.7:  # ±Z faces: plain kraft
                u = 0.53 + (xa / w + 0.5) * 0.1
                v = ya / h
            else:
                u, v = 0.55, 0.1
            loop[uv].uv = (u, v)
    obj = to_object('Parcel', bm, MATS['M_Cardboard'], pc, smooth=40, weighted=True, role='parcel')
    obj['threshold_size'] = json.dumps(s)

    zc = coll('SafeDropZone')
    zone = LAY['safeDropZone']['polygon']
    xs = [p['x'] for p in zone]
    zs = [p['z'] for p in zone]
    m = 0.04
    mat_bm = bmesh.new()
    add_box(mat_bm, ((min(xs) + max(xs)) / 2, TOP + 0.006, (min(zs) + max(zs)) / 2), (max(xs) - min(xs) - 2 * m, 0.012, max(zs) - min(zs) - 2 * m), bevel=0.004)
    box_uv(mat_bm, 1 / 0.5)
    to_object('SafeDropZone_Mat', mat_bm, MATS['M_Coir'], zc, smooth=40)
    text_object('SafeDropZone_Sign', 'PARCELS', 0.05, ((min(xs) + max(xs)) / 2, 1.22, LAY['facade']['outerZ'] + 0.01), MATS['M_Aluminium'], zc, extrude=0.003, role='cutaway')


def main() -> None:
    reset_scene()
    build_textures()
    build_materials()
    build_architecture()
    build_door()
    build_route()
    build_railings()
    build_vegetation()
    build_fixtures()
    build_parcel()
    print('[stats] entrance', stats())
    os.makedirs(SRC_DIR, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SRC_DIR, 'threshold_entrance.blend'))
    export_glb(os.path.join(OUT_DIR, 'threshold_entrance.glb'))

    reset_scene()  # also clears the helper registries
    avatar.build()
    print('[stats] avatar', stats())
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SRC_DIR, 'wheelchair_avatar.blend'))
    export_glb(os.path.join(OUT_DIR, 'wheelchair_avatar.glb'))


if __name__ == '__main__':
    main()
