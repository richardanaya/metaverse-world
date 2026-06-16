// WorldEditor — click-to-edit world editing for the block system.
//
//   • Right-click terrain → context menu → "Add block here" (places a block on
//     the clicked surface point).
//   • Left-click a block  → a small popup offers "Edit" / "Delete".
//   • Choosing Edit puts the block in edit mode: a transform gizmo attaches, and
//     a pane docks on the LEFT of the screen listing the three gizmo modes
//     (Move / Rotate / Scale) plus Delete / Done. Hover highlights a mode;
//     clicking switches the gizmo.
//   • Esc finishes editing; Delete/Backspace removes the selected block.
//
// The gizmo is three's TransformControls. Every change is written straight back
// onto the block's Rapier body + collider (blocks.syncPhysics), so the physics
// you collide with always matches what you see. OrbitControls is suspended while
// a gizmo handle is being dragged. A left-click is distinguished from an orbit
// drag by requiring the pointer to barely move between down and up.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const CLICK_SLOP = 5; // px of pointer travel still counted as a click (not a drag)

export class WorldEditor {
  constructor({ renderer, scene, camera, controls, terrain, blocks, avatar, terrainEditor, avatarEditor, skyEditor }) {
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

    this.selected = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._down = null; // { x, y } of the last left pointerdown

    // ---- transform gizmo ----
    this.gizmo = new TransformControls(camera, this.dom);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value; });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.selected) this.blocks.syncPhysics(this.selected);
    });
    scene.add(this.gizmo.getHelper());

    this._buildMenu();
    this._buildPane();

    this.dom.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.dom.addEventListener('pointerdown', (e) => { if (e.button === 0) this._down = { x: e.clientX, y: e.clientY }; });
    this.dom.addEventListener('pointerup', (e) => this._onPointerUp(e));
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

    const title = document.createElement('div');
    title.className = 'edit-pane-title';
    title.textContent = 'Edit Block';
    this.pane.appendChild(title);

    const make = (label, fn, mode, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (mode) b.dataset.mode = mode;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      this.pane.appendChild(b);
      return b;
    };
    make('Move', () => this._setMode('translate'), 'translate');
    make('Rotate', () => this._setMode('rotate'), 'rotate');
    make('Scale', () => this._setMode('scale'), 'scale');
    make('Delete', () => this._deleteSelected(), null, 'danger');
    make('Done', () => this._deselect(), null, 'done');
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
    this.menu.style.display = 'block';
  }

  _hideMenu() { this.menu.style.display = 'none'; }

  _blockMenu(block, x, y) {
    this._showMenu(x, y, [
      { label: 'Edit', action: () => this._edit(block) },
      { label: 'Delete', action: () => this._delete(block), cls: 'danger' },
    ]);
  }

  // Place a new block flush against the clicked face (offset half a block along
  // the surface normal, so it sits next to / on top of the one you clicked).
  _addAgainst(point, normal) {
    const half = this.blocks.size / 2;
    this.blocks.create(
      point.x + normal.x * half,
      point.y + normal.y * half,
      point.z + normal.z * half,
    );
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
      // World-space normal of the clicked face (for placing a block against it).
      const normal = blockHit.face
        ? blockHit.face.normal.clone().transformDirection(blockHit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      return { type: 'block', block: this.blocks.findByMesh(blockHit.object), point: blockHit.point, normal };
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
    if (this.terrainEditor?.active) return; // sculpting owns the pointer
    const hit = this._pick(e.clientX, e.clientY);
    if (!hit) {
      // Empty sky — offer to edit it.
      this._showMenu(e.clientX, e.clientY, [
        { label: 'Edit sky…', action: () => this._openSkyEditor() },
      ]);
      return;
    }
    if (hit.type === 'avatar') {
      this._showMenu(e.clientX, e.clientY, [
        { label: 'Edit avatar…', action: () => this._openAvatarEditor() },
      ]);
    } else if (hit.type === 'terrain') {
      const point = hit.point.clone();
      this._showMenu(e.clientX, e.clientY, [
        { label: '+ Add block here', action: () => this.blocks.addAt(point) },
        { label: 'Edit terrain', action: () => this._openTerrainEditor() },
      ]);
    } else {
      const block = hit.block;
      const point = hit.point.clone();
      const normal = hit.normal.clone();
      this._showMenu(e.clientX, e.clientY, [
        { label: '+ New block', action: () => this._addAgainst(point, normal) },
        { label: 'Edit', action: () => this._edit(block) },
        { label: 'Delete', action: () => this._delete(block), cls: 'danger' },
      ]);
    }
  }

  _onPointerUp(e) {
    if (this.terrainEditor?.active) { this._down = null; return; } // sculpting owns the pointer
    if (e.button !== 0 || !this._down || this.gizmo.dragging) { this._down = null; return; }
    const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
    this._down = null;
    if (moved > CLICK_SLOP) return; // it was an orbit drag, not a click

    const hit = this._pick(e.clientX, e.clientY);
    if (hit?.type === 'block') {
      if (hit.block === this.selected) return; // clicking the block you're editing: keep the gizmo
      this._blockMenu(hit.block, e.clientX, e.clientY); // offer to edit/delete it
    } else {
      this._hideMenu();
    }
  }

  _onWindowPointerDown(e) {
    // Dismiss the cursor popup on any click outside it.
    if (this.menu.style.display !== 'none' && !this.menu.contains(e.target)) this._hideMenu();
  }

  _openTerrainEditor() {
    this._deselect();   // drop any block gizmo first
    this._hideMenu();
    this.avatarEditor?.close();
    this.skyEditor?.close();
    this.terrainEditor?.open();
  }

  _openAvatarEditor() {
    this._deselect();
    this._hideMenu();
    this.terrainEditor?.close();
    this.skyEditor?.close();
    this.avatarEditor?.open();
  }

  _openSkyEditor() {
    this._deselect();
    this._hideMenu();
    this.terrainEditor?.close();
    this.avatarEditor?.close();
    this.skyEditor?.open();
  }

  _onKey(e) {
    // Escape always exits whatever editing mode is open (even from a panel input).
    if (e.code === 'Escape') {
      this._hideMenu();
      this._deselect();
      this.terrainEditor?.close();
      this.avatarEditor?.close();
      this.skyEditor?.close();
      return;
    }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected) {
      e.preventDefault();
      this._deleteSelected();
    }
  }

  // ---- selection + gizmo ----------------------------------------------
  _edit(block) {
    this._select(block);
    this._setMode('translate'); // default to Move; the pane toggles the rest
  }

  _select(block) {
    if (this.selected === block) return;
    this._restoreHighlight();
    this.selected = block;
    this._prevEmissive = block.mesh.material.emissive.getHex();
    block.mesh.material.emissive.setHex(0x335577);
    this.gizmo.attach(block.mesh);
    this.pane.style.display = 'flex';
  }

  _deselect() {
    if (!this.selected) return;
    this._restoreHighlight();
    this.gizmo.detach();
    this.selected = null;
    this.pane.style.display = 'none';
    this.orbit.enabled = true;
  }

  _restoreHighlight() {
    if (this.selected && this._prevEmissive != null) {
      this.selected.mesh.material.emissive.setHex(this._prevEmissive);
    }
    this._prevEmissive = null;
  }

  _setMode(mode) {
    this.gizmo.setMode(mode);
    for (const b of this.pane.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
  }

  _delete(block) {
    if (this.selected === block) this._deselect();
    this.blocks.remove(block);
  }

  _deleteSelected() {
    const block = this.selected;
    this._deselect();
    this.blocks.remove(block);
  }
}
