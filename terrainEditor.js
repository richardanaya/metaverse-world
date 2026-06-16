// TerrainEditor — a floating sidebar to sculpt and configure the terrain.
//
// Opened from the right-click menu ("Edit terrain"). While open it:
//   • Left-drag on the terrain paints with the active brush (Raise / Lower /
//     Flatten). Hold Shift to temporarily invert to Lower. The brush ring shows
//     where you'll paint.
//   • A sidebar exposes brush mode / radius / strength plus terrain settings
//     (water level, texture density) and Randomize / Flatten-all actions.
//   • Done closes the editor.
//
// Painting is wired with the library's bindTerrainPainting helper. Sculpting
// changes the heightmap, which makes the physics collider stale — so after every
// stroke (and after Randomize / Flatten) we rebuild the controller's terrain
// collider so what you walk on matches what you see.

import * as THREE from 'three';
import { bindTerrainPainting, TERRAIN_TEXTURE_LAYERS } from 'metaverse-terrain';

const LAYER_LABELS = { sand: 'Sand', grass: 'Grass', rock: 'Rock', snow: 'Snow', water: 'Water' };

export class TerrainEditor {
  constructor({ renderer, camera, controls, terrain, player }) {
    this.dom = renderer.domElement;
    this.camera = camera;
    this.orbit = controls;
    this.terrain = terrain;
    this.player = player;

    this.active = false;
    this._binding = null;
    this._mode = null;            // active brush mode, or null = no brush
    this._dirty = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    // One shared hidden file input, re-targeted per texture upload.
    this._file = document.createElement('input');
    this._file.type = 'file';
    this._file.accept = 'image/*';
    this._file.style.display = 'none';
    document.body.appendChild(this._file);

    // Default brush size/strength, but no active mode yet — the brush only
    // appears once Raise / Lower / Flatten is chosen.
    terrain.setBrushRadius(14);
    terrain.setBrushStrength(0.6);
    if (terrain.brushCursor) terrain.brushCursor.visible = false;

    this._buildPanel();
  }

  // ---- DOM ------------------------------------------------------------
  _buildPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'terrain-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'terrain-panel-title';
    title.textContent = 'Terrain';
    this.panel.appendChild(title);

    // Brush mode segmented buttons.
    this._addLabel('Brush');
    const modes = document.createElement('div');
    modes.className = 'seg';
    this._modeButtons = {};
    for (const [mode, label] of [['raise', 'Raise'], ['lower', 'Lower'], ['flatten', 'Flatten']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => this._setMode(mode));
      modes.appendChild(b);
      this._modeButtons[mode] = b;
    }
    this.panel.appendChild(modes);

    this._addSlider('Radius', 2, 48, 1, this.terrain.brush.radius, (v) => this.terrain.setBrushRadius(v));
    this._addSlider('Strength', 0.05, 2, 0.05, this.terrain.brush.strength, (v) => this.terrain.setBrushStrength(v));

    this._addLabel('Terrain');
    this._addSlider('Water level', this.terrain.minHeight, this.terrain.maxHeight, 1, this.terrain.waterLevel,
      (v) => this.terrain.setWaterLevel(v));
    this._addSlider('Texture scale', 2, 24, 1, this.terrain.textureDensity,
      (v) => this.terrain.setTextureDensity(v));

    // Per-layer texture slots (click or drag-and-drop an image).
    this._addTextures();

    // World physics (Rapier) — gravity, locomotion + the character controller's
    // slope limit. Tweaks apply live to the player controller.
    this._addPhysics();

    // Actions.
    const actions = document.createElement('div');
    actions.className = 'terrain-actions';
    const mkAction = (label, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mkAction('Randomize', () => { this.terrain.randomize(); this._markDirty(); this._flushCollider(); });
    mkAction('Flatten all', () => { this.terrain.level(); this._markDirty(); this._flushCollider(); });
    this.panel.appendChild(actions);

    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'terrain-done';
    done.addEventListener('click', () => this.close());
    this.panel.appendChild(done);

    document.body.appendChild(this.panel);
    // No brush mode active to start — buttons are all off until clicked.
  }

  _addLabel(text) {
    const el = document.createElement('div');
    el.className = 'terrain-section';
    el.textContent = text;
    this.panel.appendChild(el);
  }

  // Returns a handle whose `set(v)` updates both the slider and its readout
  // (used by "Reset physics" to push new values back into the UI).
  _addSlider(label, min, max, step, value, onInput) {
    const row = document.createElement('label');
    row.className = 'terrain-row';
    const cap = document.createElement('span');
    const val = document.createElement('b');
    const fmt = (v) => (step < 1 ? Number(v).toFixed(2) : String(Math.round(v)));
    cap.textContent = label;
    val.textContent = fmt(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => { val.textContent = fmt(input.value); onInput(parseFloat(input.value)); });
    const head = document.createElement('div');
    head.className = 'terrain-row-head';
    head.append(cap, val);
    row.append(head, input);
    this.panel.appendChild(row);
    return { input, set: (v) => { input.value = v; val.textContent = fmt(v); } };
  }

  // Brush modes toggle: clicking the active one turns the brush off (no brush
  // shown until Raise / Lower / Flatten is selected again).
  _setMode(mode) {
    const next = this._mode === mode ? null : mode;
    this._mode = next;
    if (next) {
      this.terrain.setBrushMode(next);
      if (this.active) this._bindPaint();
    } else {
      this._unbindPaint();
    }
    for (const [m, b] of Object.entries(this._modeButtons)) b.classList.toggle('active', m === next);
  }

  // Lazily wire up brush painting (only while a mode is active + editor open).
  _bindPaint() {
    if (this._binding) return;
    this._binding = bindTerrainPainting(this.terrain, {
      domElement: this.dom,
      camera: this.camera,
      raycaster: this.raycaster,
      pointer: this.pointer,
      setControlsEnabled: (on) => { this.orbit.enabled = on; },
    });
  }

  _unbindPaint() {
    this._binding?.unbind();
    this._binding = null;
    if (this.terrain.brushCursor) this.terrain.brushCursor.visible = false;
  }

  _pickFile(onFile) {
    this._file.value = '';
    this._file.onchange = () => { const f = this._file.files[0]; if (f) onFile(f); };
    this._file.click();
  }

  // ---- texture slots --------------------------------------------------
  // One slot per terrain layer (sand / grass / rock / snow / water). Click to
  // pick an image file, or drag-and-drop one onto the slot; the library swaps
  // that layer's texture and the slot shows a thumbnail of what you dropped.
  _addTextures() {
    this._addLabel('Textures');
    const hint = document.createElement('div');
    hint.className = 'terrain-hint';
    hint.textContent = 'Click or drop an image onto a layer to retexture it.';
    this.panel.appendChild(hint);

    const slots = document.createElement('div');
    slots.className = 'terrain-slots';
    for (const layer of TERRAIN_TEXTURE_LAYERS) slots.appendChild(this._makeTextureSlot(layer));
    this.panel.appendChild(slots);
  }

  // Resolve a CSS-usable preview URL for whatever the terrain holds for a layer:
  // either the original source URL (string) or a loaded THREE.Texture.
  _texturePreviewUrl(tex) {
    if (!tex) return null;
    if (typeof tex === 'string') return tex;
    if (tex.isTexture) return tex.userData?.objectUrl || tex.image?.currentSrc || tex.image?.src || null;
    return null;
  }

  // ---- world physics (Rapier) -----------------------------------------
  _addPhysics() {
    const p = this.player;
    if (!p) return;
    this._addLabel('Physics');
    const sync = [];
    const add = (label, min, max, step, get, set) => {
      const c = this._addSlider(label, min, max, step, get(), set);
      sync.push(() => c.set(get()));
    };
    // Gravity is shown as a positive magnitude (world is -Y).
    add('Gravity', 4, 60, 1, () => -p.gravity, (v) => { p.gravity = -v; });
    add('Walk speed', 0.5, 8, 0.1, () => p.walkSpeed, (v) => { p.walkSpeed = v; });
    add('Run speed', 1, 14, 0.1, () => p.runSpeed, (v) => { p.runSpeed = v; });
    add('Jump height', 0.2, 6, 0.1, () => p.jumpHeight, (v) => { p.jumpHeight = v; });
    add('Fly speed', 1, 16, 0.1, () => p.flySpeed, (v) => { p.flySpeed = v; });
    add('Max climb °', 10, 85, 1, () => p.maxClimbAngle, (v) => p.setMaxClimbAngle(v));

    const reset = document.createElement('button');
    reset.className = 'terrain-reset';
    reset.textContent = 'Reset physics';
    reset.addEventListener('click', () => { p.resetPhysics(); for (const s of sync) s(); });
    this.panel.appendChild(reset);
  }

  _makeTextureSlot(layer) {
    const b = document.createElement('button');
    b.className = 'terrain-slot';
    b.title = LAYER_LABELS[layer] ?? layer;
    const tag = document.createElement('span');
    tag.className = 'terrain-slot-tag';
    tag.textContent = LAYER_LABELS[layer] ?? layer;
    b.appendChild(tag);

    // `owned` URLs are object URLs we created and must revoke; the CDN/default
    // URLs are not ours to revoke.
    b._objUrl = null;
    const show = (url, owned) => {
      if (b._objUrl) URL.revokeObjectURL(b._objUrl);
      b._objUrl = owned ? url : null;
      b.style.backgroundImage = url ? `url("${url}")` : '';
      b.classList.toggle('filled', !!url);
    };

    // Seed the slot with the texture the terrain is already using for this layer.
    const existing = this._texturePreviewUrl(this.terrain.textures?.[layer]);
    if (existing) show(existing, false);

    const apply = (file) => {
      if (!file?.type?.startsWith('image/')) return; // ignore non-images
      this.terrain.setTerrainTexture(layer, file);
      show(URL.createObjectURL(file), true); // local URL just for the slot thumbnail
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
    return b;
  }

  // ---- open / close ---------------------------------------------------
  open() {
    if (this.active) return;
    this.active = true;
    this.panel.style.display = 'flex';

    // Free the left mouse button for painting; orbit with right-drag, zoom with
    // the wheel (the same scheme the terrain editor example uses).
    this._prevMouseButtons = { ...this.orbit.mouseButtons };
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

    // Rebuild the collider when the heightmap changes (debounced to stroke end).
    this._prevOnChange = this.terrain.onHeightmapChange;
    this.terrain.onHeightmapChange = () => this._markDirty();

    // Only wire painting if a brush mode is already active (otherwise no brush).
    if (this._mode) this._bindPaint();
    // After a paint stroke releases, refresh the physics collider once.
    this._onUp = () => this._flushCollider();
    this.dom.addEventListener('pointerup', this._onUp);
    this.dom.addEventListener('pointercancel', this._onUp);
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.panel.style.display = 'none';
    this._unbindPaint();
    // Reset to "no brush" so reopening starts clean.
    this._mode = null;
    for (const b of Object.values(this._modeButtons)) b.classList.remove('active');
    this.dom.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointercancel', this._onUp);
    this.terrain.onHeightmapChange = this._prevOnChange ?? null;
    if (this._prevMouseButtons) this.orbit.mouseButtons = this._prevMouseButtons;
    this.orbit.enabled = true;
    this._flushCollider();
  }

  _markDirty() { this._dirty = true; }

  // Rebuild the terrain collider if the surface changed since the last rebuild.
  _flushCollider() {
    if (!this._dirty) return;
    this._dirty = false;
    this.player.rebuildTerrainCollider();
  }
}
