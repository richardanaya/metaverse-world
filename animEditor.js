import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { partForBone } from 'metaverse-avatar';

// In-app BVH animation editor.
//
// Enter the mode, pose the avatar by dragging joint markers (FK rotate
// gizmo, or two-bone IK from the wrists/ankles), drop keyframes on the
// bottom timeline, scrub/play to preview, and save the result as an
// Ruth-style .bvh file. Export uses the inverse of the axis change in
// bvh.js (q_bvh = C⁻¹ · q_ruth · C, offsets in inches), so saved files
// round-trip through retargetToRuth and reload in this viewer.
//
// IK rig (wrists/ankles): each limb is a two-bone chain (shoulder→elbow,
// hip→knee) with an analytic add-on rig that mirrors what animators expect
// from Maya/Blender:
//   • soft reach   — the goal eases into full extension instead of snapping
//                    straight (no pop at the reach limit); see _softGoal.
//   • pole target  — an orange handle the elbow/knee always points at, so
//                    the limb plane is predictable and never flips; the analytic
//                    two-bone solve (_solveTwoBone) places the joint in-plane.
//   • handle orient— the IK handle carries the wrist/ankle world rotation, so
//                    Move places the hand and Rotate orients it; _orientEffector.
//   • pin/plant    — pinned hands/feet stay put in world space while the hip
//                    moves (floating base), re-solved in _onHipMove.

const INCH = 0.0254;
const EXPORT_FPS = 30;
const KEY_MERGE_EPS = 0.02; // s — writing a key this close to another replaces it
const POSE_EPS = 0.0087; // rad (~0.5°) — below this a bone counts as "at rest"
const HIP_EPS = 0.002; // m — below this the hip counts as un-moved

// BVH-space → Ruth-armature-space rotation (same C as bvh.js).
const C = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
  .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
const CInv = C.clone().invert();

// Ruth BVH skeleton (classic body + bento fingers + toes). `children` defines
// the exported hierarchy; `end` / `endBone` set End Site offsets in BVH
// inches; `ik` lists the two parent joints for wrist/ankle IK drags.
// Wrists/fingers live on hands.dae, ankles/toes on feet.dae — see partForBone.

const FINGER_ORDER = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const FINGER_BVH = { Thumb: 'Thumb', Index: 'Index', Middle: 'Mid', Ring: 'Ring', Pinky: 'Pinky' };

function fingerRoots(side) {
  return FINGER_ORDER.map((f) => `mHand${f}1${side}`);
}

function buildFingerJoints(side) {
  const pre = side === 'Left' ? 'l' : 'r';
  const joints = [];
  for (const f of FINGER_ORDER) {
    const bvhBase = FINGER_BVH[f];
    const b1 = `mHand${f}1${side}`;
    const b2 = `mHand${f}2${side}`;
    const b3 = `mHand${f}3${side}`;
    joints.push(
      { bone: b1, bvh: `${pre}${bvhBase}1`, children: [b2], finger: true },
      { bone: b2, bvh: `${pre}${bvhBase}2`, endBone: b3, finger: true },
    );
  }
  return joints;
}

function buildJoints() {
  const j = [];
  const add = (...items) => j.push(...items);
  add(
    { bone: 'mPelvis', bvh: 'hip', children: ['mTorso', 'mHipLeft', 'mHipRight'] },
    { bone: 'mTorso', bvh: 'abdomen', children: ['mChest'] },
    { bone: 'mChest', bvh: 'chest', children: ['mNeck', 'mCollarLeft', 'mCollarRight'] },
    // Spine lean: dragging the neck base bends torso + chest as a 2-bone chain
    // (bend-only: no pole, no orient — Rotate falls back to tilting the neck).
    { bone: 'mNeck', bvh: 'neck', children: ['mHead'], ik: ['mTorso', 'mChest'], ikBend: true },
    { bone: 'mHead', bvh: 'head', end: [0, 3.6, 0] },
    { bone: 'mCollarLeft', bvh: 'lCollar', children: ['mShoulderLeft'] },
    { bone: 'mShoulderLeft', bvh: 'lShldr', children: ['mElbowLeft'] },
    { bone: 'mElbowLeft', bvh: 'lForeArm', children: ['mWristLeft'] },
    { bone: 'mWristLeft', bvh: 'lHand', children: fingerRoots('Left'), ik: ['mShoulderLeft', 'mElbowLeft'], ikPole: true },
  );
  add(...buildFingerJoints('Left'));
  add(
    { bone: 'mCollarRight', bvh: 'rCollar', children: ['mShoulderRight'] },
    { bone: 'mShoulderRight', bvh: 'rShldr', children: ['mElbowRight'] },
    { bone: 'mElbowRight', bvh: 'rForeArm', children: ['mWristRight'] },
    { bone: 'mWristRight', bvh: 'rHand', children: fingerRoots('Right'), ik: ['mShoulderRight', 'mElbowRight'], ikPole: true },
  );
  add(...buildFingerJoints('Right'));
  add(
    { bone: 'mHipLeft', bvh: 'lThigh', children: ['mKneeLeft'] },
    { bone: 'mKneeLeft', bvh: 'lShin', children: ['mAnkleLeft'] },
    { bone: 'mAnkleLeft', bvh: 'lFoot', children: ['mFootLeft'], ik: ['mHipLeft', 'mKneeLeft'], ikPole: true },
    { bone: 'mFootLeft', bvh: 'lToe', end: [0, -0.4, 1.2] },
    { bone: 'mHipRight', bvh: 'rThigh', children: ['mKneeRight'] },
    { bone: 'mKneeRight', bvh: 'rShin', children: ['mAnkleRight'] },
    { bone: 'mAnkleRight', bvh: 'rFoot', children: ['mFootRight'], ik: ['mHipRight', 'mKneeRight'], ikPole: true },
    { bone: 'mFootRight', bvh: 'rToe', end: [0, -0.4, 1.2] },
  );
  return j;
}

const JOINTS = buildJoints();
const BY_BONE = new Map(JOINTS.map((j) => [j.bone, j]));

// "mHandIndex2Left" → "Left Hand Index 2", "mNeck" → "Neck": a readable name for
// the selection readout in the toolbar.
function humanizeBone(bone) {
  let s = bone.replace(/^m/, '');
  let side = '';
  if (s.endsWith('Left')) { side = 'Left '; s = s.slice(0, -4); }
  else if (s.endsWith('Right')) { side = 'Right '; s = s.slice(0, -5); }
  s = s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return (side + s).trim();
}

// Which .dae owns the authoritative pose for each bone. Arms are a connected
const MARKER_FK = 0x7aa2f7;
const MARKER_IK = 0x9ece6a;
const MARKER_POLE = 0xff9e64; // elbow/knee pole handles
const MARKER_PLANTED = 0x2ac3de; // pinned-in-place hand/foot
const MARKER_FOOTROLL = 0xbb9af7; // foot-roll handles (drag up = toe-off)
const MARKER_HEAD = 0xe0af68; // head-aim target
const MARKER_HOVER = 0xffffff;
const LOOKAT_COLOR = 0xf7768e;
const SOFT_IK_FRAC = 0.08; // fraction of max reach over which extension softens
const FOOT_ROLL_K = 4.5; // handle metres of lift → radians of roll
const FOOT_ROLL_MIN = -0.7; // heel rock (toes up)
const FOOT_ROLL_MAX = 1.3; // toe-off (heel up)
const HEAD_AIM_NECK = 0.4; // share of the head-aim rotation the neck takes
const HEAD_AIM_MAX_YAW = 1.2;
const HEAD_AIM_MAX_PITCH = 0.8;
// Joint limits, measured as deviation from each bone's rest pose split into
// swing (bend off the rest direction) and twist (roll about the bone's long
// axis). Per-joint [swing°, twist°]: the leg/arm joints stay wide on the axes
// the analytic IK actually uses (a real squat needs ~120° of hip twist, ~115°
// knee flex), while FK-dominant joints (neck, spine, collar, hands…) and the
// twist of the extremities are pulled in tight, since that's where bad mouse
// moves spin things. NOT yet a true one-way hinge — see notes by _clampBone.
const DEG = Math.PI / 180;
const LIMIT_DEFAULT = [90, 60];
const LIMITS = {
  mPelvis: [45, 55],
  mTorso: [55, 45], mChest: [55, 45],
  mNeck: [55, 55], mHead: [50, 50],
  mCollarLeft: [30, 25], mCollarRight: [30, 25],
  mShoulderLeft: [125, 100], mShoulderRight: [125, 100],
  mElbowLeft: [150, 50], mElbowRight: [150, 50],
  mWristLeft: [75, 80], mWristRight: [75, 80],
  mHipLeft: [120, 130], mHipRight: [120, 130],
  mKneeLeft: [150, 45], mKneeRight: [150, 45],
  mAnkleLeft: [55, 45], mAnkleRight: [55, 45],
  mFootLeft: [45, 25], mFootRight: [45, 25],
};
// Bento fingers (mHand<Finger><n><Side>): modest bend, almost no twist.
function limitFor(bone) {
  const l = LIMITS[bone] ?? (bone.startsWith('mHand') ? [95, 18] : LIMIT_DEFAULT);
  return [l[0] * DEG, l[1] * DEG];
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
// soft-reach temps (kept clear of the CCD temps above)
const _sa = new THREE.Vector3();
const _se = new THREE.Vector3();
const _softTarget = new THREE.Vector3();
// pole-correction temps
const _ka = new THREE.Vector3();
const _kAxis = new THREE.Vector3();
const _kb = new THREE.Vector3();
// foot-roll temps
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _ff = new THREE.Vector3();
const _fu = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _fGoal = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
// head-aim temps
const _ha = new THREE.Vector3();
const _hd = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const HEAD_FWD = new THREE.Vector3(1, 0, 0); // head/neck local "face" axis (same as the eyes)
// analytic two-bone temps
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _tDir = new THREE.Vector3();
const _tBend = new THREE.Vector3();
const _tKnee = new THREE.Vector3();
const _tGoal = new THREE.Vector3();
// joint-limit temps
const _ld = new THREE.Quaternion();
const _lt = new THREE.Quaternion();
const _ls = new THREE.Quaternion();
const _ltmp = new THREE.Quaternion();
const _lsv = new THREE.Vector3();

export class AnimEditor {
  constructor({ avatar, scene, camera, renderer, orbit, status, onExit }) {
    this.avatar = avatar;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.orbit = orbit;
    this.status = status;
    this.onExit = onExit; // fired after exit() so the host can resume its controller

    this.active = false;
    this.playing = false;
    this.time = 0;
    this.duration = 4;
    this.ikEnabled = true;
    this.limitsEnabled = true; // anatomical-ish joint-angle guard-rails
    this._axisFor = null; // Map(boneName -> local long axis), built on enter
    this.keys = []; // { time, rot: { boneName: Quaternion }, hip: Vector3 } sorted by time
    this._undo = []; // snapshots of {pose, keys, duration} for undo/redo
    this._redo = [];
    this.selected = null; // selected JOINTS entry
    this._gizmoMode = 'rotate';
    this._hovered = null;
    this._limbs = null; // Map(effectorBone -> limb rig), built lazily on enter
    this._dragLimb = null; // limb whose handle/pole the gizmo currently drives
    this._poleSelected = null; // limb whose pole marker is selected, if any
    this.lookAtEnabled = false;
    this._lookAtSelected = false;
    this._lookAtInit = false;
    this.headAimEnabled = false;
    this._headAimSelected = false;
    this._headAimInit = false;

    this._buildMarkers();
    this._buildLookAt();
    this._buildHeadAim();
    this._buildGizmo();
    this._bindDOM();
    this._bindPointer();
  }

  // ---- setup ---------------------------------------------------------

  // Wrists/fingers and ankles/toes live on the hands/feet .dae parts, not body.
  _partFor(boneName) {
    return this.avatar.parts[partForBone(boneName)];
  }

  _bone(boneName) {
    return this._partFor(boneName)?.bones.get(boneName) ?? null;
  }

  _rest(boneName) {
    return this._partFor(boneName)?.rest.get(boneName) ?? null;
  }

  _buildMarkers() {
    this.markers = new THREE.Group();
    this.markers.visible = false;
    const geoBody = new THREE.SphereGeometry(0.02, 16, 12);
    const geoFinger = new THREE.SphereGeometry(0.008, 12, 8);
    for (const j of JOINTS) {
      if (!this._bone(j.bone)) continue;
      const mat = new THREE.MeshBasicMaterial({
        color: j.ik ? MARKER_IK : MARKER_FK,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      });
      const m = new THREE.Mesh(j.finger ? geoFinger : geoBody, mat);
      m.renderOrder = 999;
      m.userData.joint = j;
      this.markers.add(m);
    }
    this.scene.add(this.markers);
  }

  _buildLookAt() {
    this.lookAtTarget = new THREE.Object3D();
    this.lookAtTarget.name = 'lookAtTarget';
    const mat = new THREE.MeshBasicMaterial({
      color: LOOKAT_COLOR,
      depthTest: false,
      transparent: true,
      opacity: 0.92,
    });
    this.lookAtMarker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 18, 14), mat);
    this.lookAtMarker.renderOrder = 1000;
    this.lookAtTarget.add(this.lookAtMarker);
    this.lookAtTarget.visible = false;
    this.scene.add(this.lookAtTarget);
  }

  _buildHeadAim() {
    this.headAimTarget = new THREE.Object3D();
    this.headAimTarget.name = 'headAimTarget';
    const mat = new THREE.MeshBasicMaterial({
      color: MARKER_HEAD, depthTest: false, transparent: true, opacity: 0.92,
    });
    this.headAimMarker = new THREE.Mesh(new THREE.SphereGeometry(0.04, 18, 14), mat);
    this.headAimMarker.renderOrder = 1000;
    this.headAimTarget.add(this.headAimMarker);
    this.headAimTarget.visible = false;
    this.scene.add(this.headAimTarget);
  }

  _buildGizmo() {
    this._ikHelper = new THREE.Object3D();
    this._ikHelper.name = 'ikGizmoTarget';
    this.scene.add(this._ikHelper);

    this.tc = new TransformControls(this.camera, this.renderer.domElement);
    this.tc.setSize(0.6);
    this.tc.setSpace('local');
    this.tcHelper = this.tc.getHelper();
    this.tcHelper.visible = false;
    this.scene.add(this.tcHelper);
    this.tc.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      const obj = this.tc.object;
      const overlay = obj === this.lookAtTarget || obj === this.headAimTarget;
      if (this.active && !overlay) {
        if (e.value) this._pushUndo(); // snapshot before the drag mutates the pose
        else if (obj) this.writeKey(); // commit a key on release
      }
    });
    // Live gizmo drag: IK handle (place/orient the hand), pole (swing the
    // elbow/knee), or the hip (drag the body, pinned limbs stay planted).
    this.tc.addEventListener('objectChange', () => this._onGizmoChange());
  }

  // Drag dispatch: figure out what the gizmo is attached to and re-solve.
  _onGizmoChange() {
    if (!this.active) return;
    const obj = this.tc.object;
    if (obj === this._bone('mPelvis')) { this._onHipMove(); return; }
    const limb = this._dragLimb;
    if (!limb || !this.ikEnabled) {
      // FK rotate (or bend-chain rotate): gizmo is attached straight to the bone
      if (this.limitsEnabled && this.selected && obj === this._bone(this.selected.bone)) {
        this._clampBone(this.selected.bone);
        this._syncParts();
        this.avatar.group.updateMatrixWorld(true);
      }
      return;
    }
    if (obj === this._ikHelper) {
      limb.goal.copy(this._ikHelper.position);
      this._ikHelper.getWorldQuaternion(limb.orient);
      this._solveLimb(limb);
    } else if (limb.pole && obj === limb.pole) {
      this._solveLimb(limb);
    } else if (limb.foot && obj === limb.foot.handle) {
      // vertical handle drag → roll angle (up = toe-off, down = heel rock)
      limb.foot.roll = THREE.MathUtils.clamp(
        (limb.foot.handle.position.y - limb.foot.baseY) * FOOT_ROLL_K, FOOT_ROLL_MIN, FOOT_ROLL_MAX);
      this._solveLimb(limb, false);
    } else {
      return;
    }
    this._syncParts();
    // hands/feet and body are separate scene roots — update the whole avatar.
    this.avatar.group.updateMatrixWorld(true);
  }

  // Moving the hip drags the body; any pinned hand/foot is re-solved back onto
  // its stored world goal so it stays planted (floating-base posing).
  _onHipMove() {
    this._syncParts();
    this.avatar.group.updateMatrixWorld(true);
    let solved = false;
    for (const limb of this._limbs?.values() ?? []) {
      if (!limb.planted) continue;
      this._solveLimb(limb, false); // exact: keep the foot/hand on its goal
      solved = true;
    }
    if (solved) {
      this._syncParts();
      this.avatar.group.updateMatrixWorld(true);
    }
  }

  // ---- IK limb rig -----------------------------------------------------

  // Build one rig per wrist/ankle: the two-bone chain, its max reach, and a
  // draggable pole + a stored goal/orientation. Bones live on the same .dae as
  // the effector (hands / feet), so the whole chain shares a scene root.
  _ensureLimbs() {
    if (this._limbs) return;
    this._limbs = new Map();
    this._poleGroup = new THREE.Group();
    this._poleGroup.visible = false;
    this.scene.add(this._poleGroup);
    this._footGroup = new THREE.Group(); // foot-roll handles
    this._footGroup.visible = false;
    this.scene.add(this._footGroup);
    const poleGeo = new THREE.SphereGeometry(0.016, 14, 10);
    const footGeo = new THREE.SphereGeometry(0.02, 14, 10);
    for (const j of JOINTS) {
      if (!j.ik) continue;
      // effector may be a child of the deepest chain bone (finger tip, neck base)
      const effPart = this._partFor(j.ikEffector ?? j.bone);
      const effector = effPart?.bones.get(j.ikEffector ?? j.bone);
      const part = this._partFor(j.bone);
      const chain = j.ik.map((name) => part?.bones.get(name)).filter(Boolean);
      if (!effector || chain.length < 2) continue;
      // Pole limbs (wrists/ankles) also keep a held world orientation; bend
      // chains (spine, fingers) just reach a position and leave rotation free.
      let pole = null;
      if (j.ikPole) {
        const mat = new THREE.MeshBasicMaterial({
          color: MARKER_POLE, depthTest: false, transparent: true, opacity: 0.85,
        });
        pole = new THREE.Mesh(poleGeo, mat);
        pole.renderOrder = 999;
        this._poleGroup.add(pole);
      }
      const limb = {
        joint: j, effector, chain, root: part.root, bend: !!j.ikBend,
        maxReach: this._chainReach(chain, effector),
        pole, goal: new THREE.Vector3(), orient: new THREE.Quaternion(),
        poleInit: false, planted: false, foot: null,
      };
      if (pole) pole.userData.limb = limb;
      // Ankle limbs get a reverse-foot roll control + a draggable handle.
      const ballBone = part?.bones.get(j.children?.[0] ?? '');
      if (j.bone.startsWith('mAnkle') && ballBone) {
        const mat = new THREE.MeshBasicMaterial({
          color: MARKER_FOOTROLL, depthTest: false, transparent: true, opacity: 0.85,
        });
        const handle = new THREE.Mesh(footGeo, mat);
        handle.renderOrder = 999;
        this._footGroup.add(handle);
        limb.foot = {
          ball: ballBone, handle, roll: 0, baseY: 0,
          ballLocal: new THREE.Vector3(), relQ: new THREE.Quaternion(), measured: false,
        };
        handle.userData.footLimb = limb;
      }
      this._limbs.set(j.bone, limb);
    }
  }

  // Measure the foot's ball offset + toe droop in the ankle's frame, once, from
  // the rest pose — used to derive roll pivots wherever the foot is later placed.
  _measureFoot(limb) {
    const f = limb.foot;
    if (!f || f.measured) return;
    const ankle = limb.effector;
    ankle.getWorldPosition(_fa);
    ankle.getWorldQuaternion(_q0);
    f.ball.getWorldPosition(_fb);
    f.ballLocal.copy(_fb).sub(_fa).applyQuaternion(_q1.copy(_q0).invert());
    f.ball.getWorldQuaternion(_q1);
    f.relQ.copy(_q0).invert().multiply(_q1); // ball orientation relative to ankle
    f.measured = true;
  }

  // Max straight-line reach: sum of segment lengths root → … → effector.
  // Rotation-invariant, so the rest pose gives the true limit.
  _chainReach(chain, effector) {
    const pts = [...chain, effector];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      pts[i].getWorldPosition(_v0);
      pts[i + 1].getWorldPosition(_v1);
      total += _v0.distanceTo(_v1);
    }
    return total;
  }

  // Seed the pole 25cm out in the limb's current bend direction, so turning
  // poles on (or first grabbing the limb) leaves the pose unchanged.
  _initPole(limb) {
    if (!limb.pole || limb.poleInit) return;
    limb.chain[0].getWorldPosition(_ka); // A: shoulder / hip
    limb.effector.getWorldPosition(_kAxis); // E: wrist / ankle
    _kAxis.sub(_ka); // A → E
    const al = _kAxis.length();
    if (al > 1e-6) _kAxis.divideScalar(al);
    limb.chain[1].getWorldPosition(_kb); // B: elbow / knee
    _kb.sub(_ka); // B − A
    _kb.addScaledVector(_kAxis, -_kb.dot(_kAxis)); // drop the along-axis part
    if (_kb.length() < 1e-4) _kb.set(0, 0, 1); // straight limb fallback
    _kb.normalize();
    limb.chain[1].getWorldPosition(limb.pole.position);
    limb.pole.position.addScaledVector(_kb, 0.25);
    limb.poleInit = true;
  }

  // Activate a limb's hand handle: snap it to the effector and seed the stored
  // goal/orientation from the current pose so dragging starts without a pop.
  _activateLimb(limb) {
    this._dragLimb = limb;
    this._initPole(limb);
    limb.effector.getWorldPosition(this._ikHelper.position);
    limb.effector.getWorldQuaternion(this._ikHelper.quaternion);
    limb.goal.copy(this._ikHelper.position);
    limb.orient.copy(this._ikHelper.quaternion);
  }

  // Full per-limb solve: reach the goal, swing the mid joint onto the pole,
  // then stamp the held world orientation onto the effector. `soft` eases the
  // approach to full extension (good for interactive drags); pass false for
  // planted re-solves, which want the effector exactly on its stored goal.
  //
  // Foot limbs add a reverse-foot roll: the stored goal/orient are the FLAT
  // foot; roll pivots the ankle about the ball (toe-off) or heel (rock) so the
  // contact stays planted, and the toe bone counter-rotates to stay flat.
  _solveLimb(limb, soft = true) {
    let target = limb.goal;
    let orient = limb.orient;
    if (limb.foot && limb.foot.roll) {
      const rolled = this._footRollTarget(limb);
      target = rolled.pos;
      orient = rolled.quat;
    }
    if (limb.pole) {
      // arms/legs: analytic two-bone solve gives a singularity-free, pole-correct
      // pose; a short CCD pass then refines the effector onto the exact target
      // (the analytic placement assumes rigid bones, so non-uniform scale leaves
      // it a couple cm off). Starting bent, CCD can't fall back into the straight
      // singularity. Finally stamp the held world orientation onto the effector.
      this._solveTwoBone(limb, target, soft);
      this._solveIK(limb, target, soft);
      this._orientEffector(limb, orient);
    } else {
      this._solveIK(limb, target, soft); // bend chains (spine, fingers): CCD
    }
    if (limb.foot) this._applyToeCounter(limb);
    if (this.limitsEnabled) {
      for (const b of limb.chain) this._clampBone(b.name);
      this._clampBone(limb.effector.name);
    }
  }

  // Analytic two-bone IK. chain = [upper, lower], effector is the lower bone's
  // child, so rotating `upper` moves `lower` and rotating `lower` moves the
  // effector — exact, iteration-free, and singularity-proof. The knee/elbow is
  // placed in the plane through (root, target, pole) on the pole side.
  _solveTwoBone(limb, target, soft) {
    const { chain, effector, pole } = limb;
    const upper = chain[0];
    const lower = chain[1];
    upper.getWorldPosition(_t0); // A (root)
    lower.getWorldPosition(_t1); // B (mid)
    effector.getWorldPosition(_t2); // E
    const l1 = _t0.distanceTo(_t1); // measured from the current pose
    const l2 = _t1.distanceTo(_t2);
    _tDir.copy(target).sub(_t0); // A → target
    let d = _tDir.length();
    if (d < 1e-6) return;
    _tDir.divideScalar(d); // unit reach direction
    if (soft) d = this._softReach(d, l1 + l2);
    d = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    // knee offset from the A→target line (law of cosines)
    const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    // bend direction: pole component perpendicular to the reach axis
    pole.getWorldPosition(_tBend);
    _tBend.sub(_t0); // P − A
    _tBend.addScaledVector(_tDir, -_tBend.dot(_tDir)); // drop the along-axis part
    if (_tBend.lengthSq() < 1e-9) { // pole on the axis — pick any perpendicular
      _tBend.set(0, 1, 0).addScaledVector(_tDir, -_tDir.y);
      if (_tBend.lengthSq() < 1e-9) _tBend.set(1, 0, 0).addScaledVector(_tDir, -_tDir.x);
    }
    _tBend.normalize();
    _tKnee.copy(_t0).addScaledVector(_tDir, a).addScaledVector(_tBend, h); // new mid
    _tGoal.copy(_t0).addScaledVector(_tDir, d); // clamped target
    // upper: aim A→B at A→knee, which carries the mid joint to _tKnee
    this._rotateBoneDir(upper, _t1.sub(_t0), _t3.copy(_tKnee).sub(_t0));
    upper.updateMatrixWorld(true);
    // lower: aim B→E at knee→target
    lower.getWorldPosition(_t1);
    effector.getWorldPosition(_t2);
    this._rotateBoneDir(lower, _t2.sub(_t1), _t3.copy(_tGoal).sub(_t1));
    lower.updateMatrixWorld(true);
  }

  // Soft falloff on a scalar reach distance (see _softGoal for the rationale).
  _softReach(d, maxReach) {
    const s = maxReach * SOFT_IK_FRAC;
    const da = maxReach - s;
    return d > da ? maxReach - s * Math.exp(-(d - da) / s) : d;
  }

  // Rotate `bone` (about its own origin) so the world vector `from` aligns to
  // `to`, via the parent-frame transfer parent⁻¹·delta·parent.
  _rotateBoneDir(bone, from, to) {
    const lf = from.length();
    const lt = to.length();
    if (lf < 1e-9 || lt < 1e-9) return;
    _q0.setFromUnitVectors(from.divideScalar(lf), to.divideScalar(lt));
    bone.parent.getWorldQuaternion(_q1);
    bone.quaternion.premultiply(_q1.clone().invert().multiply(_q0).multiply(_q1));
  }

  // ---- joint limits ----------------------------------------------------

  // Each bone's local long axis = direction to its first child (constant bind
  // offset), used as the twist axis. Built once from the rest skeleton.
  _ensureAxes() {
    if (this._axisFor) return;
    this._axisFor = new Map();
    for (const j of JOINTS) {
      const childName = j.children?.[0] ?? j.endBone;
      if (!childName) continue;
      const child = this._bone(childName);
      if (!child || child.position.lengthSq() < 1e-10) continue;
      this._axisFor.set(j.bone, child.position.clone().normalize());
    }
  }

  // Clamp a bone's deviation from rest to its per-joint [swing, twist] range.
  // Bones with a long axis get a proper swing/twist split; the few without
  // (head, fingertips, toes) fall back to a single total-angle cap. No-op when
  // already within limits. NB: swing is still a symmetric cone, so leg/arm
  // joints stay wide to avoid fighting IK (a real squat uses ~120° hip twist).
  // Making hips/knees feel truly "locked" needs limit-aware IK — a later pass.
  _clampBone(boneName) {
    const bone = this._bone(boneName);
    const rest = this._rest(boneName);
    if (!bone || !rest) return;
    const [maxSwing, maxTwist] = limitFor(boneName);
    const axis = this._axisFor?.get(boneName);
    if (axis) this._clampSwingTwist(bone, rest, axis, maxSwing, maxTwist);
    else this._clampTotalAngle(bone, rest, Math.max(maxSwing, maxTwist));
  }

  // Split (rest⁻¹·q) into twist about `axis` + swing, clamp each, recompose.
  _clampSwingTwist(bone, rest, axis, maxSwing, maxTwist) {
    _ld.copy(rest.q).invert().multiply(bone.quaternion); // deviation from rest
    if (_ld.w < 0) _ld.set(-_ld.x, -_ld.y, -_ld.z, -_ld.w); // canonical hemisphere
    const vdot = _ld.x * axis.x + _ld.y * axis.y + _ld.z * axis.z;
    let twist = 2 * Math.atan2(vdot, _ld.w);
    if (twist > Math.PI) twist -= 2 * Math.PI;
    else if (twist < -Math.PI) twist += 2 * Math.PI;
    _lt.setFromAxisAngle(axis, twist); // original twist
    _ls.copy(_ld).multiply(_ltmp.copy(_lt).invert()); // swing = delta · twist⁻¹
    if (_ls.w < 0) _ls.set(-_ls.x, -_ls.y, -_ls.z, -_ls.w);
    let changed = false;
    const swing = 2 * Math.acos(THREE.MathUtils.clamp(_ls.w, -1, 1));
    if (swing > maxSwing) {
      _lsv.set(_ls.x, _ls.y, _ls.z);
      if (_lsv.lengthSq() > 1e-12) { _lsv.normalize(); _ls.setFromAxisAngle(_lsv, maxSwing); changed = true; }
    }
    const ct = THREE.MathUtils.clamp(twist, -maxTwist, maxTwist);
    if (ct !== twist) { _lt.setFromAxisAngle(axis, ct); changed = true; }
    if (!changed) return;
    bone.quaternion.copy(rest.q).multiply(_ls.multiply(_lt));
  }

  _clampTotalAngle(bone, rest, maxAngle) {
    _ld.copy(rest.q).invert().multiply(bone.quaternion);
    if (_ld.w < 0) _ld.set(-_ld.x, -_ld.y, -_ld.z, -_ld.w);
    if (2 * Math.acos(THREE.MathUtils.clamp(_ld.w, -1, 1)) <= maxAngle) return;
    _lsv.set(_ld.x, _ld.y, _ld.z);
    if (_lsv.lengthSq() < 1e-12) return;
    bone.quaternion.copy(rest.q).multiply(_ld.setFromAxisAngle(_lsv.normalize(), maxAngle));
  }

  // Clamp every posable joint (used when limits are toggled on).
  _clampAll() {
    if (!this._axisFor) return;
    for (const j of JOINTS) this._clampBone(j.bone);
  }

  // Roll geometry: returns the rolled ankle position + orientation for the
  // current limb.foot.roll, pivoting about the ball (roll>0) or heel (roll<0).
  _footRollTarget(limb) {
    const f = limb.foot;
    this._measureFoot(limb);
    // flat ankle world pose is the stored goal/orient
    _fa.copy(limb.goal); // flat ankle pos
    _fb.copy(f.ballLocal).applyQuaternion(limb.orient).add(_fa); // ball world
    _ff.copy(_fb).sub(_fa); _ff.y = 0; // horizontal toe-forward
    if (_ff.lengthSq() < 1e-8) _ff.set(0, 0, 1);
    _ff.normalize();
    _fu.copy(_UP).cross(_ff).normalize(); // medial-lateral roll axis
    if (limb.foot.roll >= 0) {
      _fp.copy(_fb); // pivot on the ball → heel lifts
    } else {
      _fp.set(_fa.x, _fb.y, _fa.z).addScaledVector(_ff, -0.05); // heel pivot
    }
    _fq.setFromAxisAngle(_fu, f.roll);
    _fGoal.copy(_fa).sub(_fp).applyQuaternion(_fq).add(_fp); // rolled ankle pos
    return { pos: _fGoal, quat: _hq.copy(_fq).multiply(limb.orient) };
  }

  // Keep the toes flat during toe-off (roll>0): hold the ball/toe bone at the
  // FLAT foot orientation while the ankle above it rolls up. On a heel rock the
  // foot pivots rigidly, so the toe rides along (no counter).
  _applyToeCounter(limb) {
    const f = limb.foot;
    if (!f || f.roll <= 0) return;
    const ball = f.ball;
    if (!ball.parent) return;
    ball.parent.getWorldQuaternion(_q1);
    // flat toe world orientation = flat ankle orient · (ball-relative-to-ankle)
    _q0.copy(limb.orient).multiply(f.relQ);
    ball.quaternion.copy(_q1.invert()).multiply(_q0);
  }

  // Stamp a world orientation onto the effector so Move keeps the hand/foot
  // facing the same way and Rotate re-aims it. Defaults to the limb's stored
  // orientation; foot-roll passes the rolled orientation instead.
  _orientEffector(limb, orient = limb.orient) {
    const eff = limb.effector;
    if (!eff.parent) return;
    eff.parent.getWorldQuaternion(_q1);
    eff.quaternion.copy(_q1.invert()).multiply(orient);
  }

  _bindDOM() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      lookat: $('lookat-enabled'), lookatTab: document.querySelector('.tab-btn[data-tab="tab-lookat"]'),
      play: $('tl-play'), track: $('tl-track'), keys: $('tl-keys'),
      playhead: $('tl-playhead'), time: $('tl-time'), key: $('tl-key'), delkey: $('tl-delkey'),
      keymoved: $('tl-keymoved'), undo: $('tl-undo'), redo: $('tl-redo'),
      ik: $('tl-ik'), pin: $('tl-pin'), head: $('tl-head'), limits: $('tl-limits'),
      duration: $('tl-duration'),
      rot: $('tl-gizmo-rot'), move: $('tl-gizmo-move'), sel: $('tl-selected'),
      save: $('tl-save'), exit: $('tl-exit'),
    };

    this.el.lookat?.addEventListener('change', () => this._setLookAt(this.el.lookat.checked));
    this.el.head?.addEventListener('click', () => this._setHeadAim(!this.headAimEnabled));
    this.el.play.addEventListener('click', () => this.setPlaying(!this.playing));
    this.el.key.addEventListener('click', () => { this._pushUndo(); this.writeKey(); });
    this.el.keymoved?.addEventListener('click', () => { this._pushUndo(); this.writeKey(true); });
    this.el.delkey.addEventListener('click', () => this.deleteKeyNearPlayhead());
    this.el.undo?.addEventListener('click', () => this.undo());
    this.el.redo?.addEventListener('click', () => this.redo());
    this.el.exit.addEventListener('click', () => this.exit());
    this.el.save.addEventListener('click', () => this.saveBVH());
    this.el.ik.addEventListener('change', () => {
      this.ikEnabled = this.el.ik.checked;
      if (this._poleGroup) this._poleGroup.visible = this.active && this.ikEnabled;
      if (this._footGroup) this._footGroup.visible = this.active && this.ikEnabled;
      if (!this.ikEnabled && (this._poleSelected || this._dragLimb?.foot)) this._select(null);
      if (this.selected) this._applyGizmoMode();
    });
    this.el.pin?.addEventListener('click', () => this._togglePin());
    this.el.limits?.addEventListener('change', () => {
      this.limitsEnabled = this.el.limits.checked;
      if (this.limitsEnabled && this.active) {
        this._clampAll();
        this._syncParts();
        this.avatar.group.updateMatrixWorld(true);
      }
      this.status.textContent = this.limitsEnabled
        ? 'Joint limits on — rotations are kept within safe ranges'
        : 'Joint limits off — free rotation (watch for unnatural spins)';
    });
    this.el.duration.addEventListener('change', () => {
      this._pushUndo();
      this.duration = THREE.MathUtils.clamp(Number(this.el.duration.value) || 4, 0.5, 60);
      this.el.duration.value = this.duration;
      this.time = Math.min(this.time, this.duration);
      this._renderKeys();
      this._updateTransport();
    });
    this.el.rot.addEventListener('click', () => this._setGizmoMode('rotate'));
    this.el.move.addEventListener('click', () => this._setGizmoMode('translate'));

    // Scrub by clicking/dragging the track.
    this.el.track.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('tl-key')) return;
      this.el.track.setPointerCapture(e.pointerId);
      this.setPlaying(false);
      const scrub = (ev) => this.seek(this._timeFromEvent(ev));
      scrub(e);
      const move = (ev) => scrub(ev);
      const up = () => {
        this.el.track.removeEventListener('pointermove', move);
        this.el.track.removeEventListener('pointerup', up);
      };
      this.el.track.addEventListener('pointermove', move);
      this.el.track.addEventListener('pointerup', up);
    });

    window.addEventListener('keydown', (e) => {
      if (!this.active || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      else if (e.code === 'Space') { e.preventDefault(); this.setPlaying(!this.playing); }
      else if (e.key === 'Escape') this._select(null);
      else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteKeyNearPlayhead();
    });
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
  }

  // ---- mode ----------------------------------------------------------

  enter() {
    if (this.active) return;
    this.active = true;
    this.avatar.stop();
    document.body.classList.add('bvh-mode');
    this.markers.visible = true;
    // build the IK rigs and seed pole/foot handles against the current rest pose
    this._ensureLimbs();
    this._ensureAxes();
    this.avatar.group.updateMatrixWorld(true);
    for (const limb of this._limbs.values()) {
      // The avatar may have walked around since the last session (poles/feet are
      // stored in world space), so re-seed them against the current pose each
      // entry instead of trusting the first session's captured positions.
      limb.poleInit = false;
      if (limb.foot) limb.foot.measured = false;
      this._initPole(limb);
      this._measureFoot(limb);
    }
    this._poleGroup.visible = this.ikEnabled;
    this._footGroup.visible = this.ikEnabled;
    this._setSelLabel(null);
    this._undo.length = 0;
    this._redo.length = 0;
    this._updateUndoButtons();
    this.setPlaying(false);
    this._renderKeys();
    this._updateTransport();
    this.status.textContent =
      'BVH editor — green = IK hand/foot, orange = pole, purple = foot-roll; Pin plants a limb; Head turns the gaze';
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.playing = false;
    if (this.tc.object === this.lookAtTarget) {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    if (this.tc.object === this.headAimTarget) {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    this._lookAtSelected = false;
    this._headAimSelected = false;
    this._select(null);
    this._dragLimb = null;
    if (this._poleGroup) this._poleGroup.visible = false;
    if (this._footGroup) this._footGroup.visible = false;
    for (const limb of this._limbs?.values() ?? []) { limb.planted = false; if (limb.foot) limb.foot.roll = 0; }
    this.markers.visible = false;
    document.body.classList.remove('bvh-mode');
    this.orbit.enabled = true;
    // back to rest pose on every part (keys are kept for the next session)
    for (const part of Object.values(this.avatar.parts)) {
      for (const [name, bone] of part.bones) {
        const rest = part.rest.get(name);
        if (rest) bone.quaternion.copy(rest.q);
      }
      const pelvis = part.bones.get('mPelvis');
      const rest = part.rest.get('mPelvis');
      if (pelvis && rest) pelvis.position.copy(rest.p);
    }
    this.avatar.pecPhysics.reset();
    this.status.textContent = this.keys.length
      ? `left BVH editor (${this.keys.length} keys kept)`
      : 'left BVH editor';
    this.onExit?.(); // host resumes locomotion / re-enables input
  }

  // Re-point the editor at a different avatar (used when the active avatar is
  // switched). Only valid while inactive; the IK limb rig and any captured
  // keys are dropped so the next enter() rebuilds against the new skeleton.
  setAvatar(avatar) {
    if (this.active) this.exit();
    this.avatar = avatar;
    this._limbs = null;   // rebuilt lazily on next enter()
    this.keys = [];       // pose keys belong to the previous avatar
    // Reflect the new avatar's own look-at state in the marker + checkbox, so
    // toggling eye-tracking is per-avatar and survives switching.
    this.lookAtEnabled = avatar.lookAt.enabled;
    this.lookAtTarget.visible = avatar.lookAt.enabled;
    this._syncMarkerFromAvatar();
    if (this.el.lookat) this.el.lookat.checked = avatar.lookAt.enabled;
    this.el.lookatTab?.classList.toggle('lookat-on', avatar.lookAt.enabled);
  }

  // ---- look-at target --------------------------------------------------

  // Eye look-at now lives on the avatar (avatar.lookAt) so it's per-avatar — the
  // editor just owns the draggable marker, which mirrors the ACTIVE avatar's
  // target. Seed a target in front of the head if the avatar has none yet.
  _syncMarkerFromAvatar() {
    const la = this.avatar.lookAt;
    if (la.target.lengthSq() === 0) {
      const head = this._bone('mHead');
      if (head) {
        this.avatar.group.updateMatrixWorld(true);
        head.getWorldPosition(la.target);
        la.target.x += 1.0;
        la.target.z += 0.08;
      }
    }
    this.lookAtTarget.position.copy(la.target);
  }

  _initLookAtPosition() { this._syncMarkerFromAvatar(); }

  setLookAtEnabled(enabled) {
    this._setLookAt(enabled);
  }

  setLookAtPoint(x, y, z) {
    this._syncMarkerFromAvatar();
    this.lookAtTarget.position.set(x, y, z);
    this.avatar.lookAt.target.copy(this.lookAtTarget.position);
  }

  getLookAtPoint() {
    return {
      enabled: this.avatar.lookAt.enabled,
      position: this.avatar.lookAt.target.toArray(),
    };
  }

  _setLookAt(enabled) {
    this.lookAtEnabled = enabled;
    this.avatar.lookAt.enabled = enabled; // avatar.update() does the eye aiming
    if (this.el.lookat) this.el.lookat.checked = enabled;
    this.el.lookatTab?.classList.toggle('lookat-on', enabled);
    this.lookAtTarget.visible = enabled;
    if (enabled) {
      this._syncMarkerFromAvatar();
      this._selectLookAt();
    } else {
      this._lookAtSelected = false;
      if (this.tc.object === this.lookAtTarget) {
        this.tc.detach();
        if (!this.selected) this.tcHelper.visible = false;
        else this._applyGizmoMode();
        this._setSelLabel(this.selected ? this._jointLabel(this.selected) : null);
      }
      // the avatar restores its eyes to rest on the next update()
    }
  }

  _selectLookAt() {
    this.selected = null;
    this._lookAtSelected = true;
    this._dragLimb = null;
    this._poleSelected = null;
    for (const m of this.markers.children) {
      m.scale.setScalar(1);
      m.material.color.setHex(this._baseColor(m.userData.joint));
    }
    this._refreshPoleColors();
    this.tc.attach(this.lookAtTarget);
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tcHelper.visible = true;
    this._setSelLabel('Eye look-at target');
    this.status.textContent = 'Look at — drag gizmo to move the eye target';
  }

  // ---- head / gaze aim --------------------------------------------------

  _initHeadAimPosition() {
    const head = this._bone('mHead');
    if (!head) return;
    head.getWorldPosition(this.headAimTarget.position);
    this.headAimTarget.position.z += 0.9; // a little out in front
    this.headAimTarget.position.y += 0.05;
  }

  setHeadAimEnabled(enabled) { this._setHeadAim(enabled); }

  _setHeadAim(enabled) {
    this.headAimEnabled = enabled;
    if (this.el.head) this.el.head.classList.toggle('active', enabled);
    this.headAimTarget.visible = enabled;
    if (enabled) {
      if (!this._headAimInit) { this._initHeadAimPosition(); this._headAimInit = true; }
      this._selectHeadAim();
    } else {
      this._headAimSelected = false;
      if (this.tc.object === this.headAimTarget) {
        this.tc.detach();
        if (!this.selected) this.tcHelper.visible = false;
        else this._applyGizmoMode();
        this._setSelLabel(this.selected ? this._jointLabel(this.selected) : null);
      }
      this._restoreHead();
    }
  }

  _selectHeadAim() {
    this.selected = null;
    this._lookAtSelected = false;
    this._poleSelected = null;
    this._dragLimb = null;
    this._headAimSelected = true;
    if (!this._headAimInit) { this._initHeadAimPosition(); this._headAimInit = true; }
    for (const m of this.markers.children) {
      m.scale.setScalar(1);
      m.material.color.setHex(this._baseColor(m.userData.joint));
    }
    this._refreshPoleColors();
    this.tc.attach(this.headAimTarget);
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tcHelper.visible = true;
    this._updatePinButton();
    this._setSelLabel('Head aim target');
    this.status.textContent = 'Head aim — drag the gizmo; neck + head turn to face the target';
  }

  _restoreHead() {
    for (const name of ['mNeck', 'mHead']) {
      const bone = this._bone(name);
      const rest = this._rest(name);
      if (bone && rest) bone.quaternion.copy(rest.q);
    }
    this._syncParts();
  }

  // Turn neck + head to face the target: the neck takes a share (HEAD_AIM_NECK)
  // of the turn, the head completes it. Applied after the pose each frame so it
  // composes on top of FK / spine IK (which only set the neck's position).
  _applyHeadAim() {
    const target = this.headAimTarget.position;
    const neck = this._bone('mNeck');
    const neckRest = this._rest('mNeck');
    if (neck && neckRest) this._aimBoneAt(neck, neckRest, target, HEAD_AIM_NECK);
    this._syncParts();
    this.avatar.group.updateMatrixWorld(true);
    const head = this._bone('mHead');
    const headRest = this._rest('mHead');
    if (head && headRest) this._aimBoneAt(head, headRest, target, 1);
    this._syncParts();
  }

  // Rotate a spine bone from rest so its local HEAD_FWD axis points at the
  // target (in the bone's parent frame), scaled by `frac` and clamped.
  _aimBoneAt(bone, rest, targetWorld, frac) {
    if (!bone.parent) return;
    bone.parent.updateMatrixWorld(true);
    _m4.copy(bone.parent.matrixWorld).invert();
    _ha.copy(targetWorld).applyMatrix4(_m4);
    _hd.copy(_ha).sub(rest.p);
    const len = _hd.length();
    if (len < 1e-6) return;
    _hd.divideScalar(len);
    _q0.setFromUnitVectors(HEAD_FWD, _hd);
    _e.setFromQuaternion(_q0, 'YXZ');
    _e.x = 0;
    _e.y = THREE.MathUtils.clamp(_e.y * frac, -HEAD_AIM_MAX_YAW, HEAD_AIM_MAX_YAW);
    _e.z = THREE.MathUtils.clamp(_e.z * frac, -HEAD_AIM_MAX_PITCH, HEAD_AIM_MAX_PITCH);
    bone.quaternion.copy(rest.q).multiply(_hq.setFromEuler(_e));
  }

  // ---- selection / gizmo ----------------------------------------------

  // Toolbar readout of what the gizmo currently controls.
  _setSelLabel(text) {
    if (!this.el.sel) return;
    this.el.sel.textContent = text || 'Nothing selected';
    this.el.sel.classList.toggle('tl-sel-none', !text);
  }

  // Readable name + manipulator kind for a selected joint marker.
  _jointLabel(joint) {
    const name = humanizeBone(joint.bone);
    if (!joint.ik) return `${name} · FK rotate`;
    const limb = this._limbs?.get(joint.bone);
    if (limb?.foot) return `${name} · IK foot`;
    if (limb?.bend) return `${name} · spine IK`;
    return `${name} · IK ${this._gizmoMode === 'translate' ? 'place' : 'aim'}`;
  }

  // Resting colour for a joint marker: cyan if its limb is pinned, else the
  // green/blue IK/FK base.
  _baseColor(joint) {
    if (joint.ik && this._limbs?.get(joint.bone)?.planted) return MARKER_PLANTED;
    return joint.ik ? MARKER_IK : MARKER_FK;
  }

  _select(joint) {
    this._lookAtSelected = false;
    this._poleSelected = null;
    this.selected = joint;
    for (const m of this.markers.children) {
      const isSel = joint && m.userData.joint === joint;
      m.scale.setScalar(isSel ? 1.5 : 1);
      m.material.color.setHex(isSel ? MARKER_HOVER : this._baseColor(m.userData.joint));
    }
    this._refreshPoleColors();
    if (!joint) {
      this.tc.detach();
      this.tcHelper.visible = false;
      this._dragLimb = null;
      this._updatePinButton();
      this._setSelLabel(null);
      return;
    }
    this.tcHelper.visible = true;
    this._applyGizmoMode();
    this._updatePinButton();
    this._setSelLabel(this._jointLabel(joint));
  }

  // Select a limb's pole handle: drag it to swing the elbow/knee. The hand
  // stays at its stored goal; only the limb-plane angle changes.
  _selectPole(limb) {
    this.selected = null;
    this._lookAtSelected = false;
    this._poleSelected = limb;
    this._dragLimb = limb;
    this._initPole(limb);
    // hold the hand/foot where it is while the pole swings the elbow/knee
    limb.effector.getWorldPosition(limb.goal);
    limb.effector.getWorldQuaternion(limb.orient);
    for (const m of this.markers.children) {
      m.scale.setScalar(1);
      m.material.color.setHex(this._baseColor(m.userData.joint));
    }
    this._refreshPoleColors();
    this.tc.attach(limb.pole);
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tcHelper.visible = true;
    this._updatePinButton();
    this._setSelLabel(`${humanizeBone(limb.chain[1].name)} · pole`);
    this.status.textContent = 'Pole — drag to swing the elbow / knee; the hand stays put';
  }

  _refreshPoleColors() {
    if (!this._poleGroup) return;
    for (const p of this._poleGroup.children) {
      const sel = this._poleSelected === p.userData.limb;
      p.scale.setScalar(sel ? 1.5 : 1);
      p.material.color.setHex(sel ? MARKER_HOVER : MARKER_POLE);
    }
  }

  // Select a foot-roll handle: drag it vertically to roll the foot (up = heel
  // lifts / toe-off, down = heel rock). The contact point stays planted.
  _selectFootRoll(limb) {
    this.selected = null;
    this._lookAtSelected = false;
    this._poleSelected = null;
    this._dragLimb = limb;
    this._measureFoot(limb);
    // snapshot the flat foot as the roll base, and anchor the handle above it
    limb.effector.getWorldPosition(limb.goal);
    limb.effector.getWorldQuaternion(limb.orient);
    limb.effector.getWorldPosition(_fa);
    limb.foot.baseY = _fa.y + 0.22;
    limb.foot.handle.position.set(_fa.x, limb.foot.baseY + limb.foot.roll / FOOT_ROLL_K, _fa.z);
    for (const m of this.markers.children) {
      m.scale.setScalar(1);
      m.material.color.setHex(this._baseColor(m.userData.joint));
    }
    this._refreshPoleColors();
    this._footGroup.visible = true;
    this.tc.attach(limb.foot.handle);
    this.tc.setMode('translate');
    this.tc.setSpace('world');
    this.tcHelper.visible = true;
    this._updatePinButton();
    this._setSelLabel(`${humanizeBone(limb.joint.bone)} · roll`);
    this.status.textContent = 'Foot roll — drag up for toe-off (heel lifts), down to rock onto the heel';
  }

  // Pin / unpin the active limb. Pinned limbs freeze their current world goal
  // and orientation and are re-solved back onto it whenever the hip moves.
  _togglePin() {
    const limb = this._dragLimb;
    if (!limb) {
      this.status.textContent = 'select a green hand/foot (or its pole) first, then Pin';
      return;
    }
    limb.planted = !limb.planted;
    // capture the current pose as the planted goal; for a rolled foot the
    // effector is the rolled ankle, so keep the stored flat goal instead.
    if (limb.planted && (!limb.foot || !limb.foot.roll)) {
      limb.effector.getWorldPosition(limb.goal);
      limb.effector.getWorldQuaternion(limb.orient);
    }
    this._updatePinButton();
    // recolour the effector marker (cyan when planted) unless it's selected
    for (const m of this.markers.children) {
      if (m.userData.joint === limb.joint && m.userData.joint !== this.selected) {
        m.material.color.setHex(this._baseColor(m.userData.joint));
      }
    }
    this.status.textContent = limb.planted
      ? `${limb.joint.bone} pinned — stays planted when you move the hip`
      : `${limb.joint.bone} unpinned`;
  }

  _updatePinButton() {
    this.el.pin?.classList.toggle('active', !!this._dragLimb?.planted);
  }

  _setGizmoMode(mode) {
    this._gizmoMode = mode;
    this.el.rot.classList.toggle('active', mode === 'rotate');
    this.el.move.classList.toggle('active', mode === 'translate');
    if (this.selected) { this._gizmoStatusHint(); this._setSelLabel(this._jointLabel(this.selected)); }
    this._applyGizmoMode();
  }

  _gizmoStatusHint() {
    const j = this.selected;
    if (!j) return;
    if (this._gizmoMode === 'translate' && j.bone === 'mPelvis') {
      this.status.textContent = 'Move — drag to reposition the hip; pinned hands/feet stay planted';
    } else if (this._gizmoMode === 'translate' && j.ik && this.ikEnabled) {
      this.status.textContent = 'Move — IK-place the hand/foot; drag the orange pole to aim the elbow/knee';
    } else if (this._gizmoMode === 'translate' && j.ik && !this.ikEnabled) {
      this.status.textContent = 'Enable IK to place limbs in Move mode — using Rotate instead';
    } else if (j.ik && this.ikEnabled) {
      this.status.textContent = 'Rotate — aim the wrist/ankle in place; switch to Move to IK-place it';
    } else if (j.ik) {
      this.status.textContent = 'Rotate — turn the wrist/ankle (IK off)';
    } else {
      this.status.textContent = 'Rotate — turn the selected joint';
    }
  }

  _applyGizmoMode() {
    if (!this.selected) return;
    const j = this.selected;
    const hipMove = this._gizmoMode === 'translate' && j.bone === 'mPelvis';
    const limb = j.ik && this.ikEnabled ? this._limbs?.get(j.bone) : null;

    this._dragLimb = null;
    if (hipMove) {
      this.tc.attach(this._bone('mPelvis'));
      this.tc.setMode('translate');
      this.tc.setSpace('world');
      return;
    }
    // IK joint. Move always drives the handle (position solve). Rotate re-aims
    // a pole limb's effector in world space; on a bend chain (spine/finger)
    // there's no orientation lock, so Rotate just falls back to FK on the joint.
    if (limb && (this._gizmoMode === 'translate' || !limb.bend)) {
      this._activateLimb(limb);
      this.tc.attach(this._ikHelper);
      if (this._gizmoMode === 'translate') {
        this.tc.setMode('translate');
        this.tc.setSpace('world');
      } else {
        this.tc.setMode('rotate');
        this.tc.setSpace('local');
      }
      return;
    }
    const bone = this._bone(j.bone);
    if (bone) {
      this.tc.attach(bone);
      this.tc.setMode('rotate');
      this.tc.setSpace('local');
    }
  }

  // ---- pointer: hover, pick, IK drag -----------------------------------

  _setRayFromEvent(e) {
    _ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  _pickMarker(e) {
    this._setRayFromEvent(e);
    if (this.lookAtEnabled) {
      const look = _ray.intersectObject(this.lookAtMarker, false)[0];
      if (look) return look.object;
    }
    if (this.headAimEnabled) {
      const head = _ray.intersectObject(this.headAimMarker, false)[0];
      if (head) return head.object;
    }
    if (!this.active) return null;
    const hit = _ray.intersectObjects(this.markers.children, false)[0];
    if (hit) return hit.object;
    // pole / foot-roll handles are only live (and pickable) while IK is on
    if (this.ikEnabled && this._poleGroup?.visible) {
      const pole = _ray.intersectObjects(this._poleGroup.children, false)[0];
      if (pole) return pole.object;
      const foot = _ray.intersectObjects(this._footGroup.children, false)[0];
      if (foot) return foot.object;
    }
    return null;
  }

  _resetMarkerColor(mesh) {
    if (mesh === this.lookAtMarker) {
      mesh.material.color.setHex(LOOKAT_COLOR);
      return;
    }
    if (mesh === this.headAimMarker) {
      mesh.material.color.setHex(MARKER_HEAD);
      return;
    }
    if (mesh.userData.limb) {
      mesh.material.color.setHex(
        this._poleSelected === mesh.userData.limb ? MARKER_HOVER : MARKER_POLE);
      return;
    }
    if (mesh.userData.footLimb) {
      mesh.material.color.setHex(MARKER_FOOTROLL);
      return;
    }
    const j = mesh.userData.joint;
    if (!j || j === this.selected) return;
    mesh.material.color.setHex(this._baseColor(j));
  }

  _onPointerMove(e) {
    if (!this.active && !this.lookAtEnabled && !this.headAimEnabled) return;
    if (this.tc.dragging) return;
    const m = this._pickMarker(e);
    if (m !== this._hovered) {
      if (this._hovered) this._resetMarkerColor(this._hovered);
      this._hovered = m;
      if (m && (m === this.lookAtMarker || m === this.headAimMarker || m.userData.joint !== this.selected)) {
        m.material.color.setHex(MARKER_HOVER);
      }
      this.renderer.domElement.style.cursor = m ? 'grab' : '';
    }
    // hovering a marker mutes orbit so pointerdown starts a pose drag
    this.orbit.enabled = !m;
  }

  _onPointerDown(e) {
    if ((!this.active && !this.lookAtEnabled && !this.headAimEnabled) || e.button !== 0 || this.tc.dragging) return;
    const m = this._pickMarker(e);
    if (!m) return;
    this.setPlaying(false);
    if (m === this.lookAtMarker) {
      this._selectLookAt();
      return;
    }
    if (m === this.headAimMarker) {
      this._selectHeadAim();
      return;
    }
    if (m.userData.limb) {
      this._selectPole(m.userData.limb);
      return;
    }
    if (m.userData.footLimb) {
      this._selectFootRoll(m.userData.footLimb);
      return;
    }
    this._select(m.userData.joint);
    this._gizmoStatusHint();
  }

  // Cyclic coordinate descent: swing each chain bone toward the target,
  // deepest joint first (elbow/knee before shoulder/hip).
  _solveIK(limb, target, soft = true) {
    const { effector, chain, root, maxReach } = limb;
    const goal = this._softGoal(chain[0], target, maxReach, soft);
    for (let iter = 0; iter < 24; iter++) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const bone = chain[i];
        if (!bone?.parent) continue;
        effector.getWorldPosition(_v0);
        bone.getWorldPosition(_v1);
        const toEffector = _v0.sub(_v1);
        const toTarget = _v2.copy(goal).sub(_v1);
        const lenE = toEffector.length();
        const lenT = toTarget.length();
        if (lenE < 1e-6 || lenT < 1e-6) continue;
        toEffector.divideScalar(lenE);
        toTarget.divideScalar(lenT);
        if (toEffector.dot(toTarget) > 0.9999) continue;
        const deltaWorld = _q0.setFromUnitVectors(toEffector, toTarget);
        bone.parent.getWorldQuaternion(_q1);
        bone.quaternion.premultiply(_q1.clone().invert().multiply(deltaWorld).multiply(_q1));
      }
      root.updateMatrixWorld(true);
      if (effector.getWorldPosition(_v0).distanceTo(goal) < 0.004) break;
    }
  }

  // Reach-limit the goal along the root→target ray. With `soft`, ease toward
  // full extension instead of hard-clamping: inside (reach − s) the goal is
  // untouched; past it the distance asymptotes to maxReach, so the limb glides
  // straight without the snap/pop a hard clamp produces. Without `soft`, clamp
  // exactly at maxReach — used for planted re-solves that must hit their goal.
  _softGoal(root, target, maxReach, soft = true) {
    if (!(maxReach > 1e-6)) return target;
    root.getWorldPosition(_sa);
    _se.copy(target).sub(_sa);
    const d = _se.length();
    if (d < 1e-6) return target;
    let d2 = d;
    if (soft) {
      const s = maxReach * SOFT_IK_FRAC;
      const da = maxReach - s;
      if (d > da) d2 = maxReach - s * Math.exp(-(d - da) / s);
    } else if (d > maxReach) {
      d2 = maxReach;
    }
    if (d2 === d) return target;
    return _softTarget.copy(_sa).addScaledVector(_se, d2 / d);
  }

  // ---- keyframes -------------------------------------------------------

  // Capture the current pose for a keyframe. With `onlyPosed`, include only the
  // bones (and hip) that differ from rest, so the key is sparse — letting you
  // key just the body parts you moved and leave the rest to other keys.
  _capturePose(onlyPosed = false) {
    const rot = {};
    for (const j of JOINTS) {
      const bone = this._bone(j.bone);
      if (!bone) continue;
      if (onlyPosed) {
        const rest = this._rest(j.bone);
        if (rest && rest.q.angleTo(bone.quaternion) < POSE_EPS) continue;
      }
      rot[j.bone] = bone.quaternion.clone();
    }
    const pelvis = this._bone('mPelvis');
    const restP = this._rest('mPelvis');
    const hipMoved = !(onlyPosed && restP && restP.p.distanceTo(pelvis.position) < HIP_EPS);
    return { rot, hip: hipMoved ? pelvis.position.clone() : null };
  }

  // ---- undo / redo -----------------------------------------------------

  _cloneKeys() {
    return this.keys.map((k) => ({
      time: k.time,
      hip: k.hip.clone(),
      rot: Object.fromEntries(Object.entries(k.rot).map(([n, q]) => [n, q.clone()])),
    }));
  }

  // Full editable state: the live pose plus the keyframes/duration/playhead.
  _snapshot() {
    return { pose: this._capturePose(), keys: this._cloneKeys(), duration: this.duration, time: this.time };
  }

  _restore(s) {
    for (const j of JOINTS) {
      const bone = this._bone(j.bone);
      if (bone && s.pose.rot[j.bone]) bone.quaternion.copy(s.pose.rot[j.bone]);
    }
    this._bone('mPelvis').position.copy(s.pose.hip);
    this.keys = s.keys.map((k) => ({
      time: k.time,
      hip: k.hip.clone(),
      rot: Object.fromEntries(Object.entries(k.rot).map(([n, q]) => [n, q.clone()])),
    }));
    this.duration = s.duration;
    if (this.el.duration) this.el.duration.value = this.duration;
    this.time = Math.min(s.time, this.duration);
    this._syncParts();
    this.avatar.group.updateMatrixWorld(true);
    this._renderKeys();
    this._updateTransport();
  }

  // Call before any state-changing edit. Snapshots the current state and drops
  // the redo branch.
  _pushUndo() {
    this._undo.push(this._snapshot());
    if (this._undo.length > 80) this._undo.shift();
    this._redo.length = 0;
    this._updateUndoButtons();
  }

  undo() {
    if (!this._undo.length) { this.status.textContent = 'nothing to undo'; return; }
    this.setPlaying(false);
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    this._updateUndoButtons();
    this.status.textContent = `undo (${this._undo.length} left)`;
  }

  redo() {
    if (!this._redo.length) { this.status.textContent = 'nothing to redo'; return; }
    this.setPlaying(false);
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    this._updateUndoButtons();
    this.status.textContent = 'redo';
  }

  _updateUndoButtons() {
    if (this.el.undo) this.el.undo.disabled = !this._undo.length;
    if (this.el.redo) this.el.redo.disabled = !this._redo.length;
  }

  writeKey(onlyPosed = false) {
    const pose = this._capturePose(onlyPosed);
    const n = Object.keys(pose.rot).length;
    const tag = onlyPosed ? ` (${n} moved bone${n === 1 ? '' : 's'})` : '';
    const existing = this.keys.find((k) => Math.abs(k.time - this.time) < KEY_MERGE_EPS);
    if (existing) {
      existing.rot = pose.rot;
      existing.hip = pose.hip;
      this.status.textContent = `key updated at ${existing.time.toFixed(2)}s${tag}`;
    } else {
      this.keys.push({ time: this.time, ...pose });
      this.keys.sort((a, b) => a.time - b.time);
      this.status.textContent = `key added at ${this.time.toFixed(2)}s${tag} (${this.keys.length} total)`;
    }
    this._renderKeys();
  }

  deleteKeyNearPlayhead() {
    if (!this.keys.length) return;
    let best = null;
    for (const k of this.keys) {
      if (!best || Math.abs(k.time - this.time) < Math.abs(best.time - this.time)) best = k;
    }
    if (Math.abs(best.time - this.time) > Math.max(0.15, this.duration / 40)) {
      this.status.textContent = 'no key at the playhead';
      return;
    }
    this._pushUndo();
    this.keys.splice(this.keys.indexOf(best), 1);
    this.status.textContent = `key at ${best.time.toFixed(2)}s deleted`;
    this._renderKeys();
    if (this.keys.length) this._applyPoseAt(this.time);
  }

  // Interpolated pose (slerp / lerp between surrounding keys) onto each joint's
  // canonical part, then fan out to every .dae copy via _syncParts.
  _applyPoseAt(t) {
    const ks = this.keys;
    if (!ks.length) return;
    let k0 = ks[0];
    let k1 = ks[ks.length - 1];
    let u = 0;
    if (t <= k0.time) k1 = k0;
    else if (t >= k1.time) k0 = k1;
    else {
      for (let i = 0; i < ks.length - 1; i++) {
        if (t >= ks[i].time && t <= ks[i + 1].time) {
          k0 = ks[i];
          k1 = ks[i + 1];
          u = (t - k0.time) / Math.max(k1.time - k0.time, 1e-6);
          break;
        }
      }
    }
    // Bones (and the hip) a key doesn't mention fall back to rest, so sparse
    // "key moved" keyframes leave untouched body parts at rest and blend in/out
    // of pose naturally.
    for (const j of JOINTS) {
      const bone = this._bone(j.bone);
      if (!bone) continue;
      const rest = this._rest(j.bone);
      const a = k0.rot[j.bone] ?? rest?.q;
      const b = k1.rot[j.bone] ?? rest?.q;
      if (a && b) bone.quaternion.slerpQuaternions(a, b, u);
    }
    const restP = this._rest('mPelvis');
    const ha = k0.hip ?? restP?.p;
    const hb = k1.hip ?? restP?.p;
    if (ha && hb) this._bone('mPelvis').position.lerpVectors(ha, hb, u);
    this._syncParts();
  }

  // ---- transport / timeline UI ------------------------------------------

  setPlaying(playing) {
    this.playing = playing && this.active;
    this.el.play.textContent = this.playing ? '❚❚' : '▶';
    this.el.play.classList.toggle('active', this.playing);
  }

  seek(t) {
    this.time = THREE.MathUtils.clamp(t, 0, this.duration);
    if (this.keys.length) this._applyPoseAt(this.time);
    this._updateTransport();
  }

  _timeFromEvent(e) {
    const r = this.el.track.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * this.duration;
  }

  _updateTransport() {
    this.el.playhead.style.left = `${(this.time / this.duration) * 100}%`;
    this.el.time.textContent = `${this.time.toFixed(2)} / ${this.duration.toFixed(1)}s`;
  }

  _renderKeys() {
    this.el.keys.innerHTML = '';
    for (const key of this.keys) {
      const el = document.createElement('div');
      el.className = 'tl-key';
      el.style.left = `${(key.time / this.duration) * 100}%`;
      el.title = `${key.time.toFixed(2)}s — drag to retime, click to jump`;
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.setPlaying(false);
        let moved = false;
        const move = (ev) => {
          if (!moved) this._pushUndo(); // snapshot before the first retime move
          moved = true;
          key.time = THREE.MathUtils.clamp(this._timeFromEvent(ev), 0, this.duration);
          el.style.left = `${(key.time / this.duration) * 100}%`;
          this.seek(key.time);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (moved) {
            this.keys.sort((a, b) => a.time - b.time);
            this._renderKeys();
          }
          this.seek(key.time);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      this.el.keys.appendChild(el);
    }
  }

  // ---- per-frame -------------------------------------------------------

  update(dt) {
    if (!this.active) {
      // Look-at eye aiming is done by avatar.update(); the editor only feeds the
      // active avatar's target from the draggable marker. Head-aim stays here.
      if (this.lookAtEnabled) this.avatar.lookAt.target.copy(this.lookAtTarget.position);
      if (this.headAimEnabled) {
        this.avatar.group.updateMatrixWorld(true);
        this._applyHeadAim();
        this.avatar.group.updateMatrixWorld(true);
      }
      return;
    }
    if (this.playing && this.duration > 0) {
      this.time = (this.time + dt) % this.duration;
      this._applyPoseAt(this.time);
      this._updateTransport();
    }
    this._syncParts();
    this.avatar.group.updateMatrixWorld(true);
    // head aim composes on top of the posed neck/head, before markers follow
    if (this.headAimEnabled) {
      this._applyHeadAim();
      this.avatar.group.updateMatrixWorld(true);
    }
    // when idle, keep the IK handle riding the effector so re-grabbing is seamless
    if (this._dragLimb && this.tc.object === this._ikHelper && !this.tc.dragging) {
      this._dragLimb.effector.getWorldPosition(this._ikHelper.position);
      this._dragLimb.effector.getWorldQuaternion(this._ikHelper.quaternion);
    }
    for (const m of this.markers.children) {
      this._bone(m.userData.joint.bone)?.getWorldPosition(m.position);
    }
    // foot-roll handles ride above each foot when not being dragged
    if (this._footGroup?.visible) {
      for (const limb of this._limbs.values()) {
        const f = limb.foot;
        if (!f || (this.tc.object === f.handle && this.tc.dragging)) continue;
        limb.effector.getWorldPosition(_fa);
        f.baseY = _fa.y + 0.22;
        f.handle.position.set(_fa.x, f.baseY + f.roll / FOOT_ROLL_K, _fa.z);
      }
    }
    // feed the active avatar's look-at target from the draggable marker; the
    // eye aiming itself happens in avatar.update().
    if (this.lookAtEnabled) this.avatar.lookAt.target.copy(this.lookAtTarget.position);
  }

  // Copy each posed joint from its canonical part onto every other part that
  // carries a bone with the same name (each .dae has its own skeleton copy).
  _syncParts() {
    for (const j of JOINTS) {
      const src = this._bone(j.bone);
      if (!src) continue;
      for (const part of Object.values(this.avatar.parts)) {
        if (part.grafted) continue;
        const dst = part.bones.get(j.bone);
        if (dst && dst !== src) {
          dst.quaternion.copy(src.quaternion);
          if (j.bone === 'mPelvis') dst.position.copy(src.position);
        }
      }
    }
  }

  // ---- BVH export ------------------------------------------------------

  saveBVH() {
    if (!this.keys.length) {
      this.status.textContent = 'add at least one key before saving';
      return;
    }
    const text = this._buildBVH();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ruth-animation.bvh';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.status.textContent = `saved ruth-animation.bvh (${this.duration.toFixed(1)}s, ${this.keys.length} keys)`;
  }

  _endOffsetInches(j) {
    const num = (v) => +v.toFixed(4);
    if (j.endBone) {
      const rest = this._rest(j.endBone);
      if (rest) {
        const v = _v0.copy(rest.p).applyQuaternion(CInv).divideScalar(INCH);
        return `${num(v.x)} ${num(v.y)} ${num(v.z)}`;
      }
    }
    if (j.end) return j.end.join(' ');
    return '0 0.5 0';
  }

  _buildBVH() {
    const num = (v) => +v.toFixed(4);
    const motionOrder = []; // depth-first joint order, mirrors the hierarchy

    const offset = (boneName) => {
      const rest = this._rest(boneName);
      if (!rest) return '0 0 0';
      const v = _v0.copy(rest.p).applyQuaternion(CInv).divideScalar(INCH);
      return `${num(v.x)} ${num(v.y)} ${num(v.z)}`;
    };

    const writeJoint = (boneName, depth, lines) => {
      const j = BY_BONE.get(boneName);
      const tab = '\t'.repeat(depth);
      if (depth === 0) {
        lines.push(`ROOT ${j.bvh}`, '{', '\tOFFSET 0 0 0',
          '\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation');
      } else {
        lines.push(`${tab}JOINT ${j.bvh}`, `${tab}{`, `${tab}\tOFFSET ${offset(boneName)}`,
          `${tab}\tCHANNELS 3 Zrotation Xrotation Yrotation`);
      }
      motionOrder.push(j);
      for (const child of j.children ?? []) writeJoint(child, depth + 1, lines);
      if (j.end || j.endBone) {
        lines.push(`${tab}\tEnd Site`, `${tab}\t{`,
          `${tab}\t\tOFFSET ${this._endOffsetInches(j)}`, `${tab}\t}`);
      }
      lines.push(`${tab}}`);
    };

    const lines = ['HIERARCHY'];
    writeJoint('mPelvis', 0, lines);

    const frames = Math.max(2, Math.round(this.duration * EXPORT_FPS) + 1);
    lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${(1 / EXPORT_FPS).toFixed(6)}`);

    const deg = THREE.MathUtils.radToDeg;
    for (let f = 0; f < frames; f++) {
      this._applyPoseAt(Math.min(f / EXPORT_FPS, this.duration));
      const vals = [];
      const hip = _v0.copy(this._bone('mPelvis').position).applyQuaternion(CInv).divideScalar(INCH);
      vals.push(num(hip.x), num(hip.y), num(hip.z));
      for (const j of motionOrder) {
        const bone = this._bone(j.bone);
        if (!bone) continue;
        // q_bvh = C⁻¹ · q_ruth · C, written as the Z X Y channels
        _q0.copy(CInv).multiply(bone.quaternion).multiply(C);
        _e.setFromQuaternion(_q0, 'ZXY');
        vals.push(num(deg(_e.z)), num(deg(_e.x)), num(deg(_e.y)));
      }
      lines.push(vals.join(' '));
    }

    // leave the scene showing the playhead pose, not the last sampled frame
    this._applyPoseAt(this.time);
    return lines.join('\n') + '\n';
  }
}
