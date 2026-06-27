// WorldEditor — click-to-edit world editing for the block system.
//
//   • Right-click terrain → context menu → "Add block here" / "Edit terrain".
//   • Right-click a block  → "New block" / "Edit" / "Delete".
//   • Left-click a block (not yet editing) → a popup offers "Edit" / "Delete".
//   • Choosing Edit puts the block in edit mode: a transform gizmo attaches and a
//     pane docks on the LEFT listing the gizmo modes (Move / Rotate / Scale) plus
//     Delete / Done. The pane also lists the keyboard shortcuts below.
//
// Edit-mode keyboard (Blender-style modal transforms):
//   • Shift+left-click  — add / remove a block from the selection.
//   • G / R / S         — start a modal Move / Rotate / Scale driven by the mouse.
//       X / Y / Z       — while modal, lock the transform to that axis (a long
//                         colored indicator line shows the locked axis).
//       click / Enter   — confirm.   Esc / right-click — cancel (revert).
//   • Gizmo drag        — left-click release commits; Esc cancels (reverts).
//   • Shift+D           — duplicate the selection and start moving the copies.
//   • Ctrl+P            — parent (link) the selection into one group.
//   • Ctrl+Shift+P      — un-parent (unlink) the selection.
//   • X                 — confirm-delete popup (no transform active). Press X
//                         again / click Delete to confirm, or click away /
//                         Esc to cancel. Delete / Backspace delete instantly.
//   • Delete / Backspace— remove the selection.   Esc — finish editing.
//
// Multiple blocks transform together by parenting their meshes under a single
// "pivot" Object3D placed at the selection centre; the gizmo / modal ops drive
// the pivot and every change is written back onto each block's Rapier body +
// collider (blocks.syncPhysics), so physics always matches what you see. While a
// block is selected the avatar's keyboard movement is suspended so transform
// shortcuts don't also drive the character.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { showPanel, hidePanel, isPanelOpen } from './panelFade.js';
import { BLOCK_PBR_CHANNELS, BLOCK_FACE_NAMES } from './blocks.js';

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

const CLICK_SLOP = 5; // px of pointer travel still counted as a click (not a drag)
const HIGHLIGHT = 0x335577;
const MATERIAL_HIGHLIGHT = 0xffcc33;
// Modal-transform axis directions are derived per-instance from the blocks root
// (see constructor) so that the X/Y/Z keyboard locks match the Z-up gizmo.

export class WorldEditor {
  constructor({ renderer, scene, camera, controls, terrain, blocks, avatar, terrainEditor, avatarEditor, skyEditor, animEditor }) {
    this.dom = renderer.domElement;
    this.scene = scene;
    this.camera = camera;
    this.orbit = controls;
    this.terrain = terrain;
    this.blocks = blocks;
    this.avatar = avatar;
    this.terrainEditor = terrainEditor;
    this.avatarEditor = avatarEditor;
    this.skyEditor = skyEditor;
    this.animEditor = animEditor;

    this.selection = [];          // currently edited blocks
    this._active = null;          // the "active" block (last clicked) — the parent for Ctrl+P
    this._targets = [];           // blocks whose physics must resync (selection + descendants)
    this._emissive = new Map();   // block -> original emissive hex (to restore highlight)
    this._baseMode = 'translate'; // gizmo mode chosen via the pane
    this._materialSelectMode = false;
    this._selectedMaterials = []; // [{ block, index }] selected in material mode
    this._suppressMaterialHighlight = false; // hide highlight while adjusting material controls
    this._materialOutlines = [];

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._down = null;            // { x, y } of the last left pointerdown
    this._ptr = { x: 0, y: 0 };   // latest pointer position (for modal transforms)

    // The selection pivot: meshes get re-parented under this while selected, and
    // the gizmo / modal transforms drive it.
    this._pivot = new THREE.Group();
    scene.add(this._pivot);

    // Blender-style axis indicator lines, shown while a modal transform has an
    // axis locked (G/R/S then X/Y/Z). They're children of the pivot so they
    // follow the selection and inherit its Z-up local frame — a line along
    // local X/Y/Z matches the gizmo and the axis lock exactly. Long enough to
    // span the viewport; drawn on top like the gizmo handles.
    this._axisLines = this._buildAxisLines();
    for (const line of Object.values(this._axisLines)) this._pivot.add(line);

    // Modal (keyboard) transform state, null when not transforming.
    this._modal = null;
    this._scaleAnchor = null;     // one-sided gizmo scaling anchor

    // One shared hidden file input for block texture uploads.
    this._file = document.createElement('input');
    this._file.type = 'file';
    this._file.accept = 'image/*';
    this._file.style.display = 'none';
    document.body.appendChild(this._file);

    // scratch
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._plane = new THREE.Plane();

    // Z-up authoring frame. Blocks live under `blocks.root` (rotated -90° about
    // X, so local +Z = world +Y/up). The selection pivot inherits that same
    // baseline rotation so the transform gizmo (in 'local' space) draws its
    // blue Z handle pointing up, and the G/R/S axis locks below match it.
    this._blocksRoot = blocks.root;
    this._blocksRoot.updateMatrixWorld(true);
    this._rootQuat = new THREE.Quaternion();
    this._blocksRoot.getWorldQuaternion(this._rootQuat);
    // World-space direction of each local authoring axis: local X -> world X,
    // local Y -> world -Z, local Z -> world +Y (up).
    this._axes = {
      x: new THREE.Vector3(1, 0, 0).applyQuaternion(this._rootQuat),
      y: new THREE.Vector3(0, 1, 0).applyQuaternion(this._rootQuat),
      z: new THREE.Vector3(0, 0, 1).applyQuaternion(this._rootQuat),
    };

    // ---- transform gizmo ----
    this.gizmo = new TransformControls(camera, this.dom);
    this.gizmo.setSize(0.9);
    // 'local' space orients the gizmo to the pivot's world quaternion, which we
    // keep aligned with the blocks root — so the blue Z handle points up.
    this.gizmo.setSpace('local');
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._onGizmoDragStart();
      else this._scaleAnchor = null;
    });
    this.gizmo.addEventListener('objectChange', () => this._onPivotChanged());
    scene.add(this.gizmo.getHelper());

    this._buildMenu();
    this._buildPane();

    this.dom.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.dom.addEventListener('pointerdown', (e) => { if (e.button === 0) this._down = { x: e.clientX, y: e.clientY }; });
    this.dom.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.dom.addEventListener('pointermove', (e) => this._onPointerMove(e));
    // Capture phase so we can dismiss the popup before other handlers run.
    window.addEventListener('pointerdown', (e) => this._onWindowPointerDown(e), true);
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  // ---- DOM: cursor popup + left edit pane ------------------------------
  _buildMenu() {
    this.menu = document.createElement('div');
    this.menu.className = 'ctx-menu';
    this.menu.style.display = 'none';
    document.body.appendChild(this.menu);
  }

  _buildPane() {
    this.pane = document.createElement('div');
    this.pane.className = 'edit-pane';
    this.pane.style.display = 'none';

    this._title = document.createElement('div');
    this._title.className = 'edit-pane-title';
    this._title.textContent = 'Edit Block';
    this.pane.appendChild(this._title);

    const make = (label, fn, mode, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (mode) b.dataset.mode = mode;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      this.pane.appendChild(b);
      return b;
    };
    make('Move (G)', () => this._setBaseMode('translate'), 'translate');
    make('Rotate (R)', () => this._setBaseMode('rotate'), 'rotate');
    make('Scale (S)', () => this._setBaseMode('scale'), 'scale');
    this._matModeBtn = make('Select Material', () => this._toggleMaterialSelect(), 'material');
    this._buildMaterialPane();
    make('Duplicate (Shift+D)', () => this._duplicateAndMove());
    make('Delete (X)', () => this._confirmDeletePopup(), null, 'danger');
    make('Done', () => this._deselect(), null, 'done');

    const hint = document.createElement('div');
    hint.className = 'edit-pane-hint';
    hint.innerHTML = [
      '<b>Shift+click</b> multi-select',
      '<b>G/R/S</b> move / rotate / scale, then <b>X/Y/Z</b> to lock an axis',
      'click or <b>Enter</b> confirm · <b>Esc</b> / right-click cancel',
      '<b>Shift+D</b> duplicate',
      '<b>Ctrl+P</b> parent to active (last-clicked) · <b>Ctrl+Shift+P</b> unparent',
    ].map((l) => `<div>${l}</div>`).join('');
    this.pane.appendChild(hint);

    document.body.appendChild(this.pane);
  }

  _showMenu(x, y, items) {
    this.menu.innerHTML = '';
    for (const item of items) {
      const b = document.createElement('button');
      b.textContent = item.label;
      if (item.cls) b.className = item.cls;
      b.addEventListener('click', () => { this._hideMenu(); item.action(); });
      this.menu.appendChild(b);
    }
    this.menu.style.left = `${x}px`;
    this.menu.style.top = `${y}px`;
    showPanel(this.menu, { display: 'block' });
  }

  _hideMenu() { hidePanel(this.menu); }

  _blockMenu(block, x, y) {
    this._showMenu(x, y, [
      { label: 'Edit', action: () => this._edit(block) },
      { label: 'Delete', action: () => this._delete(block), cls: 'danger' },
    ]);
  }

  // Place a new block flush against the clicked face (offset half a block along
  // the surface normal, so it sits next to / on top of the one you clicked).
  // `point` and `normal` arrive in world (Y-up) space; blocks are authored in the
  // Z-up local frame, so both are converted before placement.
  _addAgainst(point, normal) {
    const half = this.blocks.size / 2;
    this._blocksRoot.updateMatrixWorld(true);
    const lp = this.blocks.worldToLocalPoint(point, this._v);
    const ln = this.blocks.worldToLocalDir(normal, this._v2);
    return this.blocks.create(lp.x + ln.x * half, lp.y + ln.y * half, lp.z + ln.z * half);
  }

  // ---- picking --------------------------------------------------------
  _pick(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    this.pointer.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const blockHit = this.raycaster.intersectObjects(this.blocks.meshes(), false)[0];
    if (blockHit) {
      const normal = blockHit.face
        ? blockHit.face.normal.clone().transformDirection(blockHit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      return { type: 'block', block: this.blocks.findByMesh(blockHit.object), point: blockHit.point, normal, materialIndex: blockHit.face?.materialIndex ?? 0 };
    }

    if (this.avatar && this.raycaster.intersectObject(this.avatar.group, true).length) {
      return { type: 'avatar' };
    }

    const terrainHit = this.raycaster.intersectObject(this.terrain.terrainMesh, false)[0];
    if (terrainHit) return { type: 'terrain', point: terrainHit.point };

    return null;
  }

  // ---- events ---------------------------------------------------------
  _onContextMenu(e) {
    e.preventDefault();
    if (this._modal) { this._cancelModal(); return; }   // right-click cancels a modal transform
    if (this.terrainEditor?.active) return;             // sculpting owns the pointer
    if (this.animEditor?.active) return;                // animation editor owns the pointer
    const hit = this._pick(e.clientX, e.clientY);
    if (!hit) {
      this._showMenu(e.clientX, e.clientY, [
        { label: 'Edit sky…', action: () => this._openSkyEditor() },
      ]);
      return;
    }
    if (hit.type === 'avatar') {
      this._showMenu(e.clientX, e.clientY, [
        { label: 'Edit avatar…', action: () => this._openAvatarEditor() },
        { label: 'Create animation…', action: () => this._openAnimEditor() },
      ]);
    } else if (hit.type === 'terrain') {
      const point = hit.point.clone();
      this._showMenu(e.clientX, e.clientY, [
        { label: '+ Add block here', action: () => this._edit(this.blocks.addAt(point)) },
        { label: 'Edit terrain', action: () => this._openTerrainEditor() },
      ]);
    } else {
      const block = hit.block;
      const point = hit.point.clone();
      const normal = hit.normal.clone();
      this._showMenu(e.clientX, e.clientY, [
        { label: '+ New block', action: () => this._edit(this._addAgainst(point, normal)) },
        { label: 'Edit', action: () => this._edit(block) },
        { label: 'Delete', action: () => this._delete(block), cls: 'danger' },
      ]);
    }
  }

  _onPointerMove(e) {
    this._ptr.x = e.clientX;
    this._ptr.y = e.clientY;
    if (this._modal) this._modalApply();
  }

  _onPointerUp(e) {
    if (this._modal) {                                  // a click confirms a modal transform
      if (e.button === 0) this._confirmModal();
      this._down = null;
      return;
    }
    if (this.terrainEditor?.active) { this._down = null; return; } // sculpting owns the pointer
    if (e.button !== 0 || !this._down || this.gizmo.dragging) { this._down = null; return; }
    const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
    this._down = null;
    if (moved > CLICK_SLOP) return; // it was an orbit drag, not a click

    const hit = this._pick(e.clientX, e.clientY);
    if (hit?.type === 'block') {
      if (this.selection.length) {
        if (this._materialSelectMode) {
          this._selectMaterial(hit.block, hit.materialIndex, e.shiftKey);
        } else {
          // Already editing: click selects directly; Shift toggles in/out.
          if (e.shiftKey) this._toggleInSelection(hit.block);
          else this._selectOnly(hit.block);
        }
      } else {
        this._blockMenu(hit.block, e.clientX, e.clientY); // offer to edit/delete
      }
    } else {
      this._hideMenu();
    }
  }

  _onWindowPointerDown(e) {
    if (isPanelOpen(this.menu) && !this.menu.contains(e.target)) this._hideMenu();
  }

  _openTerrainEditor() { this._deselect(); this._hideMenu(); this.avatarEditor?.close(); this.skyEditor?.close(); this.animEditor?.exit(); this.terrainEditor?.open(); }
  _openAvatarEditor() { this._deselect(); this._hideMenu(); this.terrainEditor?.close(); this.skyEditor?.close(); this.animEditor?.exit(); this.avatarEditor?.open(); }
  _openSkyEditor() { this._deselect(); this._hideMenu(); this.terrainEditor?.close(); this.avatarEditor?.close(); this.animEditor?.exit(); this.skyEditor?.open(); }
  _openAnimEditor() {
    this._deselect(); this._hideMenu();
    this.terrainEditor?.close(); this.avatarEditor?.close(); this.skyEditor?.close();
    // Freeze the avatar in a still T-pose and frame the camera on it, then hand
    // control to the BVH/IK animation editor (markers, timeline, gizmo).
    this.blocks.player?.enterPose();
    this.animEditor?.enter();
  }

  _onKey(e) {
    // The animation editor owns the keyboard while active (Space, Del,
    // Ctrl+Z, Escape to deselect). Bail before the Escape branch below, which
    // would close the avatar editor and resume the player out from under it.
    if (this.animEditor?.active) return;

    // ---- while a gizmo drag is in progress, Escape cancels (reverts) it ----
    // Left-click release already commits (TransformControls default); Escape
    // is the cancel path. `reset()` reverts the pivot to its drag-start
    // transform and dispatches objectChange -> _onPivotChanged -> syncPhysics,
    // so physics reverts too. Then we end the drag.
    if (this.gizmo.dragging) {
      if (e.code === 'Escape') { e.preventDefault(); this._cancelGizmoDrag(); }
      return; // ignore other keys mid-drag
    }

    // ---- while a modal transform is running, the keyboard drives it ----
    if (this._modal) {
      if (e.code === 'Escape') { e.preventDefault(); this._cancelModal(); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this._confirmModal(); }
      else if (e.code === 'KeyX') { e.preventDefault(); this._setModalAxis('x'); }
      else if (e.code === 'KeyY') { e.preventDefault(); this._setModalAxis('y'); }
      else if (e.code === 'KeyZ') { e.preventDefault(); this._setModalAxis('z'); }
      return;
    }

    // Escape exits whatever editing mode is open (even from a panel input).
    if (e.code === 'Escape') {
      // If a confirm popup is open, Escape just dismisses it (don't deselect).
      if (isPanelOpen(this.menu)) { this._hideMenu(); return; }
      this._hideMenu();
      this._deselect();
      this.terrainEditor?.close();
      this.avatarEditor?.close();
      this.skyEditor?.close();
      return;
    }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (!this.selection.length) return;

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyP') { e.preventDefault(); e.shiftKey ? this._unparent() : this._parent(); return; }
    if (!ctrl && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); this._duplicateAndMove(); return; }
    if (!ctrl && !e.shiftKey) {
      if (e.code === 'KeyG') { e.preventDefault(); this._startModal('translate'); return; }
      if (e.code === 'KeyR') { e.preventDefault(); this._startModal('rotate'); return; }
      if (e.code === 'KeyS') { e.preventDefault(); this._startModal('scale'); return; }
      // X with no transform active -> confirm-delete popup (Blender-style).
      if (e.code === 'KeyX') { e.preventDefault(); this._confirmDeletePopup(); return; }
    }
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this._deleteSelected(); }
  }

  // ---- selection + pivot ----------------------------------------------
  _edit(block) {
    this._baseMode = 'translate';
    this._selectOnly(block);
  }

  _selectOnly(block) { this._active = block; this._applySelection([block]); }

  _toggleInSelection(block) {
    const set = new Set(this.selection);
    if (set.has(block)) {
      set.delete(block);
      if (this._active === block) this._active = [...set].at(-1) ?? null;
    } else {
      set.add(block);
      this._active = block; // newest click is the active (parent) block
    }
    this._applySelection([...set]);
  }

  // Re-parent the selected meshes under the pivot and attach the gizmo to it.
  // The pivot is centred on the active block (the natural origin of the group)
  // so transforms — and Ctrl+P parenting — pivot around the parent. Children of
  // a selected block ride along through the scene graph and still get their
  // physics resynced (see `_targets`).
  _applySelection(blocks) {
    this._releasePivot();        // detach current selection back to its real parents
    this.selection = blocks;
    if (!blocks.length) {
      this._active = null;
      this._targets = [];
      this.gizmo.detach();
      hidePanel(this.pane);
      this.orbit.enabled = true;
      this.blocks.player?.setInputEnabled(true);
      return;
    }
    if (!blocks.includes(this._active)) this._active = blocks.at(-1);

    // Pivot at the active block's centre (fall back to it always being in set).
    this._pivot.position.copy(this._active.mesh.getWorldPosition(this._v));
    // Inherit the blocks root's Z-up orientation so the gizmo's local Z is up.
    this._pivot.quaternion.copy(this._rootQuat);
    this._pivot.scale.set(1, 1, 1);
    this._pivot.updateMatrixWorld(true);

    // Re-parent shallowest-first so attaching a child after its parent is fine.
    for (const b of blocks.slice().sort((a, b2) => this._depth(a) - this._depth(b2))) {
      this._highlightOn(b);
      this._pivot.attach(b.mesh);   // preserves world transform
    }
    this._computeTargets();
    this.gizmo.attach(this._pivot);
    showPanel(this.pane);
    this._title.textContent = blocks.length > 1 ? `Edit ${blocks.length} Blocks` : 'Edit Block';
    this._setMode(this._baseMode);
    this.blocks.player?.setInputEnabled(false); // free S / X / G / R for transforms
    this._updateMaterialHighlights();
    this._refreshMaterialPane();
  }

  // Move the selection's meshes out of the pivot and back under their *real*
  // parent (or the scene), baking world transform; clears highlights. Ancestors
  // first so a child re-attaches to a parent that's already in place.
  _releasePivot() {
    const ordered = this.selection.slice().sort((a, b) => this._depth(a) - this._depth(b));
    for (const b of ordered) {
      this._highlightOff(b);
      (b.parent ? b.parent.mesh : this._blocksRoot).attach(b.mesh);
    }
    this.selection = [];
  }

  // ---- hierarchy helpers ----------------------------------------------
  _depth(block) { let d = 0, p = block.parent; while (p) { d++; p = p.parent; } return d; }

  _isAncestor(maybeAncestor, block) {
    for (let p = block.parent; p; p = p.parent) if (p === maybeAncestor) return true;
    return false;
  }

  _eachDescendant(block, out) {
    for (const b of this.blocks.blocks) {
      if (b.parent === block && !out.has(b)) { out.add(b); this._eachDescendant(b, out); }
    }
  }

  // Selected blocks plus every descendant — all of these move when the pivot
  // moves, so all need their Rapier body/collider resynced.
  _computeTargets() {
    const set = new Set(this.selection);
    for (const b of this.selection) this._eachDescendant(b, set);
    this._targets = [...set];
  }

  // Make `child` a real scene-graph child of `parent`, keeping world transform.
  _setParent(child, parent) {
    child.parent = parent;
    parent.mesh.attach(child.mesh);
    this.blocks.syncPhysics(child);
  }

  // Detach `child` to the blocks root, keeping world transform.
  _clearParent(child) {
    if (!child.parent) return;
    child.parent = null;
    this._blocksRoot.attach(child.mesh);
    this.blocks.syncPhysics(child);
  }

  _deselect() {
    if (this._modal) this._cancelModal();
    if (!this.selection.length) return;
    this._releasePivot();
    this.gizmo.detach();
    hidePanel(this.pane);
    this.orbit.enabled = true;
    this.blocks.player?.setInputEnabled(true);
    this._selectedMaterials = [];
    this._clearMaterialOutlines();
    this._materialSelectMode = false;
  }

  _highlightOn(b) {
    const mats = this.blocks.materialsOf(b.mesh);
    this._emissive.set(b, mats.map((m) => m.emissive.getHex()));
    mats.forEach((m) => m.emissive.setHex(HIGHLIGHT));
  }

  _highlightOff(b) {
    const hexes = this._emissive.get(b);
    if (hexes) this.blocks.materialsOf(b.mesh).forEach((m, i) => m.emissive.setHex(hexes[i] ?? 0));
    this._emissive.delete(b);
  }

  _materialKey(block, index) { return `${this.blocks.blocks.indexOf(block)}:${index}`; }

  _updateMaterialHighlights() {
    this._clearMaterialOutlines();
    for (const b of this.selection) {
      const original = this._emissive.get(b) ?? [];
      // Do not tint/fill selected blocks; selection is shown with outlines only.
      this.blocks.materialsOf(b.mesh).forEach((m, i) => m.emissive.setHex(original[i] ?? 0));
    }
    if (!this._suppressMaterialHighlight) {
      const selected = this._selectedMaterials.filter(({ block }) => this.selection.includes(block));
      if (selected.length) {
        for (const { block, index } of selected) this._addMaterialOutline(block, index);
      } else {
        for (const block of this.selection) this._addBlockOutline(block);
      }
    }
  }

  _clearMaterialOutlines() {
    for (const line of this._materialOutlines) {
      line.parent?.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this._materialOutlines = [];
  }

  _addBlockOutline(block) {
    const h = this.blocks.size / 2;
    const e = h * 0.025;
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry((h + e) * 2, (h + e) * 2, (h + e) * 2));
    const mat = new THREE.LineBasicMaterial({ color: MATERIAL_HIGHLIGHT, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 1000;
    block.mesh.add(line);
    this._materialOutlines.push(line);

  }

  _addMaterialOutline(block, index) {
    const h = this.blocks.size / 2;
    const e = h * 0.018;
    const p = [
      [[ h + e, -h, -h], [ h + e,  h, -h], [ h + e,  h,  h], [ h + e, -h,  h]], // +x
      [[-h - e,  h, -h], [-h - e, -h, -h], [-h - e, -h,  h], [-h - e,  h,  h]], // -x
      [[-h,  h + e, -h], [ h,  h + e, -h], [ h,  h + e,  h], [-h,  h + e,  h]], // +y
      [[ h, -h - e, -h], [-h, -h - e, -h], [-h, -h - e,  h], [ h, -h - e,  h]], // -y
      [[-h, -h,  h + e], [ h, -h,  h + e], [ h,  h,  h + e], [-h,  h,  h + e]], // +z
      [[ h, -h, -h - e], [-h, -h, -h - e], [-h,  h, -h - e], [ h,  h, -h - e]], // -z
    ][index];
    if (!p) return;
    const pts = [p[0], p[1], p[1], p[2], p[2], p[3], p[3], p[0]].flat();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: MATERIAL_HIGHLIGHT, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 1000;
    block.mesh.add(line);
    this._materialOutlines.push(line);

    // Add a second, slightly larger white/amber outline to make the selected face
    // read clearly against bright or busy textures.
    const geo2 = geo.clone();
    geo2.scale(1.012, 1.012, 1.012);
    const mat2 = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.55 });
    const line2 = new THREE.LineSegments(geo2, mat2);
    line2.renderOrder = 1001;
    block.mesh.add(line2);
    this._materialOutlines.push(line2);
  }

  // ---- gizmo mode -----------------------------------------------------
  _setBaseMode(mode) { this._materialSelectMode = false; this._baseMode = mode; this._setMode(mode); this._updateMaterialHighlights(); }

  _setMode(mode) {
    if (mode !== 'material') this.gizmo.setMode(mode);
    for (const b of this.pane.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('active', b.dataset.mode === mode || (b.dataset.mode === 'material' && this._materialSelectMode));
    }
    this._refreshMaterialPane();
  }

  _toggleMaterialSelect() {
    this._materialSelectMode = !this._materialSelectMode;
    this.gizmo.enabled = !this._materialSelectMode;
    this._setMode(this._materialSelectMode ? 'material' : this._baseMode);
  }

  _selectMaterial(block, index, additive = false) {
    if (!this.selection.includes(block)) return;
    const key = this._materialKey(block, index);
    if (additive) {
      const i = this._selectedMaterials.findIndex((m) => this._materialKey(m.block, m.index) === key);
      if (i >= 0) this._selectedMaterials.splice(i, 1);
      else this._selectedMaterials.push({ block, index });
    } else {
      this._selectedMaterials = [{ block, index }];
    }
    this._updateMaterialHighlights();
    this._refreshMaterialPane();
  }

  _buildMaterialPane() {
    this._matPane = document.createElement('div');
    this._matPane.className = 'block-material-pane';
    // While the pointer is over texture/color/slider controls, show the true
    // material without blue/gold emissive selection tint so edits are easy to judge.
    this._matPane.addEventListener('pointerenter', () => { this._suppressMaterialHighlight = true; this._updateMaterialHighlights(); });
    this._matPane.addEventListener('pointerleave', () => { this._suppressMaterialHighlight = false; this._updateMaterialHighlights(); });
    this.pane.appendChild(this._matPane);
  }

  _refreshMaterialPane() {
    if (!this._matPane) return;
    this._matPane.innerHTML = '';
    if (!this.selection.length) return;
    this._selectedMaterials = this._selectedMaterials.filter((m) => this.selection.includes(m.block));
    const target = this._materialSelectMode && this._selectedMaterials.length
      ? `Selected: ${this._selectedMaterials.length} material${this._selectedMaterials.length === 1 ? '' : 's'}`
      : 'Target: All materials';
    const title = document.createElement('div');
    title.className = 'block-material-title';
    title.textContent = target;
    this._matPane.appendChild(title);
    const all = document.createElement('button');
    all.textContent = 'Apply to whole block';
    all.addEventListener('click', () => { this._selectedMaterials = []; this._updateMaterialHighlights(); this._refreshMaterialPane(); });
    this._matPane.appendChild(all);
    const slots = document.createElement('div');
    slots.className = 'block-slots';
    for (const ch of BLOCK_PBR_CHANNELS) slots.appendChild(this._makeBlockSlot(ch));
    this._matPane.appendChild(slots);
    this._matPane.appendChild(this._makeTintPicker());
    this._matPane.appendChild(this._makeMaterialSliders());
  }

  _pickFile(onFile) { this._file.value = ''; this._file.onchange = () => { const f = this._file.files[0]; if (f) onFile(f); }; this._file.click(); }

  _targetMaterialSlots() {
    const selected = this._selectedMaterials.filter((m) => this.selection.includes(m.block));
    // Face/material overrides only apply while Select Material mode is active.
    // In normal Move/Rotate/Scale modes, the material editor targets the whole
    // selected object(s), even if a face selection from earlier still exists.
    if (this._materialSelectMode && selected.length) return selected;
    return this.selection.flatMap((block) => this.blocks.materialsOf(block.mesh).map((_, index) => ({ block, index })));
  }

  _targetMaterials() { return this._targetMaterialSlots().map(({ block, index }) => this.blocks.materialAt(block, index)); }

  _tintValue() {
    const mat = this._targetMaterials()[0];
    return mat ? `#${mat.color.getHexString()}` : '#ffffff';
  }

  _setTintValue(value) {
    for (const { block, index } of this._targetMaterialSlots()) {
      this.blocks.materialStateFor(block, index).tint = value;
      this.blocks.applyMaterialState(block, index);
    }
  }

  _makeTintPicker() {
    const row = document.createElement('label');
    row.className = 'block-material-tint';
    const name = document.createElement('span');
    name.textContent = 'Tint color';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = this._tintValue();
    input.addEventListener('input', () => this._setTintValue(input.value));
    row.append(name, input);
    return row;
  }

  _materialValue(key) {
    const mats = this._targetMaterials();
    if (!mats.length) return 0;
    const m = mats[0];
    if (key === 'normal') return m.normalMap ? (m.normalScale?.x ?? 1) : 0;
    if (key === 'roughness') return m.roughnessMap ? (m.roughness ?? 1) : 1;
    if (key === 'metalness') return m.metalnessMap ? (m.metalness ?? 1) : 0;
    if (key === 'ao') return m.aoMap ? (m.aoMapIntensity ?? 1) : 0;
    if (key === 'alpha') return m.opacity ?? 1;
    if (key === 'texScaleX') return this._firstTexture(m)?.repeat?.x ?? 1;
    if (key === 'texScaleY') return this._firstTexture(m)?.repeat?.y ?? 1;
    return 0;
  }

  _firstTexture(mat) { return BLOCK_PBR_CHANNELS.map((ch) => mat[ch.key]).find(Boolean); }

  _setMaterialValue(key, value) {
    for (const { block, index } of this._targetMaterialSlots()) {
      const s = this.blocks.materialStateFor(block, index);
      if (key === 'normal') s.values.normalIntensity = value;
      else if (key === 'roughness') s.values.roughness = value;
      else if (key === 'metalness') s.values.metalness = value;
      else if (key === 'ao') s.values.aoIntensity = value;
      else if (key === 'alpha') s.values.alpha = value;
      else if (key === 'texScaleX') s.values.repeatX = value;
      else if (key === 'texScaleY') s.values.repeatY = value;
      this.blocks.applyMaterialState(block, index);
    }
  }

  _makeMaterialSliders() {
    const wrap = document.createElement('div');
    wrap.className = 'block-material-sliders';
    const specs = [
      ['texScaleX', 'Texture scale X', 0.1, 16, 0.1],
      ['texScaleY', 'Texture scale Y', 0.1, 16, 0.1],
      ['alpha', 'Alpha', 0, 1, 0.01],
      ['normal', 'NRM intensity', 0, 3, 0.05],
      ['roughness', 'RGH amount', 0, 1, 0.01],
      ['metalness', 'MTL amount', 0, 1, 0.01],
      ['ao', 'AO intensity', 0, 3, 0.05],
    ];
    for (const [key, label, min, max, step] of specs) {
      const row = document.createElement('label');
      row.className = 'block-material-slider';
      const name = document.createElement('span');
      const val = document.createElement('b');
      const input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = this._materialValue(key);
      const sync = () => { val.textContent = Number(input.value).toFixed(step < 0.05 ? 2 : 1); };
      input.addEventListener('input', () => { this._setMaterialValue(key, Number(input.value)); sync(); });
      name.textContent = label;
      sync();
      row.append(name, input, val);
      wrap.appendChild(row);
    }
    return wrap;
  }

  _makeBlockSlot(ch) {
    const b = document.createElement('button');
    b.className = 'avatar-slot block-slot';
    b.title = ch.label;
    const tag = document.createElement('span'); tag.className = 'avatar-slot-tag'; tag.textContent = ch.short; b.appendChild(tag);
    const existing = this._targetMaterials().find((m) => m[ch.key])?.[ch.key];
    if (existing?.image?.src) { b.style.backgroundImage = `url(${existing.image.src})`; b.classList.add('filled'); }
    const apply = async (file, targetMats = this._targetMaterialSlots()) => {
      if (!file?.type?.startsWith('image/')) return;
      const { img, url } = await loadImage(file);
      for (const slot of targetMats) this.blocks.setMaterialTexture(slot.block, slot.index, ch.key, url, img);
      b.style.backgroundImage = `url(${url})`; b.classList.add('filled');
      this._refreshMaterialPane();
    };
    b.addEventListener('click', () => {
      const targetMats = this._targetMaterialSlots().slice();
      this._pickFile((file) => apply(file, targetMats));
    });
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop');
      const f = e.dataTransfer?.files?.[0];
      if (f) apply(f, this._targetMaterialSlots().slice());
    });
    return b;
  }

  // ---- true (hierarchical) parenting ----------------------------------
  // Ctrl+P: parent every other selected block to the active block — Blender's
  // "parent to active". Children keep their world transform and then ride along
  // whenever the parent moves. Ctrl+Shift+P clears the parent (keep transform).
  _parent() {
    if (this.selection.length < 2 || !this._active) return;
    const parent = this._active;
    const children = this.selection.filter((b) => b !== parent && !this._isAncestor(b, parent));
    const keep = this.selection.slice();
    this._releasePivot();                         // meshes back to real positions first
    for (const c of children) this._setParent(c, parent);
    this._applySelection(keep);                   // re-pivot, keep the same selection
  }

  _unparent() {
    const keep = this.selection.slice();
    this._releasePivot();
    for (const b of keep) this._clearParent(b);
    this._applySelection(keep);
  }

  // ---- duplicate (Shift+D) --------------------------------------------
  // Copy the selection in place, then select the copies and start a modal move
  // so you can drag them off the originals. Parent links *within* the selection
  // are preserved among the copies.
  _duplicateAndMove() {
    const originals = this.selection.slice();
    if (!originals.length) return;

    // Bake the live gizmo/pivot transform back onto each mesh first. While
    // selected the meshes ride under `_pivot`; if it carries a (possibly
    // non-uniform) scale or rotation, decomposing their world matrix in
    // cloneBlock would shear and produce a wrong copy. Releasing re-parents them
    // to their real parents with a clean per-mesh transform so the clone matches.
    this._releasePivot();

    const map = new Map();
    for (const o of originals) map.set(o, this.blocks.cloneBlock(o));
    for (const o of originals) {
      if (o.parent && map.has(o.parent)) this._setParent(map.get(o), map.get(o.parent));
    }
    const dups = originals.map((o) => map.get(o));
    this._active = map.get(this._active) ?? dups.at(-1);
    this._applySelection(dups);
    this._startModal('translate');
  }

  // ---- gizmo physics sync + one-sided scaling -------------------------
  _onPivotChanged() {
    if (!this.selection.length) return;
    if (this.gizmo.dragging && this.gizmo.getMode() === 'scale' && this._scaleAnchor) this._applyScaleAnchor();
    for (const b of this._targets) this.blocks.syncPhysics(b);
  }

  _onGizmoDragStart() {
    if (this.gizmo.getMode() === 'scale') this._beginScaleAnchor();
  }

  // Cancel an in-progress gizmo drag: revert the pivot to its drag-start
  // transform (TransformControls.reset() uses its own internal snapshot and
  // dispatches objectChange so physics resyncs), then end the drag. Mirrors
  // Blender's Escape-during-gizmo-drag behaviour.
  _cancelGizmoDrag() {
    if (!this.gizmo.dragging) return;
    this._scaleAnchor = null;            // don't let reset() re-apply the anchor
    this.gizmo.reset();                  // revert pivot + dispatch objectChange
    this.gizmo.dragging = false;         // end the drag (-> dragging-changed)
  }

  // Capture the selection's min corner so scaling keeps that side fixed (the
  // box grows from one side instead of from the centre).
  _beginScaleAnchor() {
    const box = new THREE.Box3();
    this._pivot.updateMatrixWorld(true);
    for (const b of this._targets) box.expandByObject(b.mesh);
    const pos0 = this._pivot.position;
    const s0 = this._pivot.scale;
    const anchor = box.min.clone();
    // Anchor offset expressed in the pivot's (drag-start) local frame.
    const loff = anchor.clone().sub(pos0).divide(s0);
    this._scaleAnchor = { anchor, loff };
  }

  _applyScaleAnchor() {
    const { anchor, loff } = this._scaleAnchor;
    const s = this._pivot.scale;
    this._pivot.position.set(anchor.x - s.x * loff.x, anchor.y - s.y * loff.y, anchor.z - s.z * loff.z);
    this._pivot.updateMatrixWorld(true);
  }

  // ---- modal (keyboard) transforms ------------------------------------
  // Three long axis lines (red X / green Y / blue Z) in the pivot's local
  // frame, hidden unless a modal transform has that axis locked. Blender shows
  // these to make the constraint axis obvious.
  _buildAxisLines() {
    const LEN = 1e4; // spans the viewport
    const make = (axis, hex) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-LEN, 0, 0),
        new THREE.Vector3(LEN, 0, 0),
      ]);
      if (axis === 'y') geo.rotateZ(Math.PI / 2);
      else if (axis === 'z') geo.rotateY(-Math.PI / 2);
      const mat = new THREE.LineBasicMaterial({
        color: hex, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9,
      });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 999;
      line.visible = false;
      return line;
    };
    return { x: make('x', 0xff3030), y: make('y', 0x30ff30), z: make('z', 0x3060ff) };
  }

  // Show/hide the axis indicator based on the current modal axis lock.
  _updateAxisLine() {
    const axis = this._modal?.axis ?? null;
    for (const [key, line] of Object.entries(this._axisLines)) line.visible = key === axis;
  }

  _startModal(mode) {
    if (!this.selection.length) return;
    if (this._modal) this._cancelModal();
    this.gizmo.enabled = false;   // the keyboard owns the transform now
    this.orbit.enabled = false;
    this._modal = { mode, axis: null };
    // Capture the modal-start ("origin") transform. Every axis switch resets
    // back to this so a new axis constraint replaces the old one — accumulated
    // changes from a previous axis are discarded (Blender-style), rather than
    // being baked in as the new baseline.
    this._modal.originPos = this._pivot.position.clone();
    this._modal.originQuat = this._pivot.quaternion.clone();
    this._modal.originScale = this._pivot.scale.clone();
    this._modalBaseline();
    this._setMode(mode);
    this._updateAxisLine();
  }

  _setModalAxis(axis) {
    if (!this._modal) return;
    this._modal.axis = this._modal.axis === axis ? null : axis; // press again to clear
    // Reset to the modal-start transform before re-baselining, so switching
    // (or clearing) an axis discards any accumulated change from the previous
    // axis and the new constraint applies from the origin. _modalBaseline
    // re-reads the pointer at its current position, so there's no jump.
    this._resetPivotToOrigin();
    this._modalBaseline();
    this._modalApply();
    this._updateAxisLine();
  }

  // Restore the pivot to the transform captured when the modal began.
  _resetPivotToOrigin() {
    const m = this._modal;
    this._pivot.position.copy(m.originPos);
    this._pivot.quaternion.copy(m.originQuat);
    this._pivot.scale.copy(m.originScale);
    this._pivot.updateMatrixWorld(true);
  }

  // Snapshot the pivot transform + pointer reference for the current mode/axis.
  _modalBaseline() {
    const m = this._modal;
    m.startPos = this._pivot.position.clone();
    m.startQuat = this._pivot.quaternion.clone();
    m.startScale = this._pivot.scale.clone();
    m.ptr0 = { x: this._ptr.x, y: this._ptr.y };

    const center = this._screenOf(m.startPos);
    m.center = center;
    if (m.mode === 'translate') {
      if (m.axis) {
        m.startT = this._axisParam(m.axis, m.startPos, m.ptr0);
      } else {
        this._viewPlane(m.startPos);
        m.startHit = this._rayPlane(m.ptr0).clone();
      }
    } else if (m.mode === 'rotate') {
      m.startAngle = Math.atan2(m.ptr0.y - center.y, m.ptr0.x - center.x);
    } else { // scale
      m.startDist = Math.max(1e-3, Math.hypot(m.ptr0.x - center.x, m.ptr0.y - center.y));
    }
  }

  _modalApply() {
    const m = this._modal;
    if (!m) return;
    const ptr = this._ptr;

    if (m.mode === 'translate') {
      if (m.axis) {
        const t = this._axisParam(m.axis, m.startPos, ptr);
        this._pivot.position.copy(m.startPos).addScaledVector(this._axes[m.axis], t - m.startT);
      } else {
        const hit = this._rayPlane(ptr);
        if (hit) this._pivot.position.copy(m.startPos).add(hit.sub(m.startHit));
      }
    } else if (m.mode === 'rotate') {
      const axis = m.axis ? this._axes[m.axis] : this.camera.getWorldDirection(this._v).clone().negate();
      const angle = Math.atan2(ptr.y - m.center.y, ptr.x - m.center.x) - m.startAngle;
      // Screen Y grows downward, so negate for an intuitive direction.
      this._q.setFromAxisAngle(axis, -angle);
      this._pivot.quaternion.copy(this._q).multiply(m.startQuat);
    } else { // scale
      const dist = Math.hypot(ptr.x - m.center.x, ptr.y - m.center.y);
      const f = dist / m.startDist;
      if (m.axis) {
        this._pivot.scale.copy(m.startScale);
        this._pivot.scale[m.axis] = m.startScale[m.axis] * f;
      } else {
        this._pivot.scale.copy(m.startScale).multiplyScalar(f);
      }
    }
    this._pivot.updateMatrixWorld(true);
    for (const b of this._targets) this.blocks.syncPhysics(b);
  }

  _confirmModal() { this._endModal(); }

  _cancelModal() {
    const m = this._modal;
    if (!m) return;
    this._pivot.position.copy(m.startPos);
    this._pivot.quaternion.copy(m.startQuat);
    this._pivot.scale.copy(m.startScale);
    this._pivot.updateMatrixWorld(true);
    for (const b of this._targets) this.blocks.syncPhysics(b);
    this._endModal();
  }

  _endModal() {
    this._modal = null;
    this.gizmo.enabled = true;
    this.orbit.enabled = true;
    this._setMode(this._baseMode);
    this._updateAxisLine();
  }

  // ---- modal math helpers ---------------------------------------------
  // World point → screen (client) pixels.
  _screenOf(world) {
    const r = this.dom.getBoundingClientRect();
    const v = world.clone().project(this.camera);
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  _setRay(ptr) {
    const r = this.dom.getBoundingClientRect();
    this.pointer.set(((ptr.x - r.left) / r.width) * 2 - 1, -((ptr.y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  // Plane through `at`, facing the camera (for free translate).
  _viewPlane(at) {
    const n = this.camera.getWorldDirection(this._v).clone().negate();
    this._plane.setFromNormalAndCoplanarPoint(n, at);
  }

  _rayPlane(ptr) {
    this._setRay(ptr);
    return this.raycaster.ray.intersectPlane(this._plane, new THREE.Vector3());
  }

  // Parameter along a world axis line (through `origin`) of the point on that
  // line closest to the pointer ray — used for axis-locked translate.
  _axisParam(axis, origin, ptr) {
    this._setRay(ptr);
    const ray = this.raycaster.ray;
    const A = this._axes[axis];
    const D = ray.direction;
    const w0 = this._v.copy(ray.origin).sub(origin);
    const b = D.dot(A);
    const denom = 1 - b * b;            // a = D·D = 1, c = A·A = 1
    if (Math.abs(denom) < 1e-6) return 0; // axis ~parallel to the view ray
    const d = D.dot(w0);
    const e = A.dot(w0);
    return (e - b * d) / denom;         // tc on the axis line
  }

  // ---- delete ---------------------------------------------------------
  // Re-home a block's direct children to the scene (keeping world transform) so
  // they don't disappear with the parent's subtree when it's removed.
  _orphanChildren(block) {
    for (const b of this.blocks.blocks) {
      if (b.parent === block) { b.parent = null; this._blocksRoot.attach(b.mesh); this.blocks.syncPhysics(b); }
    }
  }

  _remove(block) {
    this._orphanChildren(block);
    this.blocks.remove(block);
  }

  _delete(block) {
    if (this.selection.includes(block)) this._deselect();
    this._remove(block);
  }

  _deleteSelected() {
    const sel = this.selection.slice();
    this._deselect();
    for (const b of sel) this._remove(b);
  }

  // Blender-style confirm popup for X-delete (shown when X is pressed with a
  // selection but no transform active). Reuses the context-menu popup, so an
  // outside click or Escape dismisses it without deleting. Positioned at the
  // last pointer location, clamped to the viewport.
  _confirmDeletePopup() {
    const n = this.selection.length;
    const r = this.dom.getBoundingClientRect();
    let x = this._ptr.x ?? r.left + r.width / 2;
    let y = this._ptr.y ?? r.top + r.height / 2;
    // Clamp so the menu stays on-screen (the menu has a fixed min-width).
    x = Math.min(Math.max(r.left + 4, x), r.right - 160);
    y = Math.min(Math.max(r.top + 4, y), r.bottom - 80);
    const label = n === 1 ? 'Delete block?' : `Delete ${n} blocks?`;
    this._showMenu(x, y, [
      { label, action: () => this._deleteSelected(), cls: 'danger' },
      { label: 'Cancel', action: () => this._hideMenu() },
    ]);
  }
}
