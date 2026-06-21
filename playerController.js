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

const LOCO_GLB = 'https://cdn.jsdelivr.net/npm/metaverse-avatar@0.2.0/anims/UAL1_Standard.glb';
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
const FLY_SPEED = 4.0, JUMP_HEIGHT = 4.0;
const RUN_JUMP_BOOST = 1.0;       // m/s extra forward at run-jump takeoff (avatar-local)
const RUN_JUMP_BOOST_DECAY = 12;  // 1/s — fades the boost quickly so it's a punch, not a glide
const E_HOLD = 0.26; // s — hold E longer than this (grounded) to take off into flight
const GRAVITY = -28;        // world units / s² (tuned for the scaled-up world)
const FADE_NORMAL = 0.25, FADE_SNAP = 0.15;
const MAX_DT = 1 / 30;      // clamp so a stalled tab can't fling the capsule

// Dark-Souls-style follow camera: while moving forward and not manually steering
// the camera, the azimuth eases back behind the avatar. Rates are 1/s (higher =
// snappier realign); manual input pauses it for a short cooldown.
const CAM_FOLLOW_WALK = 1.8, CAM_FOLLOW_RUN = 3.4;
const CAM_MANUAL_COOLDOWN = 0.5;   // s after manual camera input before auto-follow resumes
const CAM_DEFAULT_PHI = 1.27;      // resting vertical angle used by recenter (R3)
const CAM_FOCUS_RATE = 11;         // 1/s — alt-click orbit pivot ease-in

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
    this.agentName = null;
    this.active = false;
    this.flying = false;
    this.yaw = avatar.group.rotation.y;
    this.grounded = true;
    this.crouching = false;
    this._vy = 0;            // vertical velocity (world units/s)
    this._jumpQueued = false;
    this._jumpForwardBoost = 0; // extra forward m/s along facing, decays in the air
    this._ePressedAt = null; // when E went down (grounded): tap = jump, hold = take off
    this._eConsumed = false; // true once a hold has triggered flight
    this._reframe = false;   // snap the chase camera next frame (after a respawn)
    this.focusPoint = null;  // when set, the camera orbits this fixed world point instead of chasing the avatar
    this._unfocusing = false; // true while Escape eases the pivot back to the avatar

    // Live-tunable world/character physics (exposed in the terrain editor's
    // Physics section). Gravity feeds the kinematic capsule's manual integration;
    // maxClimbAngle is the Rapier character controller's slope limit.
    this._physicsDefaults = {
      gravity: GRAVITY, walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED,
      jumpHeight: JUMP_HEIGHT, flySpeed: FLY_SPEED, runJumpBoost: RUN_JUMP_BOOST,
      maxClimbAngle: 55,
    };
    Object.assign(this, this._physicsDefaults); // live, tunable copies

    // Gamepad / mobile hold-to-fly bookkeeping (A / jump button), mirroring the keyboard E hold.
    this._padPrev = null;
    this._padAAt = null;
    this._padAConsumed = false;
    this._mobileInput = {
      active: false, forward: false, back: false, left: false, right: false,
      up: false, down: false, run: false, turn: 0, move: 1, orbitX: 0, orbitY: 0,
      aDown: false, toggleFly: false, toggleCrouch: false, recenter: false,
    };

    // Follow-camera state: `_userOrbiting` is true while the mouse is dragging the
    // orbit; `_camManualUntil` blocks auto-follow briefly after any manual input.
    this._userOrbiting = false;
    this._camManualUntil = 0;
    this.controls.addEventListener('start', () => { this._userOrbiting = true; });
    this.controls.addEventListener('end', () => {
      this._userOrbiting = false;
      this._camManualUntil = performance.now() / 1000 + CAM_MANUAL_COOLDOWN;
    });

    this.keys = new Set();
    this.input = { forward: false, back: false, left: false, right: false, up: false, down: false, run: false };
    this.inputEnabled = true; // gated off while the world editor owns the keyboard (block edit mode)
    this.posing = false;      // true while editing the avatar: T-pose, no locomotion

    this._clips = null;
    this._stateKey = null;

    // Scratch objects reused each frame.
    this._facing = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();
    this._camDelta = new THREE.Vector3();
    this._orbitOffset = new THREE.Vector3();
    this._spherical = new THREE.Spherical();

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
    this.controller.setMaxSlopeClimbAngle((this.maxClimbAngle * Math.PI) / 180);
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
    // OrbitControls maps Shift+left-drag to pan. Shift is also the run key, so with
    // pan disabled that drag is swallowed entirely — orbit "breaks" while sprinting.
    const STATE_ROTATE = 0;
    const origMouseDown = this.controls._onMouseDown;
    this.controls._onMouseDown = function (event) {
      if (event.button === 0 && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (!this.enableRotate) return;
        this._handleMouseDownRotate(event);
        this.state = STATE_ROTATE;
        if (this.state !== -1) this.dispatchEvent({ type: 'start' });
        return;
      }
      origMouseDown.call(this, event);
    };
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

  // Rapier character-controller slope limit (degrees) — applied live.
  setMaxClimbAngle(deg) {
    this.maxClimbAngle = deg;
    this.controller?.setMaxSlopeClimbAngle((deg * Math.PI) / 180);
  }

  // Restore all tunable physics to their startup defaults.
  resetPhysics() {
    const d = this._physicsDefaults;
    this.gravity = d.gravity;
    this.walkSpeed = d.walkSpeed;
    this.runSpeed = d.runSpeed;
    this.jumpHeight = d.jumpHeight;
    this.flySpeed = d.flySpeed;
    this.runJumpBoost = d.runJumpBoost;
    this.setMaxClimbAngle(d.maxClimbAngle);
  }

  // Suspend keyboard movement (e.g. while editing blocks, so transform shortcuts
  // like S/X/G/R don't also drive the avatar). Clears any held keys so it halts.
  setInputEnabled(on) {
    this.inputEnabled = on;
    if (!on) this.keys.clear();
  }

  // ---- avatar edit "pose" mode ----------------------------------------
  // While editing the avatar: drop all locomotion to a still T-pose (rest pose)
  // and frame the camera on the front of the figure. The camera can still be
  // orbited and alt-click focus still works; only the avatar is frozen.
  enterPose() {
    if (this.posing) return;
    this.posing = true;
    this.keys.clear();
    this.avatar.stop();              // tear down clips -> rest (T) pose
    this.avatar.setBlinking(false);  // fully static
    this._faceCamera();
  }

  exitPose() {
    if (!this.posing) return;
    this.posing = false;
    this.avatar.setBlinking(true);
    this._stateKey = null;           // let update() re-establish the prior idle (stand/hover)
    // Resume the chase from wherever the camera ended up (no lurch).
    const g = this.avatar.group, s = this.scale;
    this._prevTarget.set(g.position.x, g.position.y + 1.5 * s, g.position.z);
  }

  // Place the camera in FRONT of the avatar, looking back at its face.
  _faceCamera() {
    this.focusPoint = null; this._unfocusing = false;
    const g = this.avatar.group, s = this.scale;
    const target = this._target.set(g.position.x, g.position.y + 1.5 * s, g.position.z);
    const facing = this._facing.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.copy(target).addScaledVector(facing, 4.0 * s); // in front
    this.camera.position.y += 0.2 * s;
    this.controls.target.copy(target);
    this._prevTarget.copy(target);
    this.controls.update();
  }

  // Per-frame work while posing: avatar is frozen, but keep the camera live
  // (right-stick orbit, R3 recenter, alt-click focus) so you can inspect it.
  _updatePosing(dt) {
    const gp = this._readGamepad();
    if (gp.orbitX || gp.orbitY) {
      this._orbitCamera(gp.orbitX, gp.orbitY, dt);
      this._camManualUntil = performance.now() / 1000 + CAM_MANUAL_COOLDOWN;
    }
    if (gp.recenter) this._recenterCamera();
    this._placeCamera(false, dt);
  }

  // Poll the first connected gamepad (Web Gamepad API, standard mapping) and
  // translate it into the same intents the keyboard produces. LEFT stick drives
  // the avatar (X = turn, Y = forward/back analog); RIGHT stick orbits the
  // camera. A = jump (tap) / take off (hold) / ascend while flying; B = crouch /
  // descend while flying; Y = toggle flight; RB or a full forward push = run.
  _emptyInput() {
    return {
      active: false, forward: false, back: false, left: false, right: false,
      up: false, down: false, run: false, turn: 0, move: 1, orbitX: 0, orbitY: 0,
      aDown: false, toggleFly: false, toggleCrouch: false, recenter: false,
    };
  }

  // Public hooks used by the mobile touch overlay.
  setMobileMove(x = 0, y = 0) {
    const clamp = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
    x = clamp(x); y = clamp(y);
    const active = Math.hypot(x, y) > 0.08;
    Object.assign(this._mobileInput, {
      active, forward: y < -0.18, back: y > 0.18,
      left: false, right: false, turn: active ? -x : 0,
      move: active ? Math.min(1, Math.max(Math.abs(y), Math.abs(x) * 0.35)) : 1,
    });
  }

  setMobileButton(name, down) {
    if (name === 'jump') this._mobileInput.aDown = !!down;
    else if (name === 'run') this._mobileInput.run = !!down;
    else if (name === 'up') this._mobileInput.up = !!down;
    else if (name === 'down') this._mobileInput.down = !!down;
  }

  tapMobileAction(name) {
    if (name === 'fly') this._mobileInput.toggleFly = true;
    else if (name === 'crouch') this._mobileInput.toggleCrouch = true;
    else if (name === 'recenter') this._mobileInput.recenter = true;
  }

  _readMobile() {
    const out = { ...this._mobileInput };
    if (!this.inputEnabled || this.posing) return this._emptyInput();
    this._mobileInput.toggleFly = false;
    this._mobileInput.toggleCrouch = false;
    this._mobileInput.recenter = false;
    return out;
  }

  _readGamepad() {
    const out = this._emptyInput();
    if (!this.inputEnabled || !navigator.getGamepads) { this._padPrev = null; return out; }

    let gp = null;
    for (const p of navigator.getGamepads()) { if (p && p.connected) { gp = p; break; } }
    if (!gp) { this._padPrev = null; return out; }

    const DZ = 0.22;
    const dz = (v) => (Math.abs(v) < DZ ? 0 : ((Math.abs(v) - DZ) / (1 - DZ)) * Math.sign(v));
    const ax = gp.axes, btn = (i) => !!gp.buttons[i]?.pressed;
    const lx = dz(ax[0] ?? 0), ly = dz(ax[1] ?? 0);  // left stick: turn + forward/back
    const rx = dz(ax[2] ?? 0), ry = dz(ax[3] ?? 0);  // right stick: camera orbit
    const dUp = btn(12), dDown = btn(13), dLeft = btn(14), dRight = btn(15);

    out.active = true;
    out.forward = ly < 0 || dUp;
    out.back = ly > 0 || dDown;
    out.left = dLeft;           // d-pad also turns
    out.right = dRight;
    out.turn = -lx;            // left stick left -> turn left
    out.move = (dUp || dDown) ? 1 : Math.min(1, Math.abs(ly));
    out.run = Math.abs(ly) > 0.9 || btn(5); // hard forward push or right bumper
    out.orbitX = rx;
    out.orbitY = ry;
    out.up = btn(0);           // A — ascend while flying
    out.down = btn(1);         // B — descend while flying
    out.aDown = btn(0);

    const prev = this._padPrev || {};
    out.toggleFly = btn(3) && !prev.y;
    out.toggleCrouch = btn(1) && !prev.b;
    out.recenter = btn(11) && !prev.r3; // R3 click — snap camera behind
    this._padPrev = { b: btn(1), y: btn(3), r3: btn(11) };
    return out;
  }

  // Azimuth (Spherical.theta) that places the camera directly behind the avatar.
  _behindTheta() {
    // facing = (cos yaw, 0, -sin yaw); behind = -facing; theta = atan2(x, z).
    return Math.atan2(-Math.cos(this.yaw), Math.sin(this.yaw));
  }

  _lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Instant snap behind (R3): align azimuth and reset to the resting pitch,
  // keeping the user's current zoom distance.
  _recenterCamera() {
    if (this.focusPoint || this._unfocusing) return;
    const offset = this._orbitOffset.copy(this.camera.position).sub(this.controls.target);
    const s = this._spherical.setFromVector3(offset);
    s.theta = this._behindTheta();
    s.phi = CAM_DEFAULT_PHI;
    offset.setFromSpherical(s);
    this.camera.position.copy(this.controls.target).add(offset);
    this._camManualUntil = 0;
  }

  // Orbit the chase camera around the OrbitControls target (right stick).
  _orbitCamera(dx, dy, dt) {
    if (!dx && !dy) return;
    const RATE = 2.4; // rad/s at full deflection
    const offset = this._orbitOffset.copy(this.camera.position).sub(this.controls.target);
    const s = this._spherical.setFromVector3(offset);
    s.theta -= dx * RATE * dt;
    s.phi += dy * RATE * dt;
    const EPS = 0.0001;
    s.phi = Math.max(EPS, Math.min(Math.PI - EPS, s.phi));
    offset.setFromSpherical(s);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  _key(e, down) {
    if (!this.active || !this.inputEnabled || this.posing || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const c = e.code;
    if (down) {
      if (c === 'KeyF' || c === 'Home') { e.preventDefault(); this.flying = !this.flying; this._vy = 0; if (this.flying) { this.crouching = false; this._jumpForwardBoost = 0; } return; }
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
    const backOnly = this.input.back && !this.input.forward;
    if (this.flying) return 'hover';
    if (!this.grounded) return 'jump';
    if (this.crouching) return moving ? 'crouchWalk' : 'crouchIdle';
    if (!moving) return 'stand';
    // Backwards always plays the walk cycle (even while holding run).
    if (backOnly) return 'walk';
    return this.input.run ? 'run' : 'walk';
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
    this._unfocusing = false;
    (this.focusPoint ??= new THREE.Vector3()).copy(point);
  }

  // Ease the orbit pivot back to the avatar (Escape), then resume chase camera.
  clearFocus() {
    if (!this.focusPoint && !this._unfocusing) return;
    this.focusPoint = null;
    this._unfocusing = true;
  }

  _easeOrbitPivot(goal, dt) {
    const prev = this._prevTarget.copy(this.controls.target);
    const k = dt ? 1 - Math.exp(-CAM_FOCUS_RATE * dt) : 1;
    this.controls.target.lerp(goal, k);
    if (this.controls.target.distanceToSquared(goal) < 1e-4) {
      this.controls.target.copy(goal);
    }
    this.camera.position.add(this._camDelta.subVectors(this.controls.target, prev));
    this.controls.update();
    return this.controls.target.distanceToSquared(goal) < 1e-4;
  }

  _placeCamera(initial, dt = 0) {
    // Focus mode: hold the orbit target on the chosen point and let OrbitControls
    // drive the camera. Don't track the avatar.
    if (this.focusPoint) {
      this._easeOrbitPivot(this.focusPoint, dt);
      return;
    }

    if (this._unfocusing) {
      const g = this.avatar.group;
      const s = this.scale;
      const goal = this._target.set(g.position.x, g.position.y + 1.5 * s, g.position.z);
      if (this._easeOrbitPivot(goal, dt)) {
        this._unfocusing = false;
        this._prevTarget.copy(goal);
      }
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

      // Dark-Souls follow: while moving forward and not manually steering the
      // camera, ease the azimuth back behind the avatar (pitch/zoom untouched).
      const manual = this._userOrbiting || performance.now() / 1000 < this._camManualUntil;
      if (dt && this.input.forward && !manual) {
        const offset = this._orbitOffset.copy(this.camera.position).sub(target);
        const sph = this._spherical.setFromVector3(offset);
        const rate = this.input.run ? CAM_FOLLOW_RUN : CAM_FOLLOW_WALK;
        sph.theta = this._lerpAngle(sph.theta, this._behindTheta(), 1 - Math.exp(-rate * dt));
        offset.setFromSpherical(sph);
        this.camera.position.copy(target).add(offset);
      }

      this.controls.target.copy(target);
      this._prevTarget.copy(target);
    }
    this.controls.update();
  }

  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, MAX_DT);
    if (this.posing) { this._updatePosing(dt); return; } // avatar frozen for editing
    const S = this.scale;

    // ---- kill plane: fell off the terrain into the void -> respawn at center ----
    if (this.body.translation().y < this.terrain.minHeight - 20 * S) this._respawn();

    const now = performance.now() / 1000;
    const gp = this._readGamepad();
    const mob = this._readMobile();
    const pad = {
      active: gp.active || mob.active,
      forward: gp.forward || mob.forward,
      back: gp.back || mob.back,
      left: gp.left || mob.left,
      right: gp.right || mob.right,
      up: gp.up || mob.up,
      down: gp.down || mob.down,
      run: gp.run || mob.run,
      turn: Math.max(-1, Math.min(1, gp.turn + mob.turn)),
      move: mob.active ? mob.move : gp.move,
      orbitX: gp.orbitX || mob.orbitX,
      orbitY: gp.orbitY || mob.orbitY,
      aDown: gp.aDown || mob.aDown,
      toggleFly: gp.toggleFly || mob.toggleFly,
      toggleCrouch: gp.toggleCrouch || mob.toggleCrouch,
      recenter: gp.recenter || mob.recenter,
    };
    this.input.forward = this._has('KeyW', 'ArrowUp') || pad.forward;
    this.input.back = this._has('KeyS', 'ArrowDown') || pad.back;
    this.input.left = this._has('KeyA', 'ArrowLeft') || pad.left;
    this.input.right = this._has('KeyD', 'ArrowRight') || pad.right;
    this.input.up = this._has('KeyE') || (this.flying && pad.up);
    this.input.down = this._has('KeyC') || (this.flying && pad.down);
    this.input.run = this._has('ShiftLeft', 'ShiftRight') || pad.run;
    const inp = this.input;

    // ---- gamepad / mobile: toggle flight, crouch ----
    if (pad.toggleFly) { this.flying = !this.flying; this._vy = 0; if (this.flying) { this.crouching = false; this._jumpForwardBoost = 0; } }
    if (pad.toggleCrouch && !this.flying && this.grounded) this.crouching = !this.crouching;

    // ---- gamepad A / mobile jump: tap = jump, hold = take off into flight (like keyboard E) ----
    if (pad.aDown && !this.flying && this.grounded && this._padAAt == null) {
      this._padAAt = now; this._padAConsumed = false;
    }
    if (this._padAAt != null && !this.flying && !this._padAConsumed && now - this._padAAt > E_HOLD) {
      this.flying = true; this._vy = 0; this.crouching = false; this._jumpForwardBoost = 0; this._padAConsumed = true;
    }
    if (!pad.aDown && this._padAAt != null) {
      if (!this.flying && !this._padAConsumed && !this.crouching && this.grounded) this._jumpQueued = true;
      this._padAAt = null; this._padAConsumed = false;
    }

    // ---- gamepad right stick: orbit the chase camera (manual control) ----
    if (pad.orbitX || pad.orbitY) {
      this._orbitCamera(pad.orbitX, pad.orbitY, dt);
      this._camManualUntil = now + CAM_MANUAL_COOLDOWN;
    }
    if (pad.recenter) this._recenterCamera(); // R3 / mobile button — snap behind

    // ---- E held past the threshold (grounded) -> take off into flight ----
    if (this._ePressedAt != null && !this.flying && !this._eConsumed &&
        performance.now() / 1000 - this._ePressedAt > E_HOLD) {
      this.flying = true;
      this._vy = 0;
      this.crouching = false;
      this._jumpForwardBoost = 0;
      this._eConsumed = true; // so the eventual key-up doesn't also jump
    }

    // ---- turn (rotates the figure; movement follows facing) ----
    // Keyboard / d-pad contribute ±1; the analog stick adds a fractional turn.
    let turn = (inp.left ? 1 : 0) - (inp.right ? 1 : 0) + pad.turn;
    turn = Math.max(-1, Math.min(1, turn));
    this.yaw += TURN_RATE * dt * turn;

    // ---- desired horizontal translation along facing ----
    // Analog stick scales speed; keyboard always moves at full magnitude.
    const moveMag = pad.active && !this._has('KeyW', 'KeyS', 'ArrowUp', 'ArrowDown') ? pad.move : 1;
    const facing = this._facing.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speed = (this.crouching ? CROUCH_SPEED : inp.run ? this.runSpeed : this.walkSpeed) * S;
    let dx = 0, dz = 0;
    if (inp.forward) { dx += facing.x * speed * dt * moveMag; dz += facing.z * speed * dt * moveMag; }
    if (inp.back) { dx -= facing.x * speed * BACK_FACTOR * dt * moveMag; dz -= facing.z * speed * BACK_FACTOR * dt * moveMag; }

    // Modest forward punch when sprinting into a jump (decays over ~0.2 s in the air).
    if (this._jumpForwardBoost > 0 && !this.flying) {
      dx += facing.x * this._jumpForwardBoost * dt;
      dz += facing.z * this._jumpForwardBoost * dt;
    }

    // ---- vertical: flight, gravity, jump ----
    let dy;
    if (this.flying) {
      this._vy = 0;
      dy = ((inp.up ? 1 : 0) - (inp.down ? 1 : 0)) * this.flySpeed * S * dt;
    } else {
      if (this._jumpQueued && this.grounded) {
        this._vy = Math.sqrt(2 * -this.gravity * this.jumpHeight * S); // v for a jumpHeight hop
        if (inp.run && inp.forward && !this.crouching) {
          this._jumpForwardBoost = this.runJumpBoost * S;
        }
      }
      this._vy += this.gravity * dt;
      dy = this._vy * dt;
    }
    this._jumpQueued = false;

    // ---- let the character controller resolve the move against the terrain ----
    this.controller.computeColliderMovement(this.collider, { x: dx, y: dy, z: dz });
    const mv = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this._vy < 0) this._vy = 0;

    if (!this.flying && !this.grounded) {
      this._jumpForwardBoost *= Math.exp(-RUN_JUMP_BOOST_DECAY * dt);
    } else if (this.grounded) {
      this._jumpForwardBoost = 0;
    }

    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    this.world.step();
    this._syncAvatar();

    // ---- animation state + playback speed ----
    const key = this._locomotionKey();
    this._setState(key);
    if (key === 'walk' || key === 'run' || key === 'crouchWalk') {
      const ts = key === 'run' ? 1.0 : key === 'crouchWalk' ? 1.0 : 1.05;
      this.avatar.setSpeed(ts);
    } else {
      this.avatar.setSpeed(1);
    }

    this._placeCamera(this._reframe, dt); // snap (not follow) on the frame after a respawn
    this._reframe = false;
  }

  // Snapshot for multiplayer sync (world-space feet position + facing + locomotion).
  getNetworkState() {
    const t = this.body.translation();
    const moving = this.input.forward || this.input.back;
    let speed = 1;
    const key = this._locomotionKey();
    if (key === 'walk' || key === 'run' || key === 'crouchWalk') {
      speed = key === 'run' ? 1.0 : key === 'crouchWalk' ? 1.0 : 1.05;
    }
    return {
      x: t.x,
      y: t.y - this.feetOffset,
      z: t.z,
      yaw: this.yaw,
      anim: key,
      speed,
      flying: this.flying,
      crouching: this.crouching,
    };
  }

  // Teleport the capsule back to the center spawn (e.g. after falling off the edge).
  _respawn() {
    const spawn = this._spawnPoint();
    this.body.setTranslation(spawn, true);
    this.body.setNextKinematicTranslation(spawn);
    this._vy = 0;
    this.flying = false;
    this.crouching = false;
    this._jumpForwardBoost = 0;
    this._reframe = true; // reframe the chase camera so it doesn't lurch across the map
  }
}
