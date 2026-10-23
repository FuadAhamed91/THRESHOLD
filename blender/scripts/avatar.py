"""Wheelchair avatar: a manual wheelchair with a seated figure.

The model faces +Z (app frame) with its origin on the ground at the centre of
its footprint, so the geometry engine's clearance disc is centred on it.
Rear wheels and casters are separate nodes (Wheel_L/R, Caster_L/R) whose
origins sit on their axles, so the app can spin them by distance travelled.
The figure is built from metaballs for a smooth, stylised silhouette rather
than an uncanny human: it represents a person, not a specific one.
"""
from __future__ import annotations

import math

import bmesh
import bpy

from bhelpers import B, add_box, add_cylinder, add_torus, coll, material, shade_by_angle, to_object

REAR_R = 0.30
AXLE_Z = -0.10
WHEEL_X = 0.29
CASTER_R = 0.075
CASTER_Z = 0.33
CASTER_X = 0.21


def _wheel(name: str, side: int) -> None:
    c = coll('Avatar')
    tire = bmesh.new()
    add_torus(tire, (0, 0, 0), (1, 0, 0), REAR_R - 0.018, 0.018, 64, 12)
    to_object(f'{name}_Tire', tire, material('A_Rubber', color=(0.015, 0.015, 0.016), rough=0.75), c, smooth=70)
    metal = material('A_Frame', color=(0.55, 0.6, 0.66), metal=1.0, rough=0.28)
    rim = bmesh.new()
    add_torus(rim, (0, 0, 0), (1, 0, 0), REAR_R - 0.04, 0.007, 64, 8)
    add_cylinder(rim, (-0.03, 0, 0), (0.03, 0, 0), 0.028, 20)  # hub
    for k in range(12):
        a = 2 * math.pi * k / 12
        tip = (0.0, math.sin(a) * (REAR_R - 0.045), math.cos(a) * (REAR_R - 0.045))
        hub = (side * 0.012 * (1 if k % 2 else -1), math.sin(a) * 0.025, math.cos(a) * 0.025)
        add_cylinder(rim, hub, tip, 0.0022, 6)
    # push rim with standoffs
    px = side * 0.035
    add_torus(rim, (px, 0, 0), (1, 0, 0), REAR_R - 0.035, 0.0075, 64, 10)
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        r = REAR_R - 0.035
        add_cylinder(rim, (0, math.sin(a) * r, math.cos(a) * r), (px, math.sin(a) * r, math.cos(a) * r), 0.004, 6)
    to_object(f'{name}_Rim', rim, metal, c, smooth=60)
    # parent both parts under one wheel node placed at the axle
    node = bpy.data.objects.new(name, None)
    c.objects.link(node)
    node.location = B(side * WHEEL_X, REAR_R, AXLE_Z)
    for part in (f'{name}_Tire', f'{name}_Rim'):
        bpy.data.objects[part].parent = node


def _caster(name: str, side: int) -> None:
    c = coll('Avatar')
    w = bmesh.new()
    add_torus(w, (0, 0, 0), (1, 0, 0), CASTER_R - 0.012, 0.012, 32, 8)
    add_cylinder(w, (-0.013, 0, 0), (0.013, 0, 0), CASTER_R - 0.02, 20)
    obj = to_object(name, w, material('A_Rubber'), c, smooth=60)
    obj.location = B(side * CASTER_X, CASTER_R, CASTER_Z)


def _frame() -> None:
    c = coll('Avatar')
    metal = material('A_Frame', color=(0.55, 0.6, 0.66), metal=1.0, rough=0.28)
    f = bmesh.new()
    r = 0.011
    for s in (-1, 1):
        x = s * 0.225
        pts = [
            (s * 0.25, REAR_R, AXLE_Z), (x, 0.47, -0.17), (x, 0.47, 0.22), (s * 0.215, 0.43, CASTER_Z - 0.01),
            (s * 0.19, 0.28, 0.40), (s * 0.17, 0.12, 0.44),
        ]
        for a, b in zip(pts, pts[1:]):
            add_cylinder(f, a, b, r, 12)
        add_cylinder(f, (x, 0.47, -0.17), (x, 0.93, -0.25), r, 12)  # backrest cane
        add_cylinder(f, (x, 0.93, -0.25), (x, 0.95, -0.34), r, 12)  # push handle
        add_cylinder(f, (x, 0.95, -0.34), (x, 0.955, -0.40), r * 1.6, 12)  # grip
        add_cylinder(f, (s * 0.215, 0.43, CASTER_Z - 0.01), (s * CASTER_X, CASTER_R + 0.02, CASTER_Z), 0.008, 10)  # caster fork
        add_cylinder(f, (s * 0.25, REAR_R, AXLE_Z), (s * (WHEEL_X - 0.03), REAR_R, AXLE_Z), 0.012, 12)  # axle
    add_cylinder(f, (-0.225, 0.40, -0.05), (0.225, 0.40, 0.15), r, 12)  # cross brace
    add_cylinder(f, (-0.225, 0.40, 0.15), (0.225, 0.40, -0.05), r, 12)
    to_object('Chair_Frame', f, metal, c, smooth=60)

    fabric = material('A_Fabric', color=(0.04, 0.05, 0.065), rough=0.85)
    soft = bmesh.new()
    add_box(soft, (0, 0.50, 0.02), (0.42, 0.06, 0.42), bevel=0.025, segments=3)
    add_box(soft, (0, 0.71, -0.215), (0.42, 0.38, 0.03), bevel=0.012, segments=2)
    to_object('Chair_Seat', soft, fabric, c, smooth=50, weighted=True)
    plate = bmesh.new()
    add_box(plate, (0, 0.105, 0.47), (0.36, 0.014, 0.14), bevel=0.004)
    for s in (-1, 1):
        add_box(plate, (s * 0.235, 0.6, -0.02), (0.006, 0.16, 0.26), bevel=0.003)  # side guards
    to_object('Chair_Plates', plate, metal, c, smooth=40)


def _figure() -> None:
    """Seated figure from metaballs (radii are field radii; visible ≈ 0.67×)."""
    c = coll('Avatar')
    mb = bpy.data.metaballs.new('FigureMeta')
    mb.resolution = 0.018
    mb.render_resolution = 0.018
    mb.threshold = 0.6
    ob = bpy.data.objects.new('FigureMeta', mb)
    c.objects.link(ob)

    def ball(p, radius, stiff=2.0):
        e = mb.elements.new(type='BALL')
        e.co = B(*p)
        e.radius = radius
        e.stiffness = stiff

    def chain(a, b, ra, rb, n):
        for i in range(n + 1):
            t = i / n
            ball(tuple(a[k] + (b[k] - a[k]) * t for k in range(3)), ra + (rb - ra) * t)

    # pelvis, torso, neck, head
    chain((0, 0.6, -0.06), (0, 0.66, -0.12), 0.22, 0.23, 2)
    chain((0, 0.70, -0.13), (0, 0.98, -0.17), 0.23, 0.25, 5)
    for s in (-1, 1):
        ball((s * 0.12, 0.97, -0.17), 0.17)
    chain((0, 1.06, -0.17), (0, 1.12, -0.16), 0.08, 0.075, 2)
    ball((0, 1.24, -0.13), 0.155)
    ball((0, 1.27, -0.15), 0.13)
    for s in (-1, 1):
        # thighs forward along the seat, shins down to the footrest, feet
        chain((s * 0.1, 0.6, -0.02), (s * 0.11, 0.6, 0.34), 0.12, 0.095, 6)
        chain((s * 0.11, 0.58, 0.36), (s * 0.11, 0.2, 0.42), 0.085, 0.07, 6)
        chain((s * 0.11, 0.14, 0.43), (s * 0.11, 0.13, 0.53), 0.07, 0.06, 2)
        # arms: shoulder → elbow → hand on the push rim
        chain((s * 0.21, 1.0, -0.16), (s * 0.27, 0.78, -0.1), 0.075, 0.065, 4)
        chain((s * 0.27, 0.78, -0.1), (s * 0.325, 0.6, 0.04), 0.06, 0.055, 4)
        ball((s * 0.33, 0.58, 0.07), 0.065)

    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.metaballs.remove(mb)
    me.name = 'Figure'
    fig = bpy.data.objects.new('Figure', me)
    c.objects.link(fig)
    me.materials.append(material('A_Figure', color=(0.62, 0.7, 0.8), rough=0.55))
    shade_by_angle(me, 180)
    dec = fig.modifiers.new('Decimate', 'DECIMATE')
    dec.ratio = 0.4
    fig['threshold_role'] = 'avatar-figure'


def build() -> None:
    _frame()
    _wheel('Wheel_L', -1)
    _wheel('Wheel_R', 1)
    _caster('Caster_L', -1)
    _caster('Caster_R', 1)
    _figure()
