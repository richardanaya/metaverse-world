// VegetationLayer — procedural trees, bushes, grasses, and wildflowers.
// Uses instanced meshes, clustered habitats, slope/height filtering, and
// deterministic scatter so the same seed always recreates the same forest.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEFAULTS = {
  seed: 42,
  edgeMargin: 12,
  waterPad: 0.35,
  clearRadius: 12,
  minTreeDistance: 3.8,
};

const VARIANTS = [
  {
    kind: 'pine', label: 'pines', weight: 0.28, count: 340,
    scale: [0.82, 1.38], sink: 0.06, lean: 0.055,
    foliage: 0x315f32, trunk: 0x6d4b2f, castShadow: true,
  },
  {
    kind: 'round', label: 'broadleaf trees', weight: 0.16, count: 170,
    scale: [0.86, 1.22], sink: 0.05, lean: 0.07,
    foliage: 0x477d3f, trunk: 0x735237, castShadow: true,
  },
  {
    kind: 'birch', label: 'silver trees', weight: 0.08, count: 90,
    scale: [0.82, 1.16], sink: 0.04, lean: 0.075,
    foliage: 0x6f9945, trunk: 0xd5d0bd, castShadow: true,
  },
  {
    kind: 'bush', label: 'bushes', weight: 0.20, count: 520,
    scale: [0.7, 1.42], sink: 0.08, lean: 0.09,
    foliage: 0x456f38, castShadow: true,
  },
  {
    kind: 'grass', label: 'grass clumps', weight: 0.23, count: 2600,
    scale: [0.62, 1.55], sink: 0.1, lean: 0.32,
    foliage: 0x659a48, castShadow: false,
  },
  {
    kind: 'flower', label: 'wildflowers', weight: 0.05, count: 280,
    scale: [0.72, 1.24], sink: 0.08, lean: 0.18,
    foliage: 0x5f9a4a, accent: [0xffd45a, 0xc66cff, 0xf4f1d0, 0xff7a9e], castShadow: false,
  },
];

const MAX_SLOPE = { pine: 0.42, round: 0.42, birch: 0.44, bush: 0.5, grass: 0.56, flower: 0.48 };
const TREE_KINDS = new Set(['pine', 'round', 'birch']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x, z, scale, seed) {
  const sx = x * scale;
  const sz = z * scale;
  const x0 = Math.floor(sx);
  const z0 = Math.floor(sz);
  const tx = smoothstep(sx - x0);
  const tz = smoothstep(sz - z0);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function indexFor(x, z, samples) {
  return z * samples + x;
}

function sampleHeight(terrain, x, z) {
  const { heightMap, samples, regionSize } = terrain;
  const half = regionSize / 2;
  const max = samples - 1;
  const fx = clamp(((x + half) / regionSize) * max, 0, max);
  const fz = clamp(((z + half) / regionSize) * max, 0, max);
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
  const hx0 = lerp(h00, h10, tx);
  const hx1 = lerp(h01, h11, tx);
  return lerp(hx0, hx1, tz);
}

function sampleSlope(terrain, x, z, delta = 0.6) {
  const hx = sampleHeight(terrain, x + delta, z) - sampleHeight(terrain, x - delta, z);
  const hz = sampleHeight(terrain, x, z + delta) - sampleHeight(terrain, x, z - delta);
  return Math.atan(Math.hypot(hx, hz) / (2 * delta));
}

function mergeAndDispose(geometries) {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  return merged;
}

function pineCanopyGeometry() {
  const bottom = new THREE.ConeGeometry(1.35, 2.25, 8);
  bottom.translate(0, 2.15, 0);
  const middle = new THREE.ConeGeometry(1.0, 2.05, 8);
  middle.translate(0, 3.1, 0);
  const top = new THREE.ConeGeometry(0.68, 1.75, 8);
  top.translate(0, 3.95, 0);
  return mergeAndDispose([bottom, middle, top]);
}

function lumpyCanopyGeometry() {
  const crown = new THREE.IcosahedronGeometry(1.12, 1);
  crown.scale(1.08, 1.0, 1.08);
  crown.translate(0, 2.75, 0);
  const left = new THREE.IcosahedronGeometry(0.78, 1);
  left.scale(1.0, 0.86, 1.0);
  left.translate(-0.62, 2.25, 0.08);
  const right = new THREE.IcosahedronGeometry(0.72, 1);
  right.scale(1.0, 0.9, 1.0);
  right.translate(0.62, 2.32, -0.12);
  return mergeAndDispose([crown, left, right]);
}

function bushGeometry() {
  const a = new THREE.IcosahedronGeometry(0.74, 1);
  a.scale(1.1, 0.58, 1.0);
  a.translate(0, 0.48, 0);
  const b = new THREE.IcosahedronGeometry(0.52, 1);
  b.scale(1.0, 0.62, 0.9);
  b.translate(-0.42, 0.54, 0.08);
  const c = new THREE.IcosahedronGeometry(0.48, 1);
  c.scale(0.9, 0.58, 1.0);
  c.translate(0.42, 0.5, -0.12);
  return mergeAndDispose([a, b, c]);
}

function crossedBladeGeometry(width = 0.34, height = 0.72, blades = 3) {
  const geometries = [];
  for (let i = 0; i < blades; i++) {
    const plane = new THREE.PlaneGeometry(width * (0.76 + i * 0.12), height * (0.9 + i * 0.06));
    plane.translate(0, height * 0.48, 0);
    plane.rotateY((Math.PI / blades) * i);
    geometries.push(plane);
  }
  return mergeAndDispose(geometries);
}

function flowerHeadGeometry() {
  const head = new THREE.IcosahedronGeometry(0.13, 1);
  head.scale(1.15, 0.75, 1.15);
  head.translate(0, 0.74, 0);
  return head;
}

function trunkGeometry(radiusTop, radiusBottom, height, radialSegments = 6) {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments);
  geometry.translate(0, height / 2, 0);
  return geometry;
}

function partsFor(kind) {
  switch (kind) {
    case 'pine':
      return [
        { role: 'trunk', geometry: trunkGeometry(0.13, 0.23, 2.05), roughness: 0.82 },
        { role: 'foliage', geometry: pineCanopyGeometry(), roughness: 0.94 },
      ];
    case 'round':
      return [
        { role: 'trunk', geometry: trunkGeometry(0.17, 0.26, 2.05), roughness: 0.78 },
        { role: 'foliage', geometry: lumpyCanopyGeometry(), roughness: 0.9 },
      ];
    case 'birch': {
      const canopy = new THREE.IcosahedronGeometry(1.05, 1);
      canopy.scale(0.92, 1.18, 0.92);
      canopy.translate(0, 3.05, 0);
      return [
        { role: 'trunk', geometry: trunkGeometry(0.11, 0.17, 2.85, 7), roughness: 0.68 },
        { role: 'foliage', geometry: canopy, roughness: 0.88 },
      ];
    }
    case 'bush':
      return [{ role: 'foliage', geometry: bushGeometry(), roughness: 0.94 }];
    case 'grass':
      return [{ role: 'foliage', geometry: crossedBladeGeometry(0.3, 0.62, 3), roughness: 0.96, doubleSide: true }];
    case 'flower':
      return [
        { role: 'foliage', geometry: crossedBladeGeometry(0.22, 0.54, 2), roughness: 0.96, doubleSide: true },
        { role: 'accent', geometry: flowerHeadGeometry(), roughness: 0.82 },
      ];
    default:
      return [{ role: 'foliage', geometry: crossedBladeGeometry(), roughness: 0.96, doubleSide: true }];
  }
}

function heightBand(terrain, kind) {
  const waterLevel = terrain.waterLevel ?? 0;
  const heights = terrain.textureHeights ?? {};
  const grassStart = heights.grassStart ?? waterLevel + 0.8;
  const grassEnd = heights.grassEnd ?? grassStart + 7;
  const rockStart = heights.rockStart ?? grassEnd + 5;

  if (kind === 'grass' || kind === 'flower') return [grassStart + 0.1, grassEnd + 2.2];
  if (kind === 'bush') return [grassStart + 0.3, rockStart - 0.8];
  return [grassStart + 0.8, rockStart - 1.8];
}

function colorToArray(color, out) {
  out.push(color.r, color.g, color.b);
}

function jitterColor(baseHex, rng, { hue = 0.018, saturation = 0.06, lightness = 0.09 } = {}) {
  const color = new THREE.Color(baseHex);
  color.offsetHSL((rng() - 0.5) * hue, (rng() - 0.5) * saturation, (rng() - 0.5) * lightness);
  return color;
}

function makeMaterial(part) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: part.roughness ?? 0.9,
    metalness: 0,
    side: part.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
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
    this._materials = [];
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

  _habitatDensity(x, z, y, kind) {
    const seed = this.params.seed | 0;
    const grove = valueNoise2D(x, z, 0.022, seed ^ 0x8a5cd789);
    const meadow = valueNoise2D(x, z, 0.042, seed ^ 0x31f6a7b1);
    const scrub = valueNoise2D(x, z, 0.072, seed ^ 0xf1357aea);
    const shore = clamp((y - (this.terrain.waterLevel + this.params.waterPad)) / 4, 0, 1);

    if (TREE_KINDS.has(kind)) return clamp((0.18 + grove * 0.88 - scrub * 0.18) * shore, 0.08, 0.92);
    if (kind === 'bush') return clamp((0.22 + grove * 0.36 + scrub * 0.34) * shore, 0.12, 0.88);
    if (kind === 'flower') return clamp((meadow - 0.33) * 1.55 * shore, 0.02, 0.68);
    return clamp((0.45 + meadow * 0.5 - grove * 0.16) * shore, 0.18, 0.96);
  }

  _scatter() {
    const rng = mulberry32((this.params.seed | 0) ^ 0x9e3779b9);
    const half = this.terrain.regionSize / 2;
    const edge = this.params.edgeMargin;

    const buckets = Object.fromEntries(
      VARIANTS.map((v) => [v.kind, {
        variant: v,
        matrices: [],
        colors: { foliage: [], trunk: [], accent: [] },
      }]),
    );

    const treeCells = new Map();
    const treeCellSize = this.params.minTreeDistance;
    const treeKey = (cx, cz) => `${cx},${cz}`;
    const hasNearbyTree = (x, z) => {
      const cx = Math.floor(x / treeCellSize);
      const cz = Math.floor(z / treeCellSize);
      const minDistSq = this.params.minTreeDistance * this.params.minTreeDistance;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = treeCells.get(treeKey(cx + dx, cz + dz));
          if (!cell) continue;
          for (const p of cell) {
            const distSq = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (distSq < minDistSq) return true;
          }
        }
      }
      return false;
    };
    const rememberTree = (x, z) => {
      const cx = Math.floor(x / treeCellSize);
      const cz = Math.floor(z / treeCellSize);
      const key = treeKey(cx, cz);
      if (!treeCells.has(key)) treeCells.set(key, []);
      treeCells.get(key).push({ x, z });
    };

    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();

    const total = VARIANTS.reduce((sum, v) => sum + v.count, 0);
    let placed = 0;
    let attempts = 0;

    while (placed < total && attempts < total * 24) {
      attempts += 1;
      const available = VARIANTS.filter((v) => buckets[v.kind].matrices.length < v.count);
      if (!available.length) break;
      const totalWeight = available.reduce((sum, v) => sum + v.weight, 0);

      let pick = rng() * totalWeight;
      let variant = available[0];
      for (const v of available) {
        pick -= v.weight;
        if (pick <= 0) { variant = v; break; }
      }

      const x = (rng() * 2 - 1) * (half - edge);
      const z = (rng() * 2 - 1) * (half - edge);
      const y = sampleHeight(this.terrain, x, z);

      if (!this._canPlace(x, z, y, variant.kind)) continue;
      if (rng() > this._habitatDensity(x, z, y, variant.kind)) continue;
      if (TREE_KINDS.has(variant.kind) && hasNearbyTree(x, z)) continue;

      const scale = lerp(variant.scale[0], variant.scale[1], rng());
      const heightScale = scale * lerp(0.9, 1.16, rng());
      const lean = variant.lean ?? 0.08;
      const leanX = (rng() - 0.5) * lean;
      const leanZ = (rng() - 0.5) * lean;
      pos.set(x, y - variant.sink * scale, z);
      quat.setFromEuler(new THREE.Euler(leanX, rng() * Math.PI * 2, leanZ, 'XYZ'));
      scl.set(scale, heightScale, scale);
      matrix.compose(pos, quat, scl);

      const bucket = buckets[variant.kind];
      bucket.matrices.push(matrix.clone());
      colorToArray(jitterColor(variant.foliage, rng), bucket.colors.foliage);
      colorToArray(jitterColor(variant.trunk ?? 0x735237, rng, { hue: 0.012, saturation: 0.04, lightness: 0.07 }), bucket.colors.trunk);
      const accentBase = Array.isArray(variant.accent)
        ? variant.accent[Math.floor(rng() * variant.accent.length)]
        : (variant.accent ?? variant.foliage);
      colorToArray(jitterColor(accentBase, rng, { hue: 0.04, saturation: 0.1, lightness: 0.08 }), bucket.colors.accent);

      if (TREE_KINDS.has(variant.kind)) rememberTree(x, z);
      placed += 1;
    }

    for (const variant of VARIANTS) {
      const { matrices, colors } = buckets[variant.kind];
      if (!matrices.length) continue;

      for (const part of partsFor(variant.kind)) {
        const geometry = part.geometry;
        this._geometries.push(geometry);
        const material = makeMaterial(part);
        this._materials.push(material);
        const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
        mesh.name = `vegetation-${variant.kind}-${part.role}`;
        mesh.castShadow = variant.castShadow && part.role !== 'accent';
        mesh.receiveShadow = true;

        const roleColors = colors[part.role] ?? colors.foliage;
        for (let i = 0; i < matrices.length; i++) {
          mesh.setMatrixAt(i, matrices[i]);
          mesh.setColorAt(i, new THREE.Color(roleColors[i * 3], roleColors[i * 3 + 1], roleColors[i * 3 + 2]));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();

        this.group.add(mesh);
        this._meshes.push(mesh);
        this.onMesh?.(mesh);
      }
    }
  }

  dispose() {
    for (const mesh of this._meshes) {
      this.group.remove(mesh);
    }
    for (const material of this._materials) material.dispose();
    for (const geometry of this._geometries) geometry.dispose();
    this._meshes = [];
    this._materials = [];
    this._geometries = [];
    this.scene.remove(this.group);
    this._ready = false;
  }
}
