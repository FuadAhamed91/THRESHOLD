"""Procedural PBR texture generation for the THRESHOLD entrance (numpy only).

Every texture is tileable and deterministic (fixed seeds), so re-running the
build reproduces identical assets. Each material gets albedo (sRGB), roughness
(linear) and a tangent-space normal map (OpenGL / glTF convention, +Y up).
"""
from __future__ import annotations

import numpy as np


# ── noise primitives ────────────────────────────────────────────────────────

def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * (3.0 - 2.0 * t)


def value_noise(size: int, cells: int, rng: np.random.Generator, cells_y: int | None = None) -> np.ndarray:
    """Tileable value noise in [0, 1], shape (size, size)."""
    cy = cells_y or cells
    grid = rng.random((cy, cells))
    xs = np.linspace(0.0, cells, size, endpoint=False)
    ys = np.linspace(0.0, cy, size, endpoint=False)
    xi = np.floor(xs).astype(int)
    yi = np.floor(ys).astype(int)
    xf = _smooth(xs - xi)[None, :]
    yf = _smooth(ys - yi)[:, None]
    x0, x1 = xi % cells, (xi + 1) % cells
    y0, y1 = yi % cy, (yi + 1) % cy
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x1)]
    c = grid[np.ix_(y1, x0)]
    d = grid[np.ix_(y1, x1)]
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf


def fbm(size: int, base: int, octaves: int, rng: np.random.Generator, persistence=0.5, base_y: int | None = None) -> np.ndarray:
    out = np.zeros((size, size))
    amp, total = 1.0, 0.0
    cx, cy = base, base_y or base
    for _ in range(octaves):
        out += amp * value_noise(size, cx, rng, cy)
        total += amp
        amp *= persistence
        cx, cy = cx * 2, cy * 2
    return out / total


def normal_from_height(h: np.ndarray, strength: float) -> np.ndarray:
    """Tileable tangent-space normal map from a height field (rows = +V downward in image)."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nx = -dx * strength
    ny = dy * strength  # image rows run top→bottom while V runs bottom→top
    nz = np.ones_like(h)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx * inv, ny * inv, nz * inv], axis=-1)
    return n * 0.5 + 0.5


def to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def mix(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(t) == 2 else t
    return np.asarray(a) * (1 - t) + np.asarray(b) * t


# ── material generators: return dict(albedo=linear RGB, rough=[0,1], height=…) ──

def ledgestone(size=1024, seed=11):
    """Split-face stone strips (ledgestone veneer). Texture spans 1.2 m × 1.2 m."""
    rng = np.random.default_rng(seed)
    h = np.zeros((size, size))
    tone = np.zeros((size, size, 3))
    gap = np.zeros((size, size), dtype=bool)
    y = 0
    palette = np.array([
        [0.34, 0.30, 0.25], [0.42, 0.37, 0.31], [0.29, 0.26, 0.23],
        [0.47, 0.42, 0.35], [0.38, 0.33, 0.27], [0.25, 0.23, 0.21],
    ])
    rows = []
    while y < size:
        rh = int(rng.integers(38, 92))  # 4.5–11 cm courses
        rh = min(rh, size - y)
        rows.append((y, rh))
        y += rh
    if rows[-1][1] < 25 and len(rows) > 1:  # merge a sliver into the previous course
        py, ph = rows[-2]
        rows[-2] = (py, ph + rows[-1][1])
        rows.pop()
    for (ry, rh) in rows:
        x = int(rng.integers(0, size))
        covered = 0
        while covered < size:
            w = int(rng.integers(160, 520))
            w = min(w, size - covered)
            xs = (np.arange(x, x + w) % size)
            c = palette[rng.integers(0, len(palette))] * rng.uniform(0.85, 1.15)
            relief = rng.uniform(0.0, 1.0)
            tone[ry:ry + rh][:, xs] = c
            h[ry:ry + rh][:, xs] = 0.55 + relief * 0.35
            # joints: 3 px mortar gaps at stone ends and course tops
            gap[ry:ry + rh, xs[:3]] = True
            covered += w
            x += w
        gap[ry:ry + 3, :] = True
    split = fbm(size, 24, 5, rng, 0.62)
    chips = fbm(size, 96, 3, rng, 0.5)
    h = h + (split - 0.5) * 0.55 + (chips - 0.5) * 0.18
    h[gap] = 0.0
    mottling = fbm(size, 8, 4, rng)
    albedo = tone * (0.82 + 0.36 * mottling[..., None]) * (0.9 + 0.2 * chips[..., None])
    albedo[gap] = [0.08, 0.075, 0.07]
    rough = np.clip(0.78 + (split - 0.5) * 0.2, 0.55, 0.95)
    rough[gap] = 0.95
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(h, 9.0))


def smoked_oak(size=1024, seed=21):
    """Vertical-grain smoked oak. Spans 0.6 m (U) × 0.6 m (V)."""
    rng = np.random.default_rng(seed)
    warp = fbm(size, 4, 4, rng)
    fine = fbm(size, 64, 3, rng, 0.6)
    x = np.linspace(0, 1, size, endpoint=False)[None, :] + (warp - 0.5) * 0.08
    rings = np.sin((x * 46 + fine * 0.6) * 2 * np.pi) * 0.5 + 0.5
    streak = value_noise(size, 140, rng, 6)  # long vertical streaks
    pores = (value_noise(size, 300, rng, 40) > 0.8).astype(float)
    base = np.array([0.105, 0.066, 0.040])
    light = np.array([0.20, 0.135, 0.085])
    t = np.clip(0.35 * rings + 0.45 * streak + 0.2 * warp, 0, 1)
    albedo = mix(base, light, t) * (1.0 - pores[..., None] * 0.25)
    h = 0.5 + 0.25 * rings + 0.2 * streak - pores * 0.4
    rough = np.clip(0.42 + 0.18 * (1 - t) + pores * 0.2, 0.3, 0.8)
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(h, 2.2))


def porcelain_tiles(size=1024, seed=31, tiles=2, tone=(0.16, 0.155, 0.15), grout=(0.06, 0.06, 0.06)):
    """Large-format porcelain: `tiles`×`tiles` tiles per texture with 3 mm joints."""
    rng = np.random.default_rng(seed)
    t = size // tiles
    h = np.ones((size, size))
    albedo = np.zeros((size, size, 3))
    speck = fbm(size, 128, 3, rng, 0.55)
    cloud = fbm(size, 6, 5, rng)
    for i in range(tiles):
        for j in range(tiles):
            k = rng.uniform(0.9, 1.1)
            albedo[j * t:(j + 1) * t, i * t:(i + 1) * t] = np.array(tone) * k
    albedo = albedo * (0.85 + 0.3 * cloud[..., None]) * (0.92 + 0.16 * speck[..., None])
    jw = max(2, size // 340)
    for i in range(tiles):
        albedo[:, i * t:i * t + jw] = grout
        albedo[i * t:i * t + jw, :] = grout
        h[:, i * t:i * t + jw] = 0.0
        h[i * t:i * t + jw, :] = 0.0
    h = h * (0.97 + 0.03 * speck)
    rough = np.clip(0.48 + 0.18 * cloud, 0.35, 0.75)
    rough[h == 0] = 0.92
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(h, 3.0))


def concrete(size=1024, seed=41, tone=(0.43, 0.42, 0.40)):
    rng = np.random.default_rng(seed)
    cloud = fbm(size, 5, 6, rng, 0.55)
    fine = fbm(size, 80, 3, rng, 0.5)
    pores = (value_noise(size, 220, rng) > 0.86).astype(float)
    albedo = np.array(tone) * (0.82 + 0.3 * cloud[..., None]) * (0.95 + 0.1 * fine[..., None])
    albedo = albedo * (1 - 0.35 * pores[..., None])
    h = 0.5 + 0.1 * cloud + 0.15 * fine - 0.5 * pores
    rough = np.clip(0.82 + 0.1 * (fine - 0.5), 0.6, 0.98)
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(h, 1.6))


def charcoal_panel(size=1024, seed=51):
    """Dark fibre-cement cladding with vertical panel seams every 0.6 m (texture spans 1.2 m)."""
    rng = np.random.default_rng(seed)
    d = concrete(size, seed, tone=(0.075, 0.078, 0.085))
    h = np.ones((size, size))
    seam = max(2, size // 300)
    for i in range(2):
        h[:, i * (size // 2):i * (size // 2) + seam] = 0
    d['albedo'][h == 0] = [0.02, 0.02, 0.022]
    d['normal'] = normal_from_height(h * 0.6 + fbm(size, 40, 3, rng) * 0.05, 4.0)
    return d


def lawn(size=1024, seed=61):
    rng = np.random.default_rng(seed)
    blades = fbm(size, 160, 3, rng, 0.6)
    patches = fbm(size, 6, 4, rng)
    a = np.array([0.035, 0.055, 0.022])
    b = np.array([0.075, 0.10, 0.035])
    albedo = mix(a, b, np.clip(0.6 * blades + 0.4 * patches, 0, 1))
    return dict(albedo=albedo, rough=np.full((size, size), 0.96), normal=normal_from_height(blades, 3.0))


def mulch(size=1024, seed=71):
    rng = np.random.default_rng(seed)
    chips = fbm(size, 90, 4, rng, 0.65)
    cloud = fbm(size, 8, 3, rng)
    albedo = mix(np.array([0.035, 0.025, 0.02]), np.array([0.11, 0.075, 0.05]), np.clip(chips * 0.8 + cloud * 0.3, 0, 1))
    return dict(albedo=albedo, rough=np.full((size, size), 0.95), normal=normal_from_height(chips, 6.0))


def foliage(size=1024, seed=81):
    """Dense clipped-boxwood leaf texture."""
    rng = np.random.default_rng(seed)
    leaves = fbm(size, 70, 4, rng, 0.62)
    clumps = fbm(size, 10, 3, rng)
    dark = np.array([0.012, 0.03, 0.012])
    mid = np.array([0.045, 0.085, 0.03])
    tip = np.array([0.11, 0.16, 0.05])
    t = np.clip(leaves * 0.75 + clumps * 0.35 - 0.1, 0, 1)
    albedo = np.where(t[..., None] < 0.5, mix(dark, mid, t * 2), mix(mid, tip, (t - 0.5) * 2))
    rough = np.clip(0.55 + 0.3 * (1 - t), 0.4, 0.9)
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(leaves * 0.8 + clumps * 0.2, 7.0))


def bark(size=512, seed=91):
    rng = np.random.default_rng(seed)
    fissures = value_noise(size, 24, rng, 3)
    fine = fbm(size, 40, 3, rng)
    albedo = mix(np.array([0.05, 0.04, 0.035]), np.array([0.16, 0.14, 0.12]), np.clip(fissures * 0.7 + fine * 0.3, 0, 1))
    return dict(albedo=albedo, rough=np.full((size, size), 0.9), normal=normal_from_height(fissures + fine * 0.3, 5.0))


def cardboard_atlas(size=1024, seed=101):
    """Kraft carton atlas. U ∈ [0, .5) = top face (tape + label), [.5, 1) = sides (corrugation + tape)."""
    rng = np.random.default_rng(seed)
    fibres = fbm(size, 120, 3, rng, 0.6)
    cloud = fbm(size, 6, 3, rng)
    kraft = np.array([0.42, 0.27, 0.14])
    albedo = kraft * (0.86 + 0.18 * cloud[..., None]) * (0.94 + 0.12 * fibres[..., None])
    h = 0.5 + 0.05 * fibres
    rough = np.full((size, size), 0.86)
    half = size // 2
    # side faces: subtle vertical corrugation ripples
    xx = np.arange(size)[None, :]
    h[:, half:] += 0.04 * np.sin(xx[:, half:] * 0.9)
    # tape strip: across the top face (centre band) and down the sides
    tape_w = size // 9
    c0 = size // 4 - tape_w // 2
    tape = np.array([0.55, 0.43, 0.26])
    albedo[:, c0:c0 + tape_w] = tape * (0.95 + 0.08 * fibres[:, c0:c0 + tape_w, None])
    rough[:, c0:c0 + tape_w] = 0.38
    h[:, c0:c0 + tape_w] += 0.03
    s0 = half + half // 2 - tape_w // 2
    albedo[:, s0:s0 + tape_w] = tape * (0.95 + 0.08 * fibres[:, s0:s0 + tape_w, None])
    rough[:, s0:s0 + tape_w] = 0.38
    # shipping label on the top face (white with dark bar code lines)
    ly0, ly1 = int(size * 0.58), int(size * 0.86)
    lx0, lx1 = int(size * 0.04), int(size * 0.17)
    albedo[ly0:ly1, lx0:lx1] = [0.78, 0.78, 0.74]
    rough[ly0:ly1, lx0:lx1] = 0.6
    bars = rng.random(lx1 - lx0) > 0.55
    by0 = ly0 + (ly1 - ly0) // 2
    albedo[by0:by0 + (ly1 - ly0) // 4, lx0:lx1][:, bars] = [0.05, 0.05, 0.05]
    for k in range(4):
        y = ly0 + 8 + k * 14
        if y + 5 < by0:
            albedo[y:y + 5, lx0 + 6:lx1 - int(rng.integers(8, 40))] = [0.25, 0.25, 0.25]
    return dict(albedo=albedo, rough=rough, normal=normal_from_height(h, 2.0))


def coir_mat(size=512, seed=111):
    rng = np.random.default_rng(seed)
    fibres = fbm(size, 140, 3, rng, 0.7)
    albedo = mix(np.array([0.03, 0.03, 0.032]), np.array([0.07, 0.07, 0.075]), fibres)
    return dict(albedo=albedo, rough=np.full((size, size), 0.97), normal=normal_from_height(fibres, 5.0))


def interior_glow(size=512, seed=121):
    """Warm interior seen through frosted glass: soft vertical light falloff and curtain folds."""
    rng = np.random.default_rng(seed)
    y = np.linspace(1, 0, size)[:, None]
    x = np.linspace(0, 1, size)[None, :]
    folds = 0.5 + 0.5 * np.sin(x * 2 * np.pi * 7 + fbm(size, 3, 2, rng) * 3)
    glow = 0.55 + 0.45 * np.exp(-((y - 0.62) ** 2) / 0.12) * (0.85 + 0.15 * folds)
    col = np.array([1.0, 0.62, 0.32]) * glow[..., None]
    return dict(albedo=col, rough=np.full((size, size), 0.3), normal=None)


GENERATORS = {
    'ledgestone': ledgestone,
    'smoked_oak': smoked_oak,
    'porcelain': porcelain_tiles,
    'pavers': lambda: porcelain_tiles(1024, 33, tiles=3, tone=(0.24, 0.23, 0.21), grout=(0.09, 0.09, 0.085)),
    'concrete': concrete,
    'charcoal_panel': charcoal_panel,
    'lawn': lawn,
    'mulch': mulch,
    'foliage': foliage,
    'bark': bark,
    'cardboard': cardboard_atlas,
    'coir': coir_mat,
    'interior_glow': interior_glow,
    'oak_floor': lambda: smoked_oak(1024, 23),
    'plaster': lambda: concrete(512, 45, tone=(0.80, 0.76, 0.70)),
}
