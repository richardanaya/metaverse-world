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

    const color = PALETTE[this._colorIndex++ % PALETTE.length];
    const mesh = new THREE.Mesh(
      this._geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.0 }),
    );
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
    block.mesh.material.color.copy(m.material.color);
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
    block.mesh.material.dispose();
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
        color: m.material.color.getHex(),
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
      if (item.color != null) block.mesh.material.color.setHex(item.color);
      block.mesh.updateMatrixWorld(true);
      this.syncPhysics(block);
    }
  }

  clear() {
    while (this.blocks.length) this.remove(this.blocks[this.blocks.length - 1]);
  }

  dispose() {
    this.clear();
    this._geometry.dispose();
  }
}
