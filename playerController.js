// PlayerController — a proper physics-based character controller that walks a
// metaverse-avatar across a metaverse-terrain heightfield.
//
//   W A S D / arrows   move + turn        Shift    run (hold)
//   E tap (or Space)   jump               E hold   take off (fly)
//   X                  crouch (toggle)    F        toggle flight
//   E / C              fly up / down      drag     orbit the camera
//
// This is a real kinematic character controller, not a raycast hack: it uses
// Rapier's `KinematicCharacterController` driving a capsule collider against a
// static trimesh built from the terrain geometry. Rapier gives us slope limits,
// auto-step, and snap-to-ground for free, so the figure climbs hills, sticks to
// the surface going downhill, and can't tunnel through it. The avatar mesh just
// rides on top of the capsule.
//
// Locomotion clips come from the avatar package's bundled UAL1 GLB (the same
// clips examples/simple uses), loaded + retargeted via the library's own glTF
// clip loader.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initGltfAnim, getGltfClip } from 'metaverse-avatar';

const LOCO_GLB = 'https://cdn.jsdelivr.net/npm/metaverse-avatar/anims/UAL1_Standard.glb';
const LOCO_ANIMS = {
  walk: 'Walk_Loop',
  run: 'Jog_Fwd_Loop',
  stand: 'Idle_Loop',
  jump: 'Jump_Start',
  hover: 'Swim_Idle_Loop',
  crouchIdle: 'Crouch_Idle_Loop',
  crouchWalk: 'Crouch_Fwd_Loop',
};

// Tunables are in avatar-local meters, multiplied by the avatar's world scale so
// they stay meaningful however large the figure is rendered.
const WALK_SPEED = 1.5, RUN_SPEED = 4.0, CROUCH_SPEED = 1.1, BACK_FACTOR = 0.6, TURN_RATE = 2.6;
const FLY_SPEED = 4.0, JUMP_HEIGHT = 1.6;
const E_HOLD = 0.26; // s — hold E longer than this (grounded) to take off into flight
const GRAVITY = -28;        // world units / s² (tuned for the scaled-up world)
const FADE_NORMAL = 0.25, FADE_SNAP = 0.15;
const MAX_DT = 1 / 30;      // clamp so a stalled tab can't fling the capsule

const MOVE_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyE', 'KeyC', 'ShiftLeft', 'ShiftRight',
];

export class PlayerController {
  constructor({ avatar, terrain, camera, controls }) {
    this.avatar = avatar;
    this.terrain = terrain;
    this.camera = camera;
    this.controls = controls;

    this.scale = avatar.group.scale.x || 1;
    this.active = false;
    this.flying = false;
    this.yaw = avatar.group.rotation.y;
    this.grounded = true;
    this.crouching = false;
    this._vy = 0;            // vertical velocity (world units/s)
    this._jumpQueued = false;
    this._ePressedAt = null; // when E went down (grounded): tap = jump, hold = take off
    this._eConsumed = false; // true once a hold has triggered flight
    this._reframe = false;   // snap the chase camera next frame (after a respawn)
    this.focusPoint = null;  // when set, the camera orbits this fixed world point instead of chasing the avatar
    this._savedCamPos = new THREE.Vector3(); // chase-camera position captured on entering focus, restored on exit
    this._hasSavedCam = false;

    this.keys = new Set();
    this.input = { forward: false, back: false, left: false, right: false, up: false, down: false, run: false };

    this._clips = null;
    this._stateKey = null;

    // Scratch objects reused each frame.
    this._facing = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();
    this._camDelta = new THREE.Vector3();

    this._onDown = (e) => this._key(e, true);
    this._onUp = (e) => this._key(e, false);
  }

  async start() {
    if (this.active) return;
    const S = this.scale;

    // ---- physics world + colliders -------------------------------------
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = MAX_DT;

    // Static terrain collider straight from the drawn geometry — guaranteed to
    // line up with what you see (the terrain group sits at the world origin).
    this.groundBody = null;
    this.rebuildTerrainCollider();

    // Capsule sized to the (scaled) figure. Rapier's capsule(halfHeight, radius)
    // measures halfHeight as half the cylinder segment, so total height =
    // 2*halfHeight + 2*radius. The avatar group's origin is at the feet.
    this.radius = 0.35 * S;
    this.halfHeight = 0.5 * S;
    this.feetOffset = this.halfHeight + this.radius; // capsule center → feet

    const spawn = this._spawnPoint();
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    this.collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius), this.body,
    );

    // The character controller: a small skin offset, plus the niceties that make
    // it feel like a real walker.
    this.controller = this.world.createCharacterController(0.02 * S);
    this.controller.enableAutostep(0.4 * S, 0.2 * S, true); // climb low ledges
    this.controller.enableSnapToGround(0.5 * S);            // stick going downhill
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((45 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    // ---- animation clips ------------------------------------------------
    await initGltfAnim(LOCO_GLB, this.avatar);
    this._clips = {};
    for (const [key, name] of Object.entries(LOCO_ANIMS)) {
      const clip = getGltfClip(LOCO_GLB, name);
      if (!clip) throw new Error(`locomotion clip not found: ${name}`);
      this._clips[key] = clip;
    }

    this.active = true;
    this._stateKey = null;
    this._setState('stand');
    this._syncAvatar();

    // Third-person chase camera: keep OrbitControls live but lock panning.
    this.controls.enablePan = false;
    this._placeCamera(true);

    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    this.avatar.stop();
  }

  // (Re)build the static terrain collider from the current terrain geometry.
  // Call after the heightmap is sculpted so collisions match the new surface.
  rebuildTerrainCollider() {
    if (this.groundBody) this.world.removeRigidBody(this.groundBody);
    const geom = this.terrain.terrainMesh.geometry;
    const verts = geom.attributes.position.array;       // Float32Array (updated in place on edit)
    const indices = new Uint32Array(geom.index.array);  // Rapier wants Uint32
    this.groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices), this.groundBody);
  }

  // Spawn capsule center above the terrain at the origin (ray straight down).
  _spawnPoint() {
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 1e5, 0), new THREE.Vector3(0, -1, 0),
    );
    const hit = this.terrain.raycast(ray);
    const groundY = hit ? hit.point.y : 0;
    return { x: 0, y: groundY + this.feetOffset + 0.05 * this.scale, z: 0 };
  }

  _key(e, down) {
    if (!this.active || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const c = e.code;
    if (down) {
      if (c === 'KeyF' || c === 'Home') { e.preventDefault(); this.flying = !this.flying; this._vy = 0; if (this.flying) this.crouching = false; return; }
      if (c === 'KeyX') { e.preventDefault(); if (!this.flying && this.grounded) this.crouching = !this.crouching; return; }
      if (c === 'Space') { e.preventDefault(); if (!this.flying && !this.crouching && this.grounded) this._jumpQueued = true; return; }
      // E (grounded): tap = jump, hold = take off (update() promotes a sustained
      // hold to flight). `== null` ignores OS key-repeat so the timer isn't reset.
      // While flying, E is "ascend" — it falls through to the movement-key set.
      if (c === 'KeyE' && !this.flying && this.grounded && this._ePressedAt == null) {
        this._ePressedAt = performance.now() / 1000;
        this._eConsumed = false;
      }
    } else if (c === 'KeyE') {
      // Short press (released before the hold threshold, no take-off) = jump.
      if (!this.flying && !this._eConsumed && this._ePressedAt != null && !this.crouching && this.grounded) {
        this._jumpQueued = true;
      }
      this._ePressedAt = null;
      this._eConsumed = false;
    }
    if (MOVE_KEYS.includes(c)) {
      e.preventDefault();
      if (down) this.keys.add(c); else this.keys.delete(c);
    }
  }

  _has(...codes) { return codes.some((c) => this.keys.has(c)); }

  _locomotionKey() {
    const moving = this.input.forward || this.input.back;
    if (this.flying) return 'hover';
    if (!this.grounded) return 'jump';
    if (this.crouching) return moving ? 'crouchWalk' : 'crouchIdle';
    return moving ? (this.input.run ? 'run' : 'walk') : 'stand';
  }

  _setState(key) {
    if (this._stateKey === key) return;
    const prev = this._stateKey;
    this._stateKey = key;
    const clip = this._clips[key] ?? this._clips.stand;
    const oneShot = key === 'jump';
    const fade = !prev ? 0 : (oneShot || prev === 'jump') ? FADE_SNAP : FADE_NORMAL;
    this.avatar.crossFadeTo(clip, fade, true);
    if (!fade) this.avatar.update(0);
  }

  // Place the avatar mesh on the capsule: feet at capsule center minus the offset.
  _syncAvatar() {
    const t = this.body.translation();
    this.avatar.group.position.set(t.x, t.y - this.feetOffset, t.z);
    this.avatar.group.rotation.y = this.yaw;
  }

  // Lock the orbit target onto a fixed world point (alt-click). The chase camera
  // suspends so the user can freely orbit around it; clearFocus() resumes chasing.
  setFocusPoint(point) {
    // Entering focus from the chase camera: remember where the camera was so
    // Escape can put it back. Re-focusing while already focused keeps the
    // original chase position.
    if (!this.focusPoint) {
      this._savedCamPos.copy(this.camera.position);
      this._hasSavedCam = true;
    }
    this.focusPoint = (this.focusPoint ?? new THREE.Vector3()).copy(point);
    this.controls.target.copy(point);
    this.controls.update();
  }

  // Return to the avatar-centered chase camera (Escape). Restore the camera to
  // its pre-focus position and re-seed the tracking reference to the avatar's
  // current head target so the resume doesn't lurch.
  clearFocus() {
    if (!this.focusPoint) return;
    this.focusPoint = null;
    if (this._hasSavedCam) {
      this.camera.position.copy(this._savedCamPos);
      this._hasSavedCam = false;
    }
    const g = this.avatar.group, s = this.scale;
    this._prevTarget.set(g.position.x, g.position.y + 1.5 * s, g.position.z);
  }

  _placeCamera(initial) {
    // Focus mode: hold the orbit target on the chosen point and let OrbitControls
    // drive the camera. Don't track the avatar.
    if (this.focusPoint) {
      this.controls.target.copy(this.focusPoint);
      this.controls.update();
      return;
    }
    const g = this.avatar.group;
    const s = this.scale;
    const target = this._target.set(g.position.x, g.position.y + 1.5 * s, g.position.z);
    if (initial) {
      const facing = this._facing.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.camera.position.copy(target).addScaledVector(facing, -4.0 * s);
      this.camera.position.y += 1.2 * s;
      this.controls.target.copy(target);
      this._prevTarget.copy(target);
    } else {
      // Shift the camera by the body's per-frame movement so the user's chosen
      // orbit angle/distance is preserved while it tracks the avatar.
      const delta = this._camDelta.subVectors(target, this._prevTarget);
      this.camera.position.add(delta);
      this.controls.target.copy(target);
      this._prevTarget.copy(target);
    }
    this.controls.update();
  }

  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, MAX_DT);
    const S = this.scale;

    // ---- kill plane: fell off the terrain into the void -> respawn at center ----
    if (this.body.translation().y < this.terrain.minHeight - 20 * S) this._respawn();

    this.input.forward = this._has('KeyW', 'ArrowUp');
    this.input.back = this._has('KeyS', 'ArrowDown');
    this.input.left = this._has('KeyA', 'ArrowLeft');
    this.input.right = this._has('KeyD', 'ArrowRight');
    this.input.up = this._has('KeyE');
    this.input.down = this._has('KeyC');
    this.input.run = this._has('ShiftLeft', 'ShiftRight');
    const inp = this.input;

    // ---- E held past the threshold (grounded) -> take off into flight ----
    if (this._ePressedAt != null && !this.flying && !this._eConsumed &&
        performance.now() / 1000 - this._ePressedAt > E_HOLD) {
      this.flying = true;
      this._vy = 0;
      this.crouching = false;
      this._eConsumed = true; // so the eventual key-up doesn't also jump
    }

    // ---- turn (rotates the figure; movement follows facing) ----
    if (inp.left) this.yaw += TURN_RATE * dt;
    if (inp.right) this.yaw -= TURN_RATE * dt;

    // ---- desired horizontal translation along facing ----
    const facing = this._facing.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speed = (this.crouching ? CROUCH_SPEED : inp.run ? RUN_SPEED : WALK_SPEED) * S;
    let dx = 0, dz = 0;
    if (inp.forward) { dx += facing.x * speed * dt; dz += facing.z * speed * dt; }
    if (inp.back) { dx -= facing.x * speed * BACK_FACTOR * dt; dz -= facing.z * speed * BACK_FACTOR * dt; }

    // ---- vertical: flight, gravity, jump ----
    let dy;
    if (this.flying) {
      this._vy = 0;
      dy = ((inp.up ? 1 : 0) - (inp.down ? 1 : 0)) * FLY_SPEED * S * dt;
    } else {
      if (this._jumpQueued && this.grounded) {
        this._vy = Math.sqrt(2 * -GRAVITY * JUMP_HEIGHT * S); // v for a JUMP_HEIGHT hop
      }
      this._vy += GRAVITY * dt;
      dy = this._vy * dt;
    }
    this._jumpQueued = false;

    // ---- let the character controller resolve the move against the terrain ----
    this.controller.computeColliderMovement(this.collider, { x: dx, y: dy, z: dz });
    const mv = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this._vy < 0) this._vy = 0;

    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    this.world.step();
    this._syncAvatar();

    // ---- animation state + playback speed ----
    const key = this._locomotionKey();
    this._setState(key);
    if (key === 'walk' || key === 'run' || key === 'crouchWalk') {
      let ts = key === 'run' ? 1.0 : key === 'crouchWalk' ? 1.0 : 1.05;
      if (inp.back && !inp.forward) ts = key === 'run' ? -1.2 : -1.0;
      this.avatar.setSpeed(ts);
    } else {
      this.avatar.setSpeed(1);
    }

    this._placeCamera(this._reframe); // snap (not follow) on the frame after a respawn
    this._reframe = false;
  }

  // Teleport the capsule back to the center spawn (e.g. after falling off the edge).
  _respawn() {
    const spawn = this._spawnPoint();
    this.body.setTranslation(spawn, true);
    this.body.setNextKinematicTranslation(spawn);
    this._vy = 0;
    this.flying = false;
    this.crouching = false;
    this._reframe = true; // reframe the chase camera so it doesn't lurch across the map
  }
}
