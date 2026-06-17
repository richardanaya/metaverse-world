// VegetationLayer — procedural trees, bushes, and grass scattered on the terrain.
// One scene group, instanced meshes per shape; skips water, steep slopes, and spawn.

import * as THREE from 'three';

const DEFAULTS = {
  seed: 42,
  edgeMargin: 12,
  waterPad: 0.35,
  clearRadius: 12,
};

const VARIANTS = [
  { kind: 'pine', weight: 0.35, scale: [0.85, 1.35], sink: 0.05, color: 0x3a6b36, castShadow: true },
  { kind: 'round', weight: 0.15, scale: [0.9, 1.25], sink: 0.05, color: 0x4a7d42, castShadow: true },
  { kind: 'bush', weight: 0.2, scale: [0.75, 1.35], sink: 0.08, color: 0x4a7c3f, castShadow: true },
  { kind: 'grass', weight: 0.3, scale: [0.7, 1.4], sink: 0.12, color: 0x5f9a4a, castShadow: false },
];

const COUNTS = { pine: 300, round: 120, bush: 400, grass: 2200 };
const MAX_SLOPE = { pine: 0.42, round: 0.42, bush: 0.5, grass: 0.55 };

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function indexFor(x, z, samples) {
  return z * samples + x;
}

function sampleHeight(terrain, x, z) {
  const { heightMap, samples, regionSize } = terrain;
  const half = regionSize / 2;
  const max = samples - 1;
  const fx = ((x + half) / regionSize) * max;
  const fz = ((z + half) / regionSize) * max;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(max, x0 + 1);
  const z1 = Math.min(max, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const h00 = heightMap[indexFor(x0, z0, samples)];
  const h10 = heightMap[indexFor(x1, z0, samples)];
  const h01 = heightMap[indexFor(x0, z1, samples)];
  const h11 = heightMap[indexFor(x1, z1, samples)];
  return (h00 + (h10 - h00) * tx) + ((h01 + (h11 - h01) * tx) - (h00 + (h10 - h00) * tx)) * tz;
}

function sampleSlope(terrain, x, z, delta = 0.6) {
  const hx = sampleHeight(terrain, x + delta, z) - sampleHeight(terrain, x - delta, z);
  const hz = sampleHeight(terrain, x, z + delta) - sampleHeight(terrain, x, z - delta);
  return Math.atan(Math.hypot(hx, hz) / (2 * delta));
}

function geometryFor(kind) {
  switch (kind) {
    case 'pine': {
      const g = new THREE.ConeGeometry(1, 4.2, 7);
      g.translate(0, 2.1, 0);
      return g;
    }
    case 'round': {
      const g = new THREE.IcosahedronGeometry(1.35, 1);
      g.scale(1, 1.35, 1);
      g.translate(0, 1.85, 0);
      return g;
    }
    case 'bush': {
      const g = new THREE.IcosahedronGeometry(0.72, 1);
      g.scale(1, 0.62, 1);
      g.translate(0, 0.35, 0);
      return g;
    }
    default: {
      const g = new THREE.ConeGeometry(0.22, 0.55, 4);
      g.translate(0, 0.28, 0);
      return g;
    }
  }
}

function heightBand(terrain, kind) {
  const { grassStart, grassEnd, rockStart } = terrain.textureHeights;
  if (kind === 'grass') return [grassStart + 0.1, grassEnd + 2];
  if (kind === 'bush') return [grassStart + 0.3, rockStart - 1];
  return [grassStart + 0.8, rockStart - 2];
}

export class VegetationLayer {
  constructor({ scene, terrain, seed = terrain?.seed ?? DEFAULTS.seed, onMesh = null }) {
    this.scene = scene;
    this.terrain = terrain;
    this.params = { ...DEFAULTS, seed };
    this.onMesh = onMesh;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this._meshes = [];
    this._geometries = [];
    this._ready = false;
  }

  init() {
    if (this._ready) return this;
    this.scene.add(this.group);
    this._scatter();
    this._ready = true;
    return this;
  }

  _canPlace(x, z, y, kind) {
    const t = this.terrain;
    const p = this.params;
    if (Math.hypot(x, z) < p.clearRadius) return false;
    if (y < t.waterLevel + p.waterPad) return false;
    const [minH, maxH] = heightBand(t, kind);
    if (y < minH || y > maxH) return false;
    if (sampleSlope(t, x, z) > MAX_SLOPE[kind]) return false;
    return true;
  }

  _scatter() {
    const rng = mulberry32(this.params.seed ^ 0x9e3779b9);
    const half = this.terrain.regionSize / 2;
    const edge = this.params.edgeMargin;
    const totalWeight = VARIANTS.reduce((s, v) => s + v.weight, 0);

    const buckets = Object.fromEntries(
      VARIANTS.map((v) => [v.kind, { variant: v, matrices: [], colors: [] }]),
    );

    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const tint = new THREE.Color();

    const total = Object.values(COUNTS).reduce((s, n) => s + n, 0);
    let placed = 0;
    let attempts = 0;

    while (placed < total && attempts < total * 16) {
      attempts += 1;
      const x = (rng() * 2 - 1) * (half - edge);
      const z = (rng() * 2 - 1) * (half - edge);
      const y = sampleHeight(this.terrain, x, z);

      let pick = rng() * totalWeight;
      let variant = VARIANTS[0];
      for (const v of VARIANTS) {
        pick -= v.weight;
        if (pick <= 0) { variant = v; break; }
      }
      if (buckets[variant.kind].matrices.length >= COUNTS[variant.kind]) continue;
      if (!this._canPlace(x, z, y, variant.kind)) continue;

      const scale = variant.scale[0] + rng() * (variant.scale[1] - variant.scale[0]);
      const lean = (rng() - 0.5) * 0.08;
      pos.set(x, y - variant.sink * scale, z);
      quat.setFromEuler(new THREE.Euler(lean, rng() * Math.PI * 2, lean * 0.6, 'XYZ'));
      scl.set(scale, scale * (0.92 + rng() * 0.16), scale);
      matrix.compose(pos, quat, scl);

      const bucket = buckets[variant.kind];
      bucket.matrices.push(matrix.clone());
      tint.setHex(variant.color);
      tint.offsetHSL(0, 0, (rng() - 0.5) * 0.08);
      bucket.colors.push(tint.r, tint.g, tint.b);
      placed += 1;
    }

    for (const variant of VARIANTS) {
      const { matrices, colors } = buckets[variant.kind];
      if (!matrices.length) continue;

      const geometry = geometryFor(variant.kind);
      this._geometries.push(geometry);
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      mesh.castShadow = variant.castShadow;

      for (let i = 0; i < matrices.length; i++) {
        mesh.setMatrixAt(i, matrices[i]);
        mesh.setColorAt(i, new THREE.Color(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.group.add(mesh);
      this._meshes.push(mesh);
      this.onMesh?.(mesh);
    }
  }

  dispose() {
    for (const mesh of this._meshes) {
      this.group.remove(mesh);
      mesh.material.dispose();
    }
    for (const geometry of this._geometries) geometry.dispose();
    this._meshes = [];
    this._geometries = [];
    this.scene.remove(this.group);
    this._ready = false;
  }
}