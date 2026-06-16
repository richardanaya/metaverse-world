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

export class BlockSummoner {
  constructor({ scene, player, max = 200 }) {
    this.scene = scene;
    this.player = player;
    this.world = player.world;
    this.scale = player.scale;
    this.max = max;

    // Block size sits between the controller's auto-step height (~0.4*scale, so
    // you can't just walk up) and its jump height (~0.9*scale, so a hop clears it).
    this.size = 0.7 * this.scale;
    this._geometry = new THREE.BoxGeometry(this.size, this.size, this.size);
    this.blocks = []; // { mesh, body, collider }
    this._colorIndex = 0;
  }

  meshes() { return this.blocks.map((b) => b.mesh); }
  findByMesh(mesh) { return mesh?.userData.block ?? null; }

  // Create a block centered at (x, y, z).
  create(x, y, z) {
    const half = this.size / 2;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half, half, half), body,
    );

    const color = PALETTE[this._colorIndex++ % PALETTE.length];
    const mesh = new THREE.Mesh(
      this._geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.0 }),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const block = { mesh, body, collider };
    mesh.userData.block = block;
    this.blocks.push(block);
    if (this.blocks.length > this.max) this.remove(this.blocks[0]); // recycle oldest
    return block;
  }

  // Place a block resting on a surface point (e.g. a terrain raycast hit).
  addAt(point) {
    return this.create(point.x, point.y + this.size / 2, point.z);
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

  // Duplicate a block: same world transform + color, brand-new physics body.
  cloneBlock(src) {
    const m = src.mesh;
    m.updateWorldMatrix(true, false);
    m.matrixWorld.decompose(_wp, _wq, _ws);
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
    this.scene.remove(block.mesh);
    block.mesh.material.dispose();
    block.mesh.userData.block = null;
  }

  clear() {
    while (this.blocks.length) this.remove(this.blocks[this.blocks.length - 1]);
  }

  dispose() {
    this.clear();
    this._geometry.dispose();
  }
}
