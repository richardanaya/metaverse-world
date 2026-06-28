// AvatarEditor — a floating, tabbed sidebar to customize the avatar, opened from
// the right-click menu ("Edit avatar…").
//
//   • Shape tab — every shape slider from the library's SLIDERS list, organized
//     into collapsible groups (Body, Head, Lips, Torso, Arms, Legs, …) so they're
//     easy to find, plus Female / Male presets and Reset. Edits apply live via
//     avatar.applyShape().
//   • Appearance tab — per-region PBR map slots (Base Color / Normal / Roughness /
//     Metallic / AO). Click a slot or drag-and-drop an image onto it; each slot
//     shows a thumbnail preview of its current map.
//
// The shape + material model comes straight from the metaverse-avatar studio
// example (SLIDERS / SEX_PRESETS / PBR_CHANNELS, applyShape, setSkinMap, …).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SLIDERS, SEX_PRESETS, PBR_CHANNELS } from 'metaverse-avatar';
import { showPanel, hidePanel } from './panelFade.js';

const REGION_LABELS = { face: 'Face', upper: 'Upper body', lower: 'Lower body', eyes: 'Eyes' };

const MALE_PRESET_SLIDER_VALUES = {
  'Height': 18,
  'Body Thickness': 92,
  'Head Size': 0,
  'Face Length': 0,
  'Face Width': 12,
  'Forehead Width': 0,
  'Cheekbone Width': 0,
  'Ear Size': 0,
  'Ear Protrusion': 0,
  'Ear Length': 0,
  'Ear Point': 0,
  'Nose Size': 0,
  'Nose Width': 0,
  'Nose Bridge': 0,
  'Nose Tip': 0,
  'Nose Tilt': 0,
  'Jaw Width': 79,
  'Chin Depth': 0,
  'Cheek Fullness': 0,
  'Cheekbones': 0,
  'Cheek Hollows': 0,
  'Eye Size': 0,
  'Eye Spacing': 0,
  'Brow Ridge': 0,
  'Brow Height': 0,
  'Brow Angle': 0,
  'Eye Slant': 0,
  'Eye Opening': 0,
  'Upper Lid Fullness': 0,
  'Left Eye Closed': 0,
  'Right Eye Closed': 0,
  'Torso Length': 67,
  'Shoulders': 38,
  'Breast Size': -100,
  'Breast Spacing': 30,
  'Breast Lift': 0,
  'Nipple': 0,
  'Chest Flatten': 100,
  'Belly Size': 10,
  'Belly Distension': 0,
  'Belly Lift': 0,
  'Waist': 150,
  'Torso Muscles': 80,
  'Neck Length': 0,
  'Neck Thickness': 50,
  'Arm Length': 0,
  'Bicep Size': 50,
  'Forearm Size': 50,
  'Hand Size': 30,
  'Palm Width': 50,
  'Leg Length': 0,
  'Thigh Muscles': 3,
  'Calf Muscles': 85,
  'Butt Size': -17,
  'Butt Lift': 0,
  'Hip Width': -38,
  'Foot Size': 10,
};

const MALE_PRESET_OVERRIDES = Object.fromEntries(
  Object.entries(MALE_PRESET_SLIDER_VALUES)
    .map(([label, value]) => [SLIDERS.find((s) => s.label === label)?.id, value / 100])
    .filter(([id]) => id),
);

function solidMap(r, g, b) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, 2, 2);
  return canvas;
}

// Load an <img> from a chosen File (object URL, revoked once decoded).
// Load an <img> from a chosen File. Resolves { img, url } and keeps the object
// URL alive (the caller revokes it) so the same URL can back a slot preview.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) { reject(new Error('not an image')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

// Small thumbnail data URL for a slot preview, drawn from an existing map image.
// Cross-origin source images (the CDN default skins) taint the canvas, so the
// caller treats a throw as "no thumbnail".
function previewDataUrl(image, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

export class AvatarEditor {
  constructor({ avatar, player, renderer = null, camera = null, controls = null, scene = null }) {
    this.avatar = avatar;
    this.player = player;
    this.renderer = renderer;
    this.camera = camera;
    this.controls = controls;
    this.scene = scene;
    this.active = false;
    this.sliderState = {};   // id -> t (-1.5..1.5)
    this._inputs = new Map(); // id -> range input (for preset / reset sync)
    this._gltfLoader = new GLTFLoader();
    this._pendingAttachment = null; // { file, object, name }
    this._attachments = [];
    this._editingAttachment = null;
    this._attachGizmo = null;
    this.worldEditor = null;

    // One shared hidden file input, re-targeted per upload.
    this._file = document.createElement('input');
    this._file.type = 'file';
    this._file.accept = 'image/*';
    this._file.style.display = 'none';
    document.body.appendChild(this._file);

    this._attachFile = document.createElement('input');
    this._attachFile.type = 'file';
    this._attachFile.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
    this._attachFile.style.display = 'none';
    document.body.appendChild(this._attachFile);

    this._build();
    this._buildAttachmentGizmo();
  }

  open() { this.active = true; showPanel(this.panel); this.player?.enterPose(); }
  close() { this._stopAttachmentEdit(); this.active = false; hidePanel(this.panel); this.player?.exitPose(); }

  _buildAttachmentGizmo() {
    if (!this.camera || !this.renderer || !this.scene) return;
    this._attachGizmo = new TransformControls(this.camera, this.renderer.domElement);
    this._attachGizmo.setSpace('local');
    this._attachGizmo.setSize(0.75);
    this._attachGizmo.addEventListener('dragging-changed', (e) => {
      if (this.controls) this.controls.enabled = !e.value;
    });
    this.scene.add(this._attachGizmo.getHelper());
  }

  _pickFile(onFile) {
    this._file.value = '';
    this._file.onchange = () => { const f = this._file.files[0]; if (f) onFile(f); };
    this._file.click();
  }

  // ---- panel scaffold -------------------------------------------------
  _build() {
    this.panel = document.createElement('div');
    this.panel.className = 'avatar-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'avatar-panel-title';
    title.textContent = 'Avatar';
    this.panel.appendChild(title);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'avatar-tabs';
    this._shapePane = document.createElement('div');
    this._shapePane.className = 'avatar-pane';
    this._lookPane = document.createElement('div');
    this._lookPane.className = 'avatar-pane';
    this._lookPane.style.display = 'none';
    this._attachPane = document.createElement('div');
    this._attachPane.className = 'avatar-pane';
    this._attachPane.style.display = 'none';
    this._physicsPane = document.createElement('div');
    this._physicsPane.className = 'avatar-pane';
    this._physicsPane.style.display = 'none';
    const shapeTab = this._tabButton('Shape', tabs, this._shapePane);
    this._tabButton('Appearance', tabs, this._lookPane);
    this._tabButton('Attachments', tabs, this._attachPane);
    this._tabButton('Physics', tabs, this._physicsPane);
    shapeTab.classList.add('active');
    this.panel.appendChild(tabs);

    this._buildShape(this._shapePane);
    this._buildAppearance(this._lookPane);
    this._buildAttachments(this._attachPane);
    this._buildPhysics(this._physicsPane);
    this.panel.append(this._shapePane, this._lookPane, this._attachPane, this._physicsPane);

    const done = document.createElement('button');
    done.className = 'avatar-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => this.close());
    this.panel.appendChild(done);

    document.body.appendChild(this.panel);
  }

  _tabButton(label, tabs, pane) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      for (const el of tabs.children) el.classList.remove('active');
      b.classList.add('active');
      this._shapePane.style.display = pane === this._shapePane ? 'flex' : 'none';
      this._lookPane.style.display = pane === this._lookPane ? 'flex' : 'none';
      this._attachPane.style.display = pane === this._attachPane ? 'flex' : 'none';
      this._physicsPane.style.display = pane === this._physicsPane ? 'flex' : 'none';
    });
    tabs.appendChild(b);
    return b;
  }

  // ---- Shape tab ------------------------------------------------------
  _buildShape(pane) {
    // Presets
    const presets = document.createElement('div');
    presets.className = 'avatar-presets';
    for (const sex of Object.keys(SEX_PRESETS)) {
      const b = document.createElement('button');
      b.textContent = sex[0].toUpperCase() + sex.slice(1);
      b.addEventListener('click', () => this._applyPreset(sex));
      presets.appendChild(b);
    }
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.className = 'avatar-reset';
    reset.addEventListener('click', () => this._reset());
    presets.appendChild(reset);
    pane.appendChild(presets);

    // Grouped, collapsible sliders (group order follows SLIDERS).
    const groups = new Map();
    for (const def of SLIDERS) {
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }
    let first = true;
    for (const [group, defs] of groups) {
      const details = document.createElement('details');
      details.className = 'avatar-group';
      if (first) { details.open = true; first = false; }
      const summary = document.createElement('summary');
      summary.textContent = `${group} (${defs.length})`;
      details.appendChild(summary);
      for (const def of defs) details.appendChild(this._sliderRow(def));
      pane.appendChild(details);
    }
  }

  _sliderRow(def) {
    const row = document.createElement('label');
    row.className = 'avatar-row';
    const head = document.createElement('div');
    head.className = 'avatar-row-head';
    const cap = document.createElement('span');
    cap.textContent = def.label;
    const val = document.createElement('b');
    val.textContent = '0';
    head.append(cap, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = -150; input.max = 150; input.step = 1; input.value = 0;
    input.addEventListener('input', () => {
      const t = parseInt(input.value, 10) / 100;
      this.sliderState[def.id] = t;
      val.textContent = input.value;
      this.avatar.applyShape(this.sliderState);
    });
    this._inputs.set(def.id, { input, val });
    row.append(head, input);
    return row;
  }

  _applyPreset(sex) {
    const preset = sex === 'male'
      ? { ...SEX_PRESETS[sex], ...MALE_PRESET_OVERRIDES }
      : SEX_PRESETS[sex];
    if (!preset) return;
    for (const [id, t] of Object.entries(preset)) {
      this.sliderState[id] = t;
      const ref = this._inputs.get(id);
      if (ref) { ref.input.value = Math.round(t * 100); ref.val.textContent = ref.input.value; }
    }
    this.avatar.applyShape(this.sliderState);
    if (sex === 'male') this._setAvatarSoftPhysics(false);
    else if (sex === 'female') this._setAvatarSoftPhysics(true);
  }

  _reset() {
    this.sliderState = {};
    for (const { input, val } of this._inputs.values()) { input.value = 0; val.textContent = '0'; }
    this.avatar.applyShape(this.sliderState);
  }

  // ---- Attachments tab -----------------------------------------------
  _buildAttachments(pane) {
    const hint = document.createElement('div');
    hint.className = 'avatar-hint';
    hint.textContent = 'Drop a GLB/GLTF here, choose a bone, then Attach.';
    pane.appendChild(hint);

    this._attachSlot = document.createElement('button');
    this._attachSlot.className = 'avatar-attach-slot';
    this._attachSlot.textContent = 'Drop GLB/GLTF or click to browse';
    pane.appendChild(this._attachSlot);

    this._boneSelect = document.createElement('select');
    this._boneSelect.className = 'avatar-attach-bone';
    pane.appendChild(this._boneSelect);
    this._refreshBoneOptions();

    const attach = document.createElement('button');
    attach.textContent = 'Attach';
    attach.addEventListener('click', () => this._attachPending());
    pane.appendChild(attach);

    this._attachTools = document.createElement('div');
    this._attachTools.className = 'avatar-attach-tools';
    this._attachTools.style.display = 'none';
    for (const [label, mode] of [['Move', 'translate'], ['Rotate', 'rotate'], ['Scale', 'scale']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.mode = mode;
      b.addEventListener('click', () => this._setAttachmentEditMode(mode));
      this._attachTools.appendChild(b);
    }
    pane.appendChild(this._attachTools);

    this._attachList = document.createElement('div');
    this._attachList.className = 'avatar-attach-list';
    pane.appendChild(this._attachList);
    this._refreshAttachmentList();

    const pick = () => {
      this._attachFile.value = '';
      this._attachFile.onchange = () => { const f = this._attachFile.files?.[0]; if (f) this._loadAttachmentFile(f); };
      this._attachFile.click();
    };
    this._attachSlot.addEventListener('click', pick);
    this._attachSlot.addEventListener('dragover', (e) => { e.preventDefault(); this._attachSlot.classList.add('drop'); });
    this._attachSlot.addEventListener('dragleave', () => this._attachSlot.classList.remove('drop'));
    this._attachSlot.addEventListener('drop', (e) => {
      e.preventDefault();
      this._attachSlot.classList.remove('drop');
      const f = e.dataTransfer?.files?.[0];
      if (f) this._loadAttachmentFile(f);
    });
  }

  _avatarBones() {
    const seen = new Set();
    const bones = [];
    const add = (b) => {
      if (!b?.isBone || seen.has(b.uuid)) return;
      seen.add(b.uuid);
      bones.push(b);
    };
    // Some avatar implementations keep bones under the visible group; others
    // expose them only through SkinnedMesh.skeleton.bones. Gather both so
    // attachments actually parent to animated bones instead of the static root.
    this.avatar.group.traverse((o) => {
      add(o);
      if (o.isSkinnedMesh) for (const b of o.skeleton?.bones ?? []) add(b);
    });
    return bones;
  }

  _refreshBoneOptions() {
    if (!this._boneSelect) return;
    const bones = this._avatarBones();
    this._boneSelect.innerHTML = '';
    for (const b of bones) {
      const opt = document.createElement('option');
      opt.value = b.uuid;
      opt.textContent = b.name || 'Bone';
      this._boneSelect.appendChild(opt);
    }
    const preferred = bones.find((b) => /head/i.test(b.name)) || bones.find((b) => /spine|chest|neck/i.test(b.name));
    if (preferred) this._boneSelect.value = preferred.uuid;
  }

  _selectedBone() {
    const uuid = this._boneSelect?.value;
    return this._avatarBones().find((b) => b.uuid === uuid) ?? this.avatar.group;
  }

  _loadAttachmentFile(file) {
    if (!/\.(glb|gltf)$/i.test(file.name)) return;
    const url = URL.createObjectURL(file);
    this._gltfLoader.load(url, (gltf) => {
      URL.revokeObjectURL(url);
      const object = gltf.scene;
      object.name = file.name.replace(/\.(glb|gltf)$/i, '') || 'Attachment';
      object.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      this._pendingAttachment = { file, object, name: object.name };
      this._attachSlot.textContent = `Ready: ${object.name}`;
      this._attachSlot.classList.add('filled');
    }, undefined, () => {
      URL.revokeObjectURL(url);
      this._attachSlot.textContent = 'Failed to load GLB/GLTF';
    });
  }

  _attachPending() {
    if (!this._pendingAttachment) return;
    this._refreshBoneOptions();
    const object = this._pendingAttachment.object;
    const hasSkin = this._hasSkinnedMesh(object);
    let bone = null;
    let rigged = false;
    if (hasSkin) {
      // Rigged mesh attachment: bind to the avatar's animated bones by
      // name, but do NOT parent under avatar.group. With external avatar bones,
      // parenting the skinned mesh under the moving avatar root can double-apply
      // root motion and make the attachment drift away. Keep it next to the
      // avatar root and let skinning follow the avatar bones.
      (this.avatar.group.parent ?? this.avatar.group).add(object);
      object.position.copy(this.avatar.group.position);
      object.quaternion.copy(this.avatar.group.quaternion);
      object.scale.copy(this.avatar.group.scale);
      object.updateMatrixWorld(true);
      rigged = this._rigSkinnedAttachment(object);
    } else {
      bone = this._selectedBone();
      bone.updateWorldMatrix(true, false);
      bone.add(object);
      // Rigid accessory attachment: parent to the animated bone so it follows the
      // avatar skeleton. Offsets can be edited later; start snapped to the bone.
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
    }
    object.matrixAutoUpdate = true;
    object.updateMatrixWorld(true);
    this._attachments.push({ name: this._pendingAttachment.name, object, bone, rigged });
    this._pendingAttachment = null;
    this._attachSlot.textContent = 'Drop GLB/GLTF or click to browse';
    this._attachSlot.classList.remove('filled');
    this._refreshAttachmentList();
  }

  _hasSkinnedMesh(object) {
    let found = false;
    object.traverse((child) => { if (child.isSkinnedMesh) found = true; });
    return found;
  }

  _rigSkinnedAttachment(object) {
    const avatarBones = new Map(this._avatarBones().map((b) => [b.name, b]));
    let rigged = false;
    object.traverse((child) => {
      if (!child.isSkinnedMesh || !child.skeleton) return;
      const srcBones = child.skeleton.bones;
      const mapped = srcBones.map((b) => avatarBones.get(b.name));
      if (mapped.some(Boolean)) {
        const finalBones = mapped.map((b, i) => b ?? srcBones[i]);
        // Recompute inverse bind matrices from the avatar's current skeleton. The
        // GLB's inverseBindMatrices are for its source armature and can put the
        // mesh off to the side when reused with our avatar bones.
        const skeleton = new THREE.Skeleton(finalBones);
        skeleton.calculateInverses();
        // The avatar bones live outside the imported SkinnedMesh hierarchy, so
        // this must be detached bind mode. In attached mode three assumes the
        // skeleton shares the mesh root transform, which can leave the mesh near
        // the leg but not actually driven by the animated avatar armature.
        child.bindMode = 'detached';
        child.bind(skeleton, child.matrixWorld.clone());
        child.skeleton = skeleton;
        child.frustumCulled = false;
        rigged = true;
      }
    });
    return rigged;
  }

  _startAttachmentEdit(item) {
    if (item.rigged) return;
    if (this.worldEditor?.editExternalAttachment) {
      this.worldEditor.editExternalAttachment(item);
      return;
    }
    if (!this._attachGizmo) return;
    this._stopAttachmentEdit();
    this._editingAttachment = item;
    this._attachGizmo.attach(item.object);
    this._attachGizmo.enabled = true;
    this._attachTools.style.display = 'flex';
    this._setAttachmentEditMode(this._attachGizmo.getMode?.() ?? 'translate');
    this.player?.setInputEnabled?.(false);
    this._refreshAttachmentList();
  }

  _stopAttachmentEdit() {
    if (!this._editingAttachment) return;
    this._attachGizmo?.detach();
    if (this._attachTools) this._attachTools.style.display = 'none';
    this._editingAttachment = null;
    this.player?.setInputEnabled?.(true);
    if (this.controls) this.controls.enabled = true;
    this._refreshAttachmentList();
  }

  _setAttachmentEditMode(mode) {
    if (!this._attachGizmo) return;
    this._attachGizmo.setMode(mode);
    for (const b of this._attachTools?.querySelectorAll('button[data-mode]') ?? []) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
  }

  _detachAttachment(item) {
    this.worldEditor?.unregisterExternalAttachment?.(item);
    if (this._editingAttachment === item) this._stopAttachmentEdit();
    item.object.parent?.remove(item.object);
    const i = this._attachments.indexOf(item);
    if (i >= 0) this._attachments.splice(i, 1);
    this._refreshAttachmentList();
  }

  _refreshAttachmentList() {
    if (!this._attachList) return;
    this._attachList.innerHTML = '';
    if (!this._attachments.length) {
      const empty = document.createElement('div');
      empty.className = 'avatar-hint';
      empty.textContent = 'No attachments.';
      this._attachList.appendChild(empty);
      return;
    }
    for (const item of this._attachments) {
      const row = document.createElement('div');
      row.className = 'avatar-attach-row';
      const name = document.createElement('span');
      name.textContent = item.rigged ? `${item.name} → rigged mesh` : `${item.name} → ${item.bone?.name || 'Avatar'}`;
      const actions = document.createElement('span');
      actions.className = 'avatar-attach-actions';
      const edit = document.createElement('button');
      edit.textContent = this._editingAttachment === item ? 'Done' : 'Edit';
      edit.title = item.rigged ? 'Edit materials' : 'Edit bone-local transform and materials';
      edit.addEventListener('click', () => {
        if (this._editingAttachment === item) this._stopAttachmentEdit();
        else if (item.rigged) this.worldEditor?.editExternalAttachment?.(item, { materialsOnly: true });
        else this._startAttachmentEdit(item);
      });
      actions.appendChild(edit);
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Detach';
      x.addEventListener('click', () => this._detachAttachment(item));
      actions.appendChild(x);
      row.append(name, actions);
      this._attachList.appendChild(row);
    }
  }

  // ---- Physics tab ----------------------------------------------------
  _buildPhysics(pane) {
    const hint = document.createElement('div');
    hint.className = 'avatar-hint';
    hint.textContent = 'Toggle avatar soft-body physics.';
    pane.appendChild(hint);

    this._pecPhysicsToggle = this._physicsToggle('Pec physics', this.avatar.pecPhysics);
    this._glutePhysicsToggle = this._physicsToggle('Glute physics', this.avatar.glutePhysics);
    pane.appendChild(this._pecPhysicsToggle.row);
    pane.appendChild(this._glutePhysicsToggle.row);
  }

  _physicsToggle(label, physics) {
    const row = document.createElement('label');
    row.className = 'avatar-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = physics?.enabled !== false;
    const text = document.createElement('span');
    text.textContent = label;
    const sync = () => row.classList.toggle('is-off', !input.checked);
    input.addEventListener('change', () => {
      if (physics) {
        physics.enabled = input.checked;
        if (!input.checked) physics.reset?.();
      }
      sync();
    });
    sync();
    row.append(input, text);
    return { row, input, sync };
  }

  _setAvatarSoftPhysics(enabled) {
    for (const item of [
      { physics: this.avatar.pecPhysics, toggle: this._pecPhysicsToggle },
      { physics: this.avatar.glutePhysics, toggle: this._glutePhysicsToggle },
    ]) {
      if (!item.physics) continue;
      item.physics.enabled = enabled;
      if (!enabled) item.physics.reset?.();
      if (item.toggle) {
        item.toggle.input.checked = enabled;
        item.toggle.sync();
      }
    }
  }

  // ---- Appearance tab -------------------------------------------------
  // Per-region PBR map slots. Click or drag-and-drop an image onto a slot.
  _buildAppearance(pane) {
    const hint = document.createElement('div');
    hint.className = 'avatar-hint';
    hint.textContent = 'Click or drop an image onto a slot to set that map.';
    pane.appendChild(hint);

    for (const region of this.avatar.getRegions()) {
      const card = document.createElement('div');
      card.className = 'avatar-mat-card';
      const head = document.createElement('div');
      head.className = 'avatar-mat-head';
      const name = document.createElement('span');
      name.textContent = REGION_LABELS[region] ?? region;
      const clr = document.createElement('button');
      clr.textContent = 'Clear';
      clr.className = 'avatar-mat-clear';
      head.append(name, clr);
      card.appendChild(head);

      const slots = document.createElement('div');
      slots.className = 'avatar-slots';
      const made = [];
      const channels = [...PBR_CHANNELS];
      if (['face', 'upper', 'lower'].includes(region)) {
        channels.push({ key: 'alphaMask', label: 'Alpha Mask', short: 'A', custom: true });
      }
      for (const ch of channels) {
        const slot = this._makeSlot(region, ch);
        slots.appendChild(slot);
        made.push(slot);
      }
      clr.addEventListener('click', () => this._clearRegionMaps(region, made));
      card.appendChild(slots);
      pane.appendChild(card);
    }
  }

  _clearRegionMaps(region, slots) {
    const defaults = {
      metal: solidMap(0, 0, 0),
      metallic: solidMap(0, 0, 0),
      roughness: solidMap(255, 255, 255),
      normal: solidMap(128, 128, 255),
      nrm: solidMap(128, 128, 255),
      ao: solidMap(255, 255, 255),
      ambientOcclusion: solidMap(255, 255, 255),
    };
    for (const slot of slots) {
      const fallback = defaults[slot.channelKey];
      if (fallback) slot.setGeneratedMap(fallback);
      else slot.clearMap();
    }
  }

  _setAlphaMask(region, img) {
    const material = this.avatar._regions?.[region]?.material;
    if (!material) return;
    material.userData.alphaMaskTexture?.dispose?.();
    material.userData.alphaMaskTexture = null;
    if (!img) {
      material.alphaMap = null;
      material.transparent = false;
      material.alphaTest = 0;
      material.needsUpdate = true;
      return;
    }
    const texture = new THREE.Texture(img);
    texture.flipY = false;
    texture.needsUpdate = true;
    material.alphaMap = texture;
    material.transparent = true;
    material.alphaTest = 0.5;
    material.userData.alphaMaskTexture = texture;
    material.needsUpdate = true;
  }

  // A PBR map slot: click to pick a file, or drag-and-drop an image onto it.
  // Shows a thumbnail of the current map when one is set.
  _makeSlot(region, ch) {
    const b = document.createElement('button');
    b.className = 'avatar-slot';
    b.title = ch.label;
    const tag = document.createElement('span');
    tag.className = 'avatar-slot-tag';
    tag.textContent = ch.short;
    b.appendChild(tag);

    b.channelKey = ch.key;
    b._url = null;
    const showThumb = (src) => { b.style.backgroundImage = src ? `url(${src})` : ''; b.classList.toggle('filled', !!src); };
    const setUrl = (url) => { if (b._url) URL.revokeObjectURL(b._url); b._url = url; showThumb(url); };

    // Reflect any map the avatar already has (e.g. the default skin). Cross-origin
    // CDN images can't be drawn to a canvas, so fall back to just the filled state.
    const existing = this.avatar.getSkinMap(region, ch.key);
    if (existing) { try { showThumb(previewDataUrl(existing)); } catch { b.classList.add('filled'); } }

    const apply = async (file) => {
      try {
        const { img, url } = await loadImage(file);
        if (ch.key === 'alphaMask') this._setAlphaMask(region, img);
        else this.avatar.setSkinMap(region, ch.key, img);
        setUrl(url); // keep the object URL alive to back the preview
      } catch { /* ignore non-images / decode errors */ }
    };

    b.addEventListener('click', () => this._pickFile(apply));
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (file) apply(file);
    });

    b.setGeneratedMap = (img) => {
      if (ch.key === 'alphaMask') this._setAlphaMask(region, img);
      else this.avatar.setSkinMap(region, ch.key, img);
      setUrl(null); b.classList.add('filled');
    };
    b.clearMap = () => {
      if (ch.key === 'alphaMask') this._setAlphaMask(region, null);
      else this.avatar.setSkinMap(region, ch.key, null);
      setUrl(null);
    };
    return b;
  }
}
