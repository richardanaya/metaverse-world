// BlockManager — solid blocks you can jump on, build with, and edit.
//
// Blocks are placed by the world editor (right-click terrain → "Add block here",
// or right-click a block → "New block") and reshaped with a transform gizmo.
//
// Each block is a THREE box mesh plus a Rapier *cuboid collider* added to the
// same physics world the character controller steps. That's all it takes to make
// them solid: the controller already resolves its capsule against every collider
// in the world, so blocks are automatically things you collide with, stand on,
// and jump onto — no extra collision code here.
//
// Blocks can also be placed by the world editor (right-click) and reshaped with a
// transform gizmo; syncPhysics() pushes a mesh's position/rotation/scale back
// onto its Rapier body + collider so the physics matches what you see.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const PALETTE = [0xe6584d, 0xf2a83b, 0x4db6ac, 0x7e6bd6, 0x5c8fde, 0x8bc34a];
const FACE_NAMES = ['right', 'left', 'front', 'back', 'top', 'bottom'];

export const BLOCK_PBR_CHANNELS = [
  { key: 'map', label: 'Base Color', short: 'ALB', colorSpace: THREE.SRGBColorSpace },
  { key: 'normalMap', label: 'Normal', short: 'NRM' },
  { key: 'roughnessMap', label: 'Roughness', short: 'RGH' },
  { key: 'metalnessMap', label: 'Metallic', short: 'MTL' },
  { key: 'aoMap', label: 'AO', short: 'AO' },
];

function defaultFaceMaterialState() {
  return {
    tint: '#ffffff',
    maps: Object.fromEntries(BLOCK_PBR_CHANNELS.map((ch) => [ch.key, null])),
    values: { normalIntensity: 0, roughness: 1, metalness: 0, aoIntensity: 0, repeatX: 1, repeatY: 1, alpha: 1 },
  };
}

export { FACE_NAMES as BLOCK_FACE_NAMES };

// Scratch objects for decomposing a mesh's world matrix when syncing physics.
const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();
// Scratch for world↔local conversions against the rotated blocks root.
const _lp = new THREE.Vector3();
const _lq = new THREE.Quaternion();

export class BlockSummoner {
  constructor({ scene, player, max = 200, onMesh = null }) {
    this.scene = scene;
    this.player = player;
    this.onMesh = onMesh;
    this.world = player.world;
    this.scale = player.scale;
    this.max = max;

    // Z-up authoring root. The whole scene (terrain, camera, physics, sky) is
    // Y-up internally, but blocks live under this group rotated -90° about X so
    // that, in the blocks' local frame, +Z is up. Block mesh positions, the
    // transform gizmo (set to 'local' space by the world editor), the G/R/S
    // axis locks, and serialized block coords are all expressed in this Z-up
    // local frame. syncPhysics() still reads each mesh's *world* matrix, so the
    // Y-up Rapier colliders always match what you see — no physics changes.
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2; // local +Z -> world +Y (up)
    this.scene.add(this.root);

    // Block size sits between the controller's auto-step height (~0.4*scale, so
    // you can't just walk up) and its jump height (~0.9*scale, so a hop clears it).
    this.size = 0.7 * this.scale;
    this._geometry = new THREE.BoxGeometry(this.size, this.size, this.size);
    // aoMap reads uv2 in three.js; mirror the box UVs so uploaded AO works.
    this._geometry.setAttribute('uv2', new THREE.BufferAttribute(this._geometry.attributes.uv.array, 2));
    this.blocks = []; // { mesh, body, collider }
    this._colorIndex = 0;
  }

  meshes() { return this.blocks.map((b) => b.mesh); }
  findByMesh(mesh) { return mesh?.userData.block ?? null; }

  // The blocks root's world quaternion (the -90°-about-X baseline), for
  // converting directions between the Z-up local frame and the Y-up world.
  // Uses getWorldQuaternion (which refreshes the world matrix), so it stays
  // correct even before the first render.
  _rootQuat(out = new THREE.Quaternion()) {
    return this.root.getWorldQuaternion(out);
  }

  // Convert a world-space point/direction into the Z-up local authoring frame.
  // The root is at the origin with no scale, so this is just the inverse rotation.
  worldToLocalPoint(worldPoint, out = new THREE.Vector3()) {
    const invQ = this._rootQuat(_lq).invert();
    return out.copy(worldPoint).applyQuaternion(invQ);
  }
  worldToLocalDir(worldDir, out = new THREE.Vector3()) {
    const invQ = this._rootQuat(_lq).invert();
    return out.copy(worldDir).applyQuaternion(invQ);
  }

  // Create a block centered at local (x, y, z) in the Z-up authoring frame.
  create(x, y, z) {
    const half = this.size / 2;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half, half, half), body,
    );

    this._colorIndex++;
    const materials = FACE_NAMES.map(() => new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0, aoMapIntensity: 0.0,
    }));
    const mesh = new THREE.Mesh(this._geometry, materials);
    mesh.userData.materialState = { kind: 'box-faces', faces: FACE_NAMES.map(() => defaultFaceMaterialState()) };
    mesh.position.set(x, y, z); // local Z-up
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.root.add(mesh);
    this.onMesh?.(mesh);

    const block = { mesh, body, collider };
    mesh.userData.block = block;
    this.blocks.push(block);
    this.syncPhysics(block); // push the (world) matrix onto the Rapier body
    if (this.blocks.length > this.max) this.remove(this.blocks[0]); // recycle oldest
    return block;
  }

  // Place a block resting on a surface point (e.g. a terrain raycast hit).
  // `point` is in world (Y-up) space; the block is authored in the Z-up local
  // frame, so +Z is "up" and the block sits half a size above the surface.
  addAt(point) {
    const lp = this.worldToLocalPoint(point, _lp);
    return this.create(lp.x, lp.y, lp.z + this.size / 2);
  }

  // Push a block's mesh transform (moved/rotated/scaled by the gizmo) onto its
  // physics body + collider so collisions match what's drawn. Reads the *world*
  // transform so it works whether the mesh sits in the scene directly or is
  // temporarily parented under the editor's selection pivot.
  syncPhysics(block) {
    const m = block.mesh;
    m.updateWorldMatrix(true, false);
    m.matrixWorld.decompose(_wp, _wq, _ws);
    block.body.setTranslation({ x: _wp.x, y: _wp.y, z: _wp.z }, true);
    block.body.setRotation({ x: _wq.x, y: _wq.y, z: _wq.z, w: _wq.w }, true);
    const h = this.size / 2;
    block.collider.setHalfExtents({ x: h * Math.abs(_ws.x), y: h * Math.abs(_ws.y), z: h * Math.abs(_ws.z) });
  }

  // Duplicate a block on top of its source, brand-new physics body.
  // Reads the source's *world* transform and re-expresses it in the Z-up
  // blocks-root local frame (the clone is added to this.root). This is robust
  // to the source being temporarily re-parented under the editor's selection
  // pivot while it's selected — reading mesh.position directly would instead
  // give pivot-local coords and spawn the clone at the wrong place.
  cloneBlock(src) {
    const m = src.mesh;
    m.updateWorldMatrix(true, false);
    m.matrixWorld.decompose(_wp, _wq, _ws);       // source world transform
    // Convert world -> root-local (root is at the origin, unit scale, only the
    // -90°-about-X rotation, so position/quaternion rotate by its inverse and
    // scale carries through unchanged).
    const invRootQ = this._rootQuat(_lq).invert();
    _wp.applyQuaternion(invRootQ);               // world pos -> root-local pos
    _wq.premultiply(invRootQ);                   // world quat -> root-local quat
    const block = this.create(_wp.x, _wp.y, _wp.z);
    block.mesh.quaternion.copy(_wq);
    block.mesh.scale.copy(_ws);
    block.mesh.userData.materialState = structuredClone(m.userData.materialState ?? { kind: 'box-faces', faces: FACE_NAMES.map(() => defaultFaceMaterialState()) });
    this.applyMaterialState(block);
    block.mesh.updateMatrixWorld(true);
    this.syncPhysics(block);
    return block;
  }

  remove(block) {
    const i = this.blocks.indexOf(block);
    if (i === -1) return;
    this.blocks.splice(i, 1);
    this.world.removeRigidBody(block.body); // also drops its collider
    this.root.remove(block.mesh);
    this.disposeMaterials(block.mesh.material);
    block.mesh.userData.block = null;
  }

  // Serialize every block's LOCAL (Z-up) transform + color for world I/O.
  // On-disk coordinates are Z-up (block root's authoring frame), so exports
  // match the editor's mental model: z = height.
  exportState() {
    return this.blocks.map((block) => {
      const m = block.mesh;
      const p = m.position, q = m.quaternion, s = m.scale;
      return {
        x: p.x, y: p.y, z: p.z,
        qx: q.x, qy: q.y, qz: q.z, qw: q.w,
        sx: s.x, sy: s.y, sz: s.z,
        materialState: m.userData.materialState,
        colors: this.materialsOf(m).map((mat) => mat.color.getHex()),
        color: this.materialsOf(m)[0]?.color.getHex(),
      };
    });
  }

  // Spawn blocks from exported LOCAL (Z-up) state (appends to the current set).
  // `worldToZUp` converts legacy v1 world (Y-up) entries to the Z-up local frame.
  importState(items, { worldToZUp = false } = {}) {
    if (!Array.isArray(items)) return;
    const invRootQ = this._rootQuat(_lq).invert();
    for (const item of items) {
      let x = item.x ?? 0, y = item.y ?? 0, z = item.z ?? 0;
      let qx = item.qx ?? 0, qy = item.qy ?? 0, qz = item.qz ?? 0, qw = item.qw ?? 1;
      if (worldToZUp) {
        // Legacy v1 stored world (Y-up) transforms; re-express in the Z-up root.
        _wp.set(x, y, z).applyQuaternion(invRootQ);
        x = _wp.x; y = _wp.y; z = _wp.z;
        _wq.set(qx, qy, qz, qw).premultiply(invRootQ);
        qx = _wq.x; qy = _wq.y; qz = _wq.z; qw = _wq.w;
      }
      const block = this.create(x, y, z);
      block.mesh.quaternion.set(qx, qy, qz, qw);
      block.mesh.scale.set(item.sx ?? 1, item.sy ?? 1, item.sz ?? 1);
      if (item.materialState) {
        block.mesh.userData.materialState = structuredClone(item.materialState);
        this.applyMaterialState(block);
      } else {
        const colors = Array.isArray(item.colors) ? item.colors : (item.color != null ? [item.color] : null);
        if (colors) this.materialsOf(block.mesh).forEach((mat, i) => mat.color.setHex(colors[i % colors.length]));
      }
      block.mesh.updateMatrixWorld(true);
      this.syncPhysics(block);
    }
  }

  clear() {
    while (this.blocks.length) this.remove(this.blocks[this.blocks.length - 1]);
  }

  materialsOf(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }

  materialAt(block, index = 0) { return this.materialsOf(block.mesh)[THREE.MathUtils.clamp(index, 0, 5)]; }

  materialStateFor(block, index) {
    const state = block.mesh.userData.materialState ??= { kind: 'box-faces', faces: FACE_NAMES.map(() => defaultFaceMaterialState()) };
    state.faces ??= FACE_NAMES.map(() => defaultFaceMaterialState());
    state.faces[index] ??= defaultFaceMaterialState();
    return state.faces[index];
  }

  applyMaterialState(block, index = null) {
    const faces = index == null ? FACE_NAMES.map((_, i) => i) : [index];
    const oldMats = this.materialsOf(block.mesh);
    const nextMats = oldMats.slice();
    for (const i of faces) {
      const s = this.materialStateFor(block, i);
      const old = oldMats[i];
      const alpha = s.values?.alpha ?? 1;
      const mat = new THREE.MeshStandardMaterial({
        color: s.tint ?? '#ffffff',
        roughness: s.values?.roughness ?? 1,
        metalness: s.values?.metalness ?? 0,
        aoMapIntensity: s.values?.aoIntensity ?? 0,
        opacity: alpha,
        transparent: alpha < 1,
        depthWrite: alpha >= 1,
      });
      if (old?.emissive) mat.emissive.copy(old.emissive); // keep current edit highlight state
      mat.normalScale.set(s.values?.normalIntensity ?? 0, s.values?.normalIntensity ?? 0);
      for (const ch of BLOCK_PBR_CHANNELS) {
        const entry = s.maps?.[ch.key];
        if (!entry?.url) continue;
        const tex = new THREE.TextureLoader().load(entry.url, () => {
          tex.needsUpdate = true;
          mat.needsUpdate = true;
          // WebGPU can be slow to notice a newly-loaded texture on a freshly
          // swapped material array until another object change occurs. Reassign
          // the array on load so the renderer sees the binding update immediately.
          block.mesh.material = this.materialsOf(block.mesh).slice();
          block.mesh.updateMatrixWorld(true);
        });
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(s.values?.repeatX ?? 1, s.values?.repeatY ?? 1);
        if (ch.colorSpace) tex.colorSpace = ch.colorSpace;
        mat[ch.key] = tex;
      }
      mat.needsUpdate = true;
      nextMats[i] = mat;
    }
    // Reassign the material array so renderer pipelines/bindings see a concrete
    // per-face override. Old materials are intentionally not disposed here;
    // WebGPU may still reference their textures for an in-flight submit.
    block.mesh.material = nextMats;
  }

  setMaterialTexture(block, index, channelKey, url, image = null) {
    const s = this.materialStateFor(block, index);
    s.maps[channelKey] = url ? { url } : null;
    if (channelKey === 'normalMap') s.values.normalIntensity = 1;
    else if (channelKey === 'roughnessMap') s.values.roughness = 1;
    else if (channelKey === 'metalnessMap') s.values.metalness = 1;
    else if (channelKey === 'aoMap') s.values.aoIntensity = 1;
    this.applyMaterialState(block, index);

    // For freshly dropped/picked files, install an already-decoded texture right
    // away on the rebuilt material. This avoids WebGPU briefly rendering unloaded
    // TextureLoader maps as black, and makes whole-block edits update all faces
    // immediately instead of only the first loaded face being visible.
    if (image) {
      const mat = this.materialAt(block, index);
      const ch = BLOCK_PBR_CHANNELS.find((c) => c.key === channelKey);
      const tex = new THREE.CanvasTexture(image);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(s.values?.repeatX ?? 1, s.values?.repeatY ?? 1);
      if (ch?.colorSpace) tex.colorSpace = ch.colorSpace;
      mat[channelKey] = tex;
      mat.needsUpdate = true;
      block.mesh.material = this.materialsOf(block.mesh).slice();
    }
  }

  copyMaterials(srcMesh, dstMesh) {
    const src = this.materialsOf(srcMesh);
    dstMesh.material = src.map((m) => m.clone());
  }

  disposeMaterials(material) {
    const mats = Array.isArray(material) ? material : [material];
    for (const m of mats) {
      for (const ch of BLOCK_PBR_CHANNELS) m[ch.key]?.dispose?.();
      m.dispose();
    }
  }

  dispose() {
    this.clear();
    this._geometry.dispose();
  }
}
