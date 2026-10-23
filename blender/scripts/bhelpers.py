"""Shared Blender helpers for the THRESHOLD asset build.

Coordinates passed to these helpers are in the app's world frame (Three.js:
X right, Y up, Z toward the street) and converted with B(). The glTF exporter
converts Blender's Z-up back to Y-up, so exported nodes land exactly where the
app's geometry engine expects them.
"""
from __future__ import annotations

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise


def B(x: float, y: float, z: float) -> Vector:
    """App world (x, y, z) → Blender (x, −z, y)."""
    return Vector((x, -z, y))


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    s.unit_settings.scale_length = 1.0
    COLLECTIONS.clear()
    MATS.clear()
    TEX.clear()


COLLECTIONS: dict[str, bpy.types.Collection] = {}
TEX: dict[str, dict[str, bpy.types.Image]] = {}
MATS: dict[str, bpy.types.Material] = {}


def coll(name: str) -> bpy.types.Collection:
    c = COLLECTIONS.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        COLLECTIONS[name] = c
    return c


# ── images & materials ──────────────────────────────────────────────────────

def save_image(name: str, arr: np.ndarray, colorspace: str, directory: str) -> bpy.types.Image:
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    # Colour space first: changing it later makes Blender regenerate (blank) the buffer.
    img.colorspace_settings.name = colorspace
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(arr[::-1], 0.0, 1.0)  # Blender stores rows bottom-up
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    os.makedirs(directory, exist_ok=True)
    img.filepath_raw = os.path.join(directory, name + '.png')
    img.file_format = 'PNG'
    img.save()
    return img


def _input(node, names, value) -> None:
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = value
            return


def material(
    name: str,
    color=(0.8, 0.8, 0.8),
    rough=0.5,
    metal=0.0,
    tex_key: str | None = None,
    normal_strength=1.0,
    emission=None,
    emission_strength=0.0,
    vcol=False,
    emissive_texture=False,
) -> bpy.types.Material:
    if name in MATS:
        return MATS[name]
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True  # no-op on Blender 5.x, required on older versions
    except Exception:
        pass
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None) or nodes.new('ShaderNodeBsdfPrincipled')
    out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None) or nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    _input(bsdf, ['Base Color'], (*color, 1.0))
    _input(bsdf, ['Roughness'], rough)
    _input(bsdf, ['Metallic'], metal)
    if tex_key and tex_key in TEX:
        imgs = TEX[tex_key]
        alb = nodes.new('ShaderNodeTexImage')
        alb.image = imgs['albedo']
        links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
        if emissive_texture:
            target = bsdf.inputs['Emission Color'] if 'Emission Color' in bsdf.inputs else bsdf.inputs['Emission']
            links.new(alb.outputs['Color'], target)
        if 'rough' in imgs:
            r = nodes.new('ShaderNodeTexImage')
            r.image = imgs['rough']
            links.new(r.outputs['Color'], bsdf.inputs['Roughness'])
        if 'normal' in imgs:
            n = nodes.new('ShaderNodeTexImage')
            n.image = imgs['normal']
            nm = nodes.new('ShaderNodeNormalMap')
            nm.inputs['Strength'].default_value = normal_strength
            links.new(n.outputs['Color'], nm.inputs['Color'])
            links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if vcol:
        attr = nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    if emission is not None:
        _input(bsdf, ['Emission Color', 'Emission'], (*emission, 1.0))
    if emission_strength:
        _input(bsdf, ['Emission Strength'], emission_strength)
    MATS[name] = mat
    return mat


# ── mesh helpers ────────────────────────────────────────────────────────────

def box_uv(bm: bmesh.types.BMesh, scale: float, offset=(0.0, 0.0)) -> None:
    """World-space box projection, so patterns run continuously across pieces."""
    uv = bm.loops.layers.uv.verify()
    bm.normal_update()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            co = loop.vert.co
            if ax == 0:
                u, v = (co.y if n.x > 0 else -co.y), co.z
            elif ax == 1:
                u, v = (-co.x if n.y > 0 else co.x), co.z
            else:
                u, v = co.x, co.y
            loop[uv].uv = (u * scale + offset[0], v * scale + offset[1])


def fit_uv(bm: bmesh.types.BMesh) -> None:
    """Box-project, then normalise to the 0–1 square (one image across a panel)."""
    box_uv(bm, 1.0)
    uv = bm.loops.layers.uv.verify()
    us = [l[uv].uv.x for f in bm.faces for l in f.loops]
    vs = [l[uv].uv.y for f in bm.faces for l in f.loops]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = ((loop[uv].uv.x - u0) / max(u1 - u0, 1e-6), (loop[uv].uv.y - v0) / max(v1 - v0, 1e-6))


def shade_by_angle(me: bpy.types.Mesh, angle_deg: float) -> None:
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(angle_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = len(e.link_faces) == 2 and e.calc_face_angle(math.pi) < lim
    bm.to_mesh(me)
    bm.free()


def to_object(name, bm, mats, collection, smooth: float | None = 35.0, weighted=False, role: str | None = None, parent=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    for m in mats if isinstance(mats, (list, tuple)) else [mats]:
        if m is not None:
            me.materials.append(m)
    if smooth is not None:
        shade_by_angle(me, smooth)
    if weighted:
        mod = obj.modifiers.new('WeightedNormal', 'WEIGHTED_NORMAL')
        mod.mode = 'FACE_AREA'
        mod.keep_sharp = True
        mod.weight = 50
    if role:
        obj['threshold_role'] = role
    if parent is not None:
        obj.parent = parent
    return obj


def add_box(bm, center, size, bevel=0.0, segments=2):
    """Axis-aligned box in app coordinates. size = (x width, y height, z depth)."""
    ret = bmesh.ops.create_cube(bm, size=1.0)
    verts = ret['verts']
    sx, sy, sz = size
    bmesh.ops.scale(bm, vec=(sx, sz, sy), verts=verts)
    bmesh.ops.translate(bm, vec=B(*center), verts=verts)
    if bevel > 0:
        edges = list({e for v in verts for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=segments, profile=0.5, affect='EDGES', clamp_overlap=True)
    return verts


def box_object(name, center, size, mat, collection, bevel=0.0, segments=2, uv=None, role=None, parent=None):
    bm = bmesh.new()
    add_box(bm, center, size, bevel, segments)
    if uv:
        box_uv(bm, uv)
    return to_object(name, bm, mat, collection, smooth=40 if bevel else 30, weighted=bevel > 0, role=role, parent=parent)


def add_prism(bm, pts_bottom, pts_top):
    vb = [bm.verts.new(B(*p)) for p in pts_bottom]
    vt = [bm.verts.new(B(*p)) for p in pts_top]
    n = len(vb)
    bm.faces.new(list(reversed(vb)))
    bm.faces.new(vt)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    return vb + vt


def add_cylinder(bm, a, b, radius, segments=16, caps=True, radius_b=None):
    va, vb_ = B(*a), B(*b)
    d = vb_ - va
    ret = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segments, radius1=radius,
                                radius2=radius if radius_b is None else radius_b, depth=d.length)
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((va + vb_) / 2) @ rot, verts=ret['verts'])
    return ret['verts']


def add_torus(bm, center_app, axis_app, major, minor, seg_major=48, seg_minor=12):
    c = B(*center_app)
    axis = B(*axis_app).normalized()
    rot = Vector((0, 0, 1)).rotation_difference(axis).to_matrix()
    rings = []
    for i in range(seg_major):
        a = 2 * math.pi * i / seg_major
        ring = []
        for j in range(seg_minor):
            b = 2 * math.pi * j / seg_minor
            p = Vector(((major + minor * math.cos(b)) * math.cos(a), (major + minor * math.cos(b)) * math.sin(a), minor * math.sin(b)))
            ring.append(bm.verts.new(c + rot @ p))
        rings.append(ring)
    for i in range(seg_major):
        r0, r1 = rings[i], rings[(i + 1) % seg_major]
        for j in range(seg_minor):
            bm.faces.new([r0[j], r1[j], r1[(j + 1) % seg_minor], r0[(j + 1) % seg_minor]])


def add_blob(bm, center_app, radius, seed, subdiv=3, roughness=0.22, squash=1.0):
    """Displaced icosphere: clipped shrub / topiary / tree-canopy mass."""
    ret = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    c = B(*center_app)
    off = Vector((seed * 7.13, seed * 3.71, seed * 1.93))
    for v in ret['verts']:
        p = v.co.copy()
        n = p.normalized()
        d = noise.fractal(p * (2.2 / max(radius, 0.05)) + off, 0.7, 2.0, 4)
        d2 = noise.noise(p * (9.0 / max(radius, 0.05)) + off * 2.0)
        v.co = c + Vector((n.x, n.y, n.z * squash)) * radius * (1.0 + roughness * d + 0.06 * d2)
    return ret['verts']


def _mesh_from_temp(ob) -> bpy.types.Mesh:
    dg = bpy.context.evaluated_depsgraph_get()
    return bpy.data.meshes.new_from_object(ob.evaluated_get(dg))


def curve_tube(name, pts_app, radius, mat, collection, role=None, resolution=3):
    cu = bpy.data.curves.new(name + '_c', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius
    cu.bevel_resolution = resolution
    cu.use_fill_caps = True
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts_app) - 1)
    for i, p in enumerate(pts_app):
        q = B(*p)
        sp.points[i].co = (q.x, q.y, q.z, 1.0)
    ob = bpy.data.objects.new(name + '_c', cu)
    collection.objects.link(ob)
    me = _mesh_from_temp(ob)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    me.name = name
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    me.materials.append(mat)
    shade_by_angle(me, 60)
    if role:
        obj['threshold_role'] = role
    return obj


def text_object(name, body, size, center_app, mat, collection, extrude=0.006, role=None):
    cu = bpy.data.curves.new(name + '_t', 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    ob = bpy.data.objects.new(name + '_t', cu)
    collection.objects.link(ob)
    me = _mesh_from_temp(ob)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    me.transform(Matrix.Rotation(math.radians(90), 4, 'X'))
    me.name = name
    obj = bpy.data.objects.new(name, me)
    obj.location = B(*center_app)
    collection.objects.link(obj)
    me.materials.append(mat)
    shade_by_angle(me, 30)
    if role:
        obj['threshold_role'] = role
    return obj


def empty(name, pos_app, collection, role=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.1
    e.location = B(*pos_app)
    collection.objects.link(e)
    if role:
        e['threshold_role'] = role
    return e


# ── export & stats ──────────────────────────────────────────────────────────

def export_glb(path: str, draco: bool = True) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_image_format='WEBP',
        export_image_quality=82,
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_vertex_color='MATERIAL',
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_hierarchy_full_collections=True,
        export_draco_mesh_compression_enable=draco,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=10,
    )
    print(f'[export] {path}  {os.path.getsize(path) / 1e6:.2f} MB')


def stats() -> dict:
    tris = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in bpy.context.scene.objects:
        if ob.type == 'MESH':
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
            ev.to_mesh_clear()
    return {'objects': len(bpy.context.scene.objects), 'triangles': tris}
