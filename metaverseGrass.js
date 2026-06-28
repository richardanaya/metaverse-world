// Procedural grass layer for metaverse-terrain height bands.
// Generates compact instanced cross-card blades only where the terrain's
// configured grass layer is active (textureHeights.grassStart..grassEnd).

import * as THREE from 'three/webgpu';

function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function sampleHeight(terrain, x, z) {
  const { regionSize, samples, heightMap } = terrain;
  const half = regionSize / 2;
  const sx = THREE.MathUtils.clamp(((x + half) / regionSize) * (samples - 1), 0, samples - 1);
  const sz = THREE.MathUtils.clamp(((z + half) / regionSize) * (samples - 1), 0, samples - 1);
  const x0 = Math.floor(sx), z0 = Math.floor(sz);
  const x1 = Math.min(samples - 1, x0 + 1), z1 = Math.min(samples - 1, z0 + 1);
  const tx = sx - x0, tz = sz - z0;
  const i = (xx, zz) => zz * samples + xx;
  const a = heightMap[i(x0, z0)], b = heightMap[i(x1, z0)];
  const c = heightMap[i(x0, z1)], d = heightMap[i(x1, z1)];
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, tx),
    THREE.MathUtils.lerp(c, d, tx),
    tz,
  );
}

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function grassWeightAt(terrain, height) {
  // CPU mirror of metaverse-terrain's grass height band, including the blend
  // skirts so procedural blades match the visible grass texture instead of
  // leaving bald strips at band edges.
  const { grassStart, grassEnd } = terrain.textureHeights;
  const bw = terrain.textureBlendWidth ?? 4;
  return smoothstep(grassStart - bw, grassStart + bw, height)
    * (1 - smoothstep(grassEnd - bw, grassEnd + bw, height));
}

function sampleNormal(terrain, x, z) {
  const step = terrain.regionSize / (terrain.samples - 1);
  const hL = sampleHeight(terrain, x - step, z);
  const hR = sampleHeight(terrain, x + step, z);
  const hD = sampleHeight(terrain, x, z - step);
  const hU = sampleHeight(terrain, x, z + step);
  const dx = (hR - hL) / (step * 2);
  const dz = (hU - hD) / (step * 2);
  return new THREE.Vector3(-dx, 1, -dz).normalize();
}

function makeCrossBladeGeometry() {
  // Thin tapered blades instead of rectangular billboards, so no opaque green
  // sheets are visible. The root sits slightly below y=0 to prevent hovering on
  // slopes and imperfect height samples.
  const w = 0.012;
  const h = 1.0;
  const positions = [];
  const uvs = [];
  const indices = [];
  const addBlade = (rot) => {
    const base = positions.length / 3;
    const c = Math.cos(rot), s = Math.sin(rot);
    const lean = 0.18;
    const verts = [
      [-w, -0.06, 0], [w, -0.06, 0],
      [-w * 0.85, h * 0.28, lean * 0.22], [w * 0.85, h * 0.28, lean * 0.22],
      [-w * 0.38, h * 0.66, lean * 0.70], [w * 0.38, h * 0.66, lean * 0.70],
      [0, h, lean],
    ];
    for (const [px, py, pz] of verts) {
      positions.push(px * c - pz * s, py, px * s + pz * c);
    }
    uvs.push(0, 0, 1, 0, 0.08, 0.28, 0.92, 0.28, 0.24, 0.66, 0.76, 0.66, 0.5, 1);
    indices.push(
      base, base + 2, base + 1, base + 1, base + 2, base + 3,
      base + 2, base + 4, base + 3, base + 3, base + 4, base + 5,
      base + 4, base + 6, base + 5,
    );
  };
  // A small tuft: several crossed tapered blades per instance gives much better
  // coverage than one ultra-thin card while keeping draw calls low.
  addBlade(0);
  addBlade(Math.PI / 4);
  addBlade(Math.PI / 2);
  addBlade((Math.PI * 3) / 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export class ProceduralGrass {
  constructor({ scene, terrain, count = 14000, seed = 1337, wind = null, animate = false, focus = null } = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.count = count;
    this.seed = seed;
    this.wind = wind;
    this.animate = animate;
    this.focus = focus;
    this.nearFullDistance = 24;
    this.farFadeDistance = 105;
    this.farDensity = 0.008;
    this._lastDensityUpdate = -Infinity;
    this._dummy = new THREE.Object3D();
    this._bases = [];
    this._up = new THREE.Vector3(0, 1, 0);
    this._swayQ = new THREE.Quaternion();
    this._rotQ = new THREE.Quaternion();

    const material = new THREE.MeshStandardMaterial({
      color: 0x6f8060,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const mesh = new THREE.InstancedMesh(makeCrossBladeGeometry(), material, count);
    mesh.name = 'ProceduralGrass';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    scene.add(mesh);
    this.rebuild();
  }

  rebuild() {
    const t = this.terrain;
    const half = t.regionSize / 2;
    const dummy = this._dummy;
    this._bases.length = 0;

    let written = 0;
    // Stratified candidates with heavy jitter and probabilistic acceptance.
    // This keeps coverage high while hiding the visible row/column lattice of a
    // simple one-per-cell grid.
    const cells = Math.ceil(Math.sqrt(this.count * 3.6));
    const cellSize = t.regionSize / cells;
    for (let gz = 0; gz < cells && written < this.count; gz += 1) {
      for (let gx = 0; gx < cells && written < this.count; gx += 1) {
        const a = gz * cells + gx;
        const r1 = hash01(this.seed + a * 2.17);
        const r2 = hash01(this.seed + a * 7.91);
        const r3 = hash01(this.seed + a * 13.37);
        const r4 = hash01(this.seed + a * 19.19);
        const warpX = Math.sin((gz * 0.73 + r3 * 6.28) + this.seed) * 0.42;
        const warpZ = Math.sin((gx * 0.61 + r4 * 6.28) - this.seed) * 0.42;
        const x = THREE.MathUtils.clamp(-half + (gx + 0.5 + (r1 - 0.5) * 2.35 + warpX) * cellSize, -half, half);
        const z = THREE.MathUtils.clamp(-half + (gz + 0.5 + (r2 - 0.5) * 2.35 + warpZ) * cellSize, -half, half);
        const y = sampleHeight(t, x, z);
        // Strict metaverse-terrain grass band only. Do not use the visual blend
        // skirt here, because it can extend down toward sand/water and place
        // tufts under shallow water.
        if (y < t.textureHeights.grassStart || y > t.textureHeights.grassEnd) continue;
        if (y <= t.waterLevel + 0.08) continue;
        const grassWeight = grassWeightAt(t, y);
        if (hash01(a + 501) > Math.max(0.35, grassWeight) * 0.92) continue;
        const normal = sampleNormal(t, x, z);
        if (normal.y < 0.84) continue; // skip steep rock-like slopes inside blend bands

          const h = THREE.MathUtils.lerp(0.072, 0.168, hash01(a + this.seed * 3.1)) * THREE.MathUtils.lerp(0.85, 1.10, grassWeight);
        const s = THREE.MathUtils.lerp(0.288, 0.472, hash01(a + 99));
        const rot = hash01(a + 41) * Math.PI * 2;
        const phase = hash01(a + 211) * Math.PI * 2;
      const color = new THREE.Color(0x5f704f).lerp(new THREE.Color(0x93a875), hash01(a + 17));
      const alignQ = new THREE.Quaternion().setFromUnitVectors(this._up, normal);
      this.mesh.setColorAt(written, color);
      this._bases.push({ x, y: y - 0.03, z, h, s, rot, phase, alignQ });
      dummy.position.set(x, y - 0.03, z);
      dummy.quaternion.copy(alignQ).multiply(this._rotQ.setFromAxisAngle(this._up, rot));
      dummy.scale.setScalar(s);
      dummy.scale.y = h;
        dummy.updateMatrix();
        this.mesh.setMatrixAt(written, dummy.matrix);
        written += 1;
      }
    }

    this.mesh.count = written;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return written;
  }

  update(time = 0) {
    const hasFocus = !!this.focus;
    const shouldRefreshDensity = hasFocus && (time - this._lastDensityUpdate > 0.35);
    if (!this.animate && !shouldRefreshDensity) return;

    const focusPos = this.focus?.position;
    const dir = this.wind?.direction ?? new THREE.Vector2(1, 0.3).normalize();
    const speed = Math.max(0.04, this.wind?.speed ?? 0.08);
    const dummy = this._dummy;
    let visible = 0;

    for (let i = 0; i < this._bases.length; i += 1) {
      const b = this._bases[i];

      let lodScale = 1;
      if (hasFocus) {
        const dist = Math.hypot(b.x - focusPos.x, b.z - focusPos.z);
        const fade = THREE.MathUtils.clamp((dist - this.nearFullDistance) / (this.farFadeDistance - this.nearFullDistance), 0, 1);
        const smoothFade = fade * fade * (3 - 2 * fade);
        const density = THREE.MathUtils.lerp(1, this.farDensity, smoothFade);
        lodScale = THREE.MathUtils.lerp(1, 0.45, smoothFade);
        // Stable per-tuft thinning. Near the avatar density is full; farther away
        // increasingly fewer, smaller tufts are copied into the visible draw range
        // for a cheaper low-detail distant layer.
        if (hash01(i + this.seed * 31.7) > density) continue;
      }

      const wave = this.animate
        ? Math.sin((b.x * dir.x + b.z * dir.y) * 0.12 + time * (1.5 + speed * 8) + b.phase)
        : 0;
      dummy.position.set(b.x, b.y, b.z);
      this._swayQ.setFromEuler(new THREE.Euler(wave * 0.035, 0, wave * 0.02));
      dummy.quaternion.copy(b.alignQ)
        .multiply(this._rotQ.setFromAxisAngle(this._up, b.rot))
        .multiply(this._swayQ);
      dummy.scale.setScalar(b.s * lodScale);
      dummy.scale.y = b.h * lodScale;
      dummy.updateMatrix();
      this.mesh.setMatrixAt(visible, dummy.matrix);
      if (this.mesh.instanceColor) {
        const color = new THREE.Color(0x5f704f).lerp(new THREE.Color(0x93a875), hash01(i + 17));
        this.mesh.setColorAt(visible, color);
      }
      visible += 1;
    }

    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (shouldRefreshDensity) this._lastDensityUpdate = time;
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
