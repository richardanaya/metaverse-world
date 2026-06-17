// Fancy-style voxel clouds — procedural mask drives instanced 12×12×4 translucent
// prisms.  One texel → one cloud piece; two layers; wind scroll.

import * as THREE from 'three';

const MASK_SIZE = 256;

const LAYERS = [
  { yOff: 0, thickness: 4, opacityMul: 0.86, phaseU: 0, phaseV: 0 },
  { yOff: 4, thickness: 4, opacityMul: 0.72, phaseU: 128, phaseV: 0 },
];

const DEFAULTS = {
  enabled: true,
  altitude: 80,
  opacity: 0.9,
  windSpeed: 0.018,
  windDirection: 255,
  tile: 6,
  cloudColor: new THREE.Color(0xf2f6fc),
};

function floorMod(n, m) {
  return ((n % m) + m) % m;
}

// Procedural 256×256 spawn mask — chunky binary noise (MC-style layout, no asset).
function createCloudMask(seed = 42) {
  const rng = (() => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const lattice = new Float32Array(MASK_SIZE * MASK_SIZE);
  const grad = (ix, iy) => {
    const h = Math.imul(ix ^ iy, 0x45d9f3b) >>> 0;
    return (h & 255) / 255;
  };
  const smooth = (t) => t * t * (3 - 2 * t);

  const vnoise = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const a = grad(x0, y0);
    const b = grad(x0 + 1, y0);
    const c = grad(x0, y0 + 1);
    const d = grad(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      let v = 0;
      let amp = 0.55;
      let freq = 0.028;
      for (let o = 0; o < 5; o++) {
        v += amp * vnoise(x * freq + seed * 0.01, y * freq + seed * 0.013);
        freq *= 1.95;
        amp *= 0.52;
      }
      lattice[y * MASK_SIZE + x] = v;
    }
  }

  const data = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < data.length; i++) {
    const n = lattice[i] + (rng() - 0.5) * 0.08;
    data[i] = n > 0.5 ? 255 : 0;
  }
  return data;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class CloudLayer {
  constructor({ scene, camera, sky = null }) {
    this.scene = scene;
    this.camera = camera;
    this.sky = sky;
    this.params = {
      ...DEFAULTS,
      cloudColor: DEFAULTS.cloudColor.clone(),
    };
    this._mask = null;
    this._scroll = new THREE.Vector2(0, 0);
    this._layers = [];
    this._piece = 12;
    this._radius = 75;
    this._maxInstances = (this._radius * 2 + 1) ** 2;
    this._lastCell = { x: NaN, z: NaN, sx: NaN, sz: NaN };
    this._dummy = new THREE.Object3D();
    this._ready = false;
  }

  init() {
    this._mask = createCloudMask();
    this._applyPieceSize();

    const geo = new THREE.BoxGeometry(1, 1, 1);

    for (let li = 0; li < LAYERS.length; li++) {
      const layer = LAYERS[li];
      const mat = new THREE.MeshBasicMaterial({
        color: this.params.cloudColor,
        transparent: true,
        opacity: this.params.opacity * layer.opacityMul,
        fog: true,
        depthWrite: false,
      });

      const mesh = new THREE.InstancedMesh(geo, mat, this._maxInstances);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2 + li;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const group = new THREE.Group();
      group.add(mesh);
      this.scene.add(group);

      this._layers.push({ layer, group, mesh, material: mat });
    }

    this._ready = true;
    this._syncVisibility();
    this._updateGroupPositions(this.camera.position);
    this._rebuildAll(true);
    return this;
  }

  _applyPieceSize() {
    // MC pieces are 12 blocks wide; `tile` scales piece size inversely.
    this._piece = 12 * (6 / Math.max(3, this.params.tile));
    this._radius = Math.min(75, Math.ceil((this.camera?.far ?? 900) / this._piece) + 2);
    this._maxInstances = (this._radius * 2 + 1) ** 2;
  }

  _syncVisibility() {
    const on = this.params.enabled && this._ready;
    for (const { group } of this._layers) group.visible = on;
  }

  _applyColors() {
    for (const { material } of this._layers) material.color.copy(this.params.cloudColor);
  }

  _applyOpacity() {
    const p = this.params;
    for (const { layer, material } of this._layers) {
      material.opacity = p.opacity * layer.opacityMul;
    }
  }

  _scrollState() {
    const piece = this._piece;
    return {
      cellX: Math.floor(this._scroll.x / piece),
      cellZ: Math.floor(this._scroll.y / piece),
      fracX: this._scroll.x - Math.floor(this._scroll.x / piece) * piece,
      fracZ: this._scroll.y - Math.floor(this._scroll.y / piece) * piece,
    };
  }

  _needsRebuild(cam) {
    const piece = this._piece;
    const cellX = Math.floor(cam.x / piece);
    const cellZ = Math.floor(cam.z / piece);
    const s = this._scrollState();
    const last = this._lastCell;
    if (cellX !== last.x || cellZ !== last.z || s.cellX !== last.sx || s.cellZ !== last.sz) {
      last.x = cellX;
      last.z = cellZ;
      last.sx = s.cellX;
      last.sz = s.cellZ;
      return true;
    }
    return false;
  }

  _groupOrigin(cam) {
    const piece = this._piece;
    const cellX = Math.floor(cam.x / piece);
    const cellZ = Math.floor(cam.z / piece);
    const s = this._scrollState();
    return {
      x: cellX * piece - s.fracX,
      z: cellZ * piece - s.fracZ,
      cellX,
      cellZ,
      scrollGX: s.cellX,
      scrollGZ: s.cellZ,
    };
  }

  _rebuildLayer(layerState, cam) {
    const { layer, mesh } = layerState;
    const piece = this._piece;
    const R = this._radius;
    const mask = this._mask;
    const g = this._groupOrigin(cam);
    const size = piece * 0.98;

    let count = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const tu = floorMod(g.cellX + dx + g.scrollGX + layer.phaseU, MASK_SIZE);
        const tv = floorMod(g.cellZ + dz + g.scrollGZ + layer.phaseV, MASK_SIZE);
        if (mask[tv * MASK_SIZE + tu] < 24) continue;

        const wx = (g.cellX + dx) * piece + piece * 0.5;
        const wz = (g.cellZ + dz) * piece + piece * 0.5;

        this._dummy.position.set(
          wx - g.x,
          this.params.altitude + layer.yOff + layer.thickness * 0.5,
          wz - g.z,
        );
        this._dummy.scale.set(size, layer.thickness, size);
        this._dummy.updateMatrix();
        mesh.setMatrixAt(count, this._dummy.matrix);
        count++;
        if (count >= this._maxInstances) break;
      }
      if (count >= this._maxInstances) break;
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }

  _rebuildAll(force = false) {
    if (!this._ready) return;
    const cam = this.camera.position;
    if (!force && !this._needsRebuild(cam)) return;
    for (const layerState of this._layers) this._rebuildLayer(layerState, cam);
  }

  _updateGroupPositions(cam) {
    const g = this._groupOrigin(cam);
    for (const { group } of this._layers) group.position.set(g.x, 0, g.z);
  }

  getAtmosphereSettings() {
    const p = this.params;
    return {
      cloudsEnabled: p.enabled,
      cloudOpacity: p.opacity,
      cloudAltitude: p.altitude,
      cloudWindSpeed: p.windSpeed,
      cloudWindDirection: p.windDirection,
      cloudTile: p.tile,
      cloudColor: p.cloudColor.getHex(),
    };
  }

  applyAtmosphereSettings(data = {}) {
    const p = this.params;
    if (data.cloudsEnabled != null) p.enabled = !!data.cloudsEnabled;
    if (data.cloudOpacity != null) p.opacity = data.cloudOpacity;
    if (data.cloudAltitude != null) p.altitude = data.cloudAltitude;
    if (data.cloudWindSpeed != null) p.windSpeed = data.cloudWindSpeed;
    if (data.cloudWindDirection != null) p.windDirection = data.cloudWindDirection;
    if (data.cloudTile != null) p.tile = data.cloudTile;
    if (data.cloudColor != null) p.cloudColor.setHex(data.cloudColor);

    this._applyPieceSize();
    this._applyOpacity();
    this._applyColors();
    this._syncVisibility();
    this._lastCell = { x: NaN, z: NaN, sx: NaN, sz: NaN };
    this._rebuildAll(true);
  }

  update(dt) {
    if (!this._ready || !this._layers.length || !this.params.enabled) return;

    const p = this.params;
    const cam = this.camera.position;
    const wind = p.windDirection * Math.PI / 180;

    this._scroll.x += Math.cos(wind) * p.windSpeed * dt;
    this._scroll.y += Math.sin(wind) * p.windSpeed * dt;

    this._updateGroupPositions(cam);
    this._rebuildAll(false);

    if (this.sky) {
      const sunY = this.sky.material.uniforms.sunPosition.value.y;
      const warm = smoothstep(0.0, 0.35, THREE.MathUtils.clamp(sunY, 0, 1));
      p.cloudColor.setRGB(0.88 + warm * 0.12, 0.9 + warm * 0.07, 0.97 + warm * 0.03);
      this._applyColors();
    }
  }

  dispose() {
    for (const { group, mesh, material } of this._layers) {
      this.scene.remove(group);
      mesh.geometry.dispose();
      material.dispose();
    }
    this._layers = [];
    this._ready = false;
  }
}