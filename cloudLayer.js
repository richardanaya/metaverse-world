// Fancy-style voxel clouds — procedural mask spawns world-aligned 3D puffs.
// One texel → one soft rounded-cuboid puff; three stacked layers; wind scroll.
// Optimized with circular LOD culling and softened with per-instance edge fades,
// density-aware ragged silhouettes, and sun-driven silver lining.

import * as THREE from 'three';

const PUFF_VERT = /* glsl */`
  attribute float instanceSeed;
  attribute float instanceFade;

  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying float vSeed;
  varying float vFade;

  void main() {
    vLocalPos = position;
    vSeed = instanceSeed;
    vFade = instanceFade;

    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PUFF_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uRoundness;
  uniform float uSoftness;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogEnabled;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uShadowColor;

  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying float vSeed;
  varying float vFade;

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float sdRoundBox(vec3 p, vec3 halfSize, float cornerR) {
    vec3 q = abs(p) - halfSize + cornerR;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - cornerR;
  }

  float roundedBoxDensity(vec3 p, vec3 halfSize, float cornerR, float softness) {
    return smoothstep(0.04 + softness * 0.04, -0.12 - softness * 0.14, sdRoundBox(p, halfSize, cornerR));
  }

  float roundedBoxLobe(vec3 p, vec3 center, vec3 halfSize, float cornerR, float softness) {
    return roundedBoxDensity(p - center, halfSize, cornerR, softness);
  }

  void main() {
    // Unit box local space; instance scale turns each puff into a world-aligned rounded cuboid.
    vec3 p = vLocalPos;
    p.x *= 0.92 + vSeed * 0.14;
    p.z *= 0.92 + (1.0 - vSeed) * 0.14;

    const float baseY = -0.36;
    vec3 halfSize = vec3(0.46, 0.34 + vSeed * 0.05, 0.46);
    float cornerR = uRoundness + vSeed * 0.04;
    vec3 bodyCenter = vec3(0.0, 0.05, 0.0);
    float body = roundedBoxDensity(p - bodyCenter, halfSize, cornerR, uSoftness);

    float footprint = smoothstep(0.96, 0.42, length(p.xz / vec2(halfSize.x, halfSize.z)));
    float slab = smoothstep(baseY + 0.12, baseY - 0.06, p.y) * footprint;

    vec2 off1 = vec2(0.18 * (vSeed - 0.5), 0.14 * (hash21(vec2(vSeed, 1.7)) - 0.5));
    vec2 off2 = vec2(-0.2 * (hash21(vec2(vSeed, 2.9)) - 0.5), 0.12 * (vSeed - 0.35));
    vec2 off3 = vec2(0.1 * (hash21(vec2(vSeed, 4.1)) - 0.5), -0.17 * (hash21(vec2(vSeed, 5.3)) - 0.5));
    vec2 off4 = vec2(0.04 * (hash21(vec2(vSeed, 6.5)) - 0.5), 0.06 * (hash21(vec2(vSeed, 7.7)) - 0.5));
    float lobeR = max(0.04, cornerR * 0.68);
    float l1 = roundedBoxLobe(p, vec3(off1.x, -0.02, off1.y), vec3(0.3, 0.24, 0.3), lobeR, uSoftness);
    float l2 = roundedBoxLobe(p, vec3(off2.x, 0.12, off2.y), vec3(0.26, 0.21, 0.26), lobeR * 0.92, uSoftness);
    float l3 = roundedBoxLobe(p, vec3(off3.x, 0.26, off3.y), vec3(0.22, 0.18, 0.22), lobeR * 0.84, uSoftness);
    float l4 = roundedBoxLobe(p, vec3(off4.x, 0.38, off4.y), vec3(0.17, 0.14, 0.17), lobeR * 0.76, uSoftness);
    float towers = max(l1, max(l2, max(l3, l4 * 0.88)));

    float shape = max(max(body, slab * 0.86), towers);

    float wisp = hash21(vWorldPos.xz * 0.04 + vSeed * 9.0);
    float edge = smoothstep(0.05, -0.14 - uSoftness * 0.1, sdRoundBox(p - bodyCenter, halfSize, cornerR));
    float heightNorm = clamp((p.y - baseY) / 0.82, 0.0, 1.0);
    float topFade = mix(1.0, 0.65 + wisp * 0.25, smoothstep(0.45, 0.98, heightNorm));
    float bellyShadow = mix(0.78, 1.0, smoothstep(baseY, baseY + 0.24, p.y));
    float alpha = shape * (0.55 + edge * 0.45) * (0.88 + wisp * 0.12) * topFade * bellyShadow * uOpacity * vFade;
    if (alpha < 0.01) discard;

    vec3 n = normalize(vec3(p.x * 0.58, p.y * 1.25 + 0.22, p.z * 0.58));
    vec3 sunDir = normalize(uSunDirection);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float sunFacing = clamp(dot(n, sunDir) * 0.5 + 0.5, 0.0, 1.0);
    float sunLit = smoothstep(0.2, 0.95, sunFacing);
    float rim = pow(max(dot(viewDir, sunDir), 0.0), 3.0) * smoothstep(0.15, 0.75, edge);
    float selfShadow = mix(0.76, 1.0, heightNorm) * mix(0.9, 1.08, sunLit);

    vec3 col = uColor * mix(0.82, 1.14, heightNorm) * (0.94 + wisp * 0.06);
    col = mix(col * uShadowColor, col, selfShadow);
    col += uSunColor * rim * (0.1 + 0.22 * heightNorm);
    col *= mix(vec3(0.92, 0.95, 1.04), vec3(1.0), heightNorm);
    if (uFogEnabled > 0.5) {
      float fogDepth = length(vWorldPos - cameraPosition);
      float fogFactor = smoothstep(uFogNear, uFogFar, fogDepth);
      col = mix(col, uFogColor, fogFactor);
      alpha *= 1.0 - fogFactor * 0.88;
    }

    gl_FragColor = vec4(col, alpha);
  }
`;

function createPuffMaterial(color, opacity, roundness, softness) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uRoundness: { value: roundness },
      uSoftness: { value: softness },
      uFogColor: { value: new THREE.Color(0x9fb7d5) },
      uFogNear: { value: 300 },
      uFogFar: { value: 700 },
      uFogEnabled: { value: 1 },
      uSunDirection: { value: new THREE.Vector3(0.45, 0.86, 0.24).normalize() },
      uSunColor: { value: new THREE.Color(0xfff0d2) },
      uShadowColor: { value: new THREE.Color(0xc9d6e8) },
    },
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const MASK_SIZE = 256;

const LAYERS = [
  { yOff: 0, thickness: 13, opacityMul: 0.4, phaseU: 0, phaseV: 0 },
  { yOff: 4.5, thickness: 10.5, opacityMul: 0.3, phaseU: 64, phaseV: 64 },
  { yOff: 9, thickness: 11, opacityMul: 0.28, phaseU: 128, phaseV: 0 },
];

const DEFAULTS = {
  enabled: true,
  altitude: 80,
  opacity: 0.95,
  windSpeed: 0.045,
  windDirection: 255,
  tile: 6,
  cloudColor: new THREE.Color(0xf2f6fc),
  autoTint: true,
  puffScale: 1,
  layerHeight: 1,
  coverage: 0.5,
  noiseSeed: 42,
  noiseScale: 0.028,
  noiseOctaves: 5,
  noiseJitter: 0.08,
  roundness: 0.16,
  softness: 0.2,
};

function floorMod(n, m) {
  return ((n % m) + m) % m;
}

// Procedural 256×256 spawn mask — chunky binary noise (MC-style layout, no asset).
function createCloudMask({
  seed = 42,
  coverage = 0.5,
  noiseScale = 0.028,
  noiseOctaves = 5,
  noiseJitter = 0.08,
} = {}) {
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
      let freq = noiseScale;
      const octaves = Math.max(1, Math.min(7, Math.round(noiseOctaves)));
      for (let o = 0; o < octaves; o++) {
        v += amp * vnoise(x * freq + seed * 0.01, y * freq + seed * 0.013);
        freq *= 1.95;
        amp *= 0.52;
      }
      lattice[y * MASK_SIZE + x] = v;
    }
  }

  const data = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < data.length; i++) {
    const n = lattice[i] + (rng() - 0.5) * noiseJitter;
    data[i] = n > coverage ? 255 : 0;
  }
  return data;
}

function createMaskDensity(mask) {
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  const weights = [
    [0, 0, 3],
    [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2],
    [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
    [2, 0, 1], [-2, 0, 1], [0, 2, 1], [0, -2, 1],
  ];
  const maxWeight = 15;
  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      let sum = 0;
      for (const [ox, oy, w] of weights) {
        const sx = floorMod(x + ox, MASK_SIZE);
        const sy = floorMod(y + oy, MASK_SIZE);
        if (mask[sy * MASK_SIZE + sx] >= 24) sum += w;
      }
      out[y * MASK_SIZE + x] = Math.round((sum / maxWeight) * 255);
    }
  }
  return out;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function cellHash(u, v, salt = 0) {
  let h = Math.imul((u + salt * 17) ^ (v + salt * 31), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h & 0xffff) / 0xffff;
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
    this._maskDensity = null;
    this._scroll = new THREE.Vector2(0, 0);
    this._layers = [];
    this._piece = 12;
    this._radius = 75;
    this._maxInstances = (this._radius * 2 + 1) ** 2;
    this._lastCell = { x: NaN, z: NaN, sx: NaN, sz: NaN };
    this._dummy = new THREE.Object3D();
    this._sunColor = new THREE.Color();
    this._shadowColor = new THREE.Color();
    this._sunWarmColor = new THREE.Color(0xffb36f);
    this._shadowDayColor = new THREE.Color(0xd6e2f2);
    this._autoTintColor = new THREE.Color();
    this._ready = false;
  }

  init() {
    this._regenMask();
    this._applyPieceSize();

    for (let li = 0; li < LAYERS.length; li++) {
      const layer = LAYERS[li];
      const mat = createPuffMaterial(
        this.params.cloudColor,
        this.params.opacity * layer.opacityMul,
        this.params.roundness,
        this.params.softness,
      );

      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.setAttribute(
        'instanceSeed',
        new THREE.InstancedBufferAttribute(new Float32Array(this._maxInstances), 1),
      );
      geo.setAttribute(
        'instanceFade',
        new THREE.InstancedBufferAttribute(new Float32Array(this._maxInstances), 1),
      );

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
    this._syncFog();
    this._syncSunLighting();
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
    for (const { material } of this._layers) {
      material.uniforms.uColor.value.copy(this.params.cloudColor);
    }
  }

  _applyOpacity() {
    const p = this.params;
    for (const { layer, material } of this._layers) {
      material.uniforms.uOpacity.value = p.opacity * layer.opacityMul;
    }
  }

  _applyShaderStyle() {
    const p = this.params;
    for (const { material } of this._layers) {
      material.uniforms.uRoundness.value = p.roundness;
      material.uniforms.uSoftness.value = p.softness;
    }
  }

  _regenMask() {
    const p = this.params;
    this._mask = createCloudMask({
      seed: p.noiseSeed,
      coverage: p.coverage,
      noiseScale: p.noiseScale,
      noiseOctaves: p.noiseOctaves,
      noiseJitter: p.noiseJitter,
    });
    this._maskDensity = createMaskDensity(this._mask);
  }

  _syncFog() {
    const fog = this.scene.fog;
    const enabled = fog ? 1 : 0;
    for (const { material } of this._layers) {
      const u = material.uniforms;
      u.uFogEnabled.value = enabled;
      if (fog) {
        u.uFogColor.value.copy(fog.color);
        u.uFogNear.value = fog.near;
        u.uFogFar.value = fog.far;
      }
    }
  }

  _syncSunLighting() {
    if (!this.sky) return;
    const sun = this.sky.material.uniforms.sunPosition.value;
    const sunHeight = THREE.MathUtils.clamp(sun.y, -0.25, 1);
    const day = smoothstep(-0.08, 0.22, sunHeight);
    const warmth = 1 - smoothstep(0.12, 0.62, sunHeight);
    this._sunColor.setHex(0xffffff).lerp(this._sunWarmColor, warmth * 0.55);
    this._shadowColor.setHex(0x9fb7d5).lerp(this._shadowDayColor, day * 0.72);

    for (const { material } of this._layers) {
      const u = material.uniforms;
      u.uSunDirection.value.copy(sun).normalize();
      u.uSunColor.value.copy(this._sunColor).multiplyScalar(0.35 + day * 0.65);
      u.uShadowColor.value.copy(this._shadowColor).multiplyScalar(0.75 + day * 0.25);
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
    const density = this._maskDensity;
    const g = this._groupOrigin(cam);
    const seeds = mesh.geometry.getAttribute('instanceSeed');
    const fades = mesh.geometry.getAttribute('instanceFade');
    const fadeStart = Math.max(1, R - Math.max(6, Math.min(14, R * 0.16)));
    let count = 0;

    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const radial = Math.hypot(dx + 0.5, dz + 0.5);
        if (radial > R + 0.35) continue;

        const tu = floorMod(g.cellX + dx + g.scrollGX + layer.phaseU, MASK_SIZE);
        const tv = floorMod(g.cellZ + dz + g.scrollGZ + layer.phaseV, MASK_SIZE);
        const idx = tv * MASK_SIZE + tu;
        if (mask[idx] < 24) continue;

        const localDensity = density[idx] / 255;
        // Cull some tiny detached wisps in sparse mask areas. The neighbor-density
        // map keeps broad cloud islands intact while trimming noisy one-cell dots.
        if (localDensity < 0.2 && cellHash(tu, tv, layer.phaseU + 11) > 0.35) continue;

        const h0 = cellHash(tu, tv, layer.phaseU);
        const h1 = cellHash(tu, tv, layer.phaseV + 3);
        const h2 = cellHash(tu, tv, layer.phaseU + layer.phaseV);
        const h3 = cellHash(tu, tv, layer.phaseU + layer.phaseV + 19);
        const edgeFade = smoothstep(R + 0.35, fadeStart, radial);
        const densityFade = smoothstep(0.06, 0.72, localDensity);
        const instanceFade = edgeFade * (0.46 + densityFade * 0.54);
        if (instanceFade <= 0.015) continue;

        const wx = (g.cellX + dx) * piece + piece * (0.42 + h0 * 0.16);
        const wz = (g.cellZ + dz) * piece + piece * (0.42 + h1 * 0.16);
        const scale = this.params.puffScale;
        const layerLift = this.params.layerHeight;
        const mass = 0.82 + densityFade * 0.24;
        const sx = piece * (3.65 + h0 * 1.18 + h3 * 0.35) * scale * mass;
        const sy = layer.thickness * layerLift * (1.68 + h2 * 0.95 + densityFade * 0.24) * scale;
        const sz = piece * (3.3 + h1 * 1.18 + (1 - h3) * 0.28) * scale * mass;

        this._dummy.position.set(
          wx - g.x,
          this.params.altitude + layer.yOff * layerLift + sy * 0.5,
          wz - g.z,
        );
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.set(sx, sy, sz);
        this._dummy.updateMatrix();
        mesh.setMatrixAt(count, this._dummy.matrix);
        seeds.setX(count, h2);
        fades.setX(count, instanceFade);
        count++;
        if (count >= this._maxInstances) break;
      }
      if (count >= this._maxInstances) break;
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    seeds.needsUpdate = true;
    fades.needsUpdate = true;
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
      cloudAutoTint: p.autoTint,
      cloudPuffScale: p.puffScale,
      cloudLayerHeight: p.layerHeight,
      cloudCoverage: p.coverage,
      cloudNoiseSeed: p.noiseSeed,
      cloudNoiseScale: p.noiseScale,
      cloudNoiseOctaves: p.noiseOctaves,
      cloudNoiseJitter: p.noiseJitter,
      cloudRoundness: p.roundness,
      cloudSoftness: p.softness,
    };
  }

  applyAtmosphereSettings(data = {}) {
    const p = this.params;
    const prevNoise = {
      seed: p.noiseSeed,
      coverage: p.coverage,
      noiseScale: p.noiseScale,
      noiseOctaves: p.noiseOctaves,
      noiseJitter: p.noiseJitter,
    };

    if (data.cloudsEnabled != null) p.enabled = !!data.cloudsEnabled;
    if (data.cloudOpacity != null) p.opacity = data.cloudOpacity;
    if (data.cloudAltitude != null) p.altitude = data.cloudAltitude;
    if (data.cloudWindSpeed != null) p.windSpeed = data.cloudWindSpeed;
    if (data.cloudWindDirection != null) p.windDirection = data.cloudWindDirection;
    if (data.cloudTile != null) p.tile = data.cloudTile;
    if (data.cloudColor != null) p.cloudColor.setHex(data.cloudColor);
    if (data.cloudAutoTint != null) p.autoTint = !!data.cloudAutoTint;
    if (data.cloudPuffScale != null) p.puffScale = data.cloudPuffScale;
    if (data.cloudLayerHeight != null) p.layerHeight = data.cloudLayerHeight;
    if (data.cloudCoverage != null) p.coverage = data.cloudCoverage;
    if (data.cloudNoiseSeed != null) p.noiseSeed = data.cloudNoiseSeed;
    if (data.cloudNoiseScale != null) p.noiseScale = data.cloudNoiseScale;
    if (data.cloudNoiseOctaves != null) p.noiseOctaves = data.cloudNoiseOctaves;
    if (data.cloudNoiseJitter != null) p.noiseJitter = data.cloudNoiseJitter;
    if (data.cloudRoundness != null) p.roundness = data.cloudRoundness;
    if (data.cloudSoftness != null) p.softness = data.cloudSoftness;

    const noiseChanged = prevNoise.seed !== p.noiseSeed
      || prevNoise.coverage !== p.coverage
      || prevNoise.noiseScale !== p.noiseScale
      || prevNoise.noiseOctaves !== p.noiseOctaves
      || prevNoise.noiseJitter !== p.noiseJitter;
    if (noiseChanged) this._regenMask();

    this._applyPieceSize();
    this._applyOpacity();
    this._applyColors();
    this._applyShaderStyle();
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
    this._syncFog();
    this._syncSunLighting();

    if (this.sky && p.autoTint) {
      const sunY = this.sky.material.uniforms.sunPosition.value.y;
      const day = smoothstep(-0.06, 0.28, sunY);
      const goldenHour = 1 - smoothstep(0.08, 0.62, Math.max(0, sunY));
      const tint = this._autoTintColor;
      tint.setRGB(
        0.72 + day * 0.22 + goldenHour * 0.06,
        0.78 + day * 0.17 + goldenHour * 0.02,
        0.9 + day * 0.08 - goldenHour * 0.05,
      );
      for (const { material } of this._layers) {
        material.uniforms.uColor.value.copy(tint);
      }
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