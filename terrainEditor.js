// TerrainEditor — a floating sidebar to sculpt and configure the terrain.
//
// Opened from the right-click menu ("Edit terrain"). While open it:
//   • Left-press on the terrain paints with the active brush (Raise / Lower /
//     Flatten). The brush keeps applying while the button is held even if the
//     mouse stays still, so you can hold to keep raising/lowering one spot. Hold
//     Shift to temporarily invert to Lower. The brush ring shows where you paint.
//   • A sidebar exposes brush, layer heights, tiling, PBR, textures, physics,
//     and terrain actions (randomize / flatten / export heightmap).
//   • Done closes the editor.
//
// Painting is wired with a small local binding (built on the library's
// getTerrainHitFromPointer) that ticks the brush on every animation frame while
// the button is down. Sculpting changes the heightmap, which makes the physics
// collider stale — so after every stroke (and after Randomize / Flatten) we
// rebuild the controller's terrain collider so what you walk on matches what you
// see.

import * as THREE from 'three';
import { showPanel, hidePanel } from './panelFade.js';
import { getTerrainHitFromPointer, TERRAIN_TEXTURE_LAYERS, PBR_CHANNELS, loadPBRTextureSet } from 'metaverse-terrain';

const LAYER_LABELS = { sand: 'Sand', grass: 'Grass', rock: 'Rock', snow: 'Snow', water: 'Water' };
const PBR_CHANNEL_LABELS = { metal: 'M', roughness: 'R', normal: 'N', ao: 'AO' };
const LAYER_ORDER = ['water', 'grass', 'rock', 'snow'];
const LAYER_GAP = 1;
// Layer-height slider range — matches metaverse-terrain example/editor (not full min/max height).
const LAYER_SLIDER_MIN = 0;
const LAYER_SLIDER_MAX = 40;

export class TerrainEditor {
  constructor({ renderer, camera, controls, terrain, player }) {
    this.renderer = renderer;
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
    this._textureBase = this._resolveTextureBase(terrain);
    this._pbrSources = this._resolvePBRSources(terrain);

    this._layerRange = { min: LAYER_SLIDER_MIN, max: LAYER_SLIDER_MAX };
    this._layerHeights = {
      water: terrain.waterLevel,
      grass: terrain.textureHeights.grassStart,
      rock: terrain.textureHeights.rockStart,
      snow: terrain.textureHeights.snowStart,
    };

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

    // Brush
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

    this._addSlider('Radius', 2, 48, 1, this.terrain.brush.radius,
      (v) => this.terrain.setBrushRadius(v), (v) => `${Math.round(v)}m`);
    this._addSlider('Strength', 0.05, 2, 0.05, this.terrain.brush.strength,
      (v) => this.terrain.setBrushStrength(v));

    // Terrain size controls.
    this._addTerrainDetail();

    // Layer height bands (water / grass / rock / snow transitions).
    this._addLayers();

    // Texture scale and blend controls.
    this._addTiling();

    // PBR surface + water shading.
    this._addPBR();

    // Terrain shading controls.
    this._addShading();

    // Per-layer albedo + bundled PBR map previews.
    this._addTextures();

    // World physics (Rapier).
    this._addPhysics();

    // Actions + heightmap preview.
    this._addActions();
    this._addHeightmapPreview();

    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'terrain-done';
    done.addEventListener('click', () => this.close());
    this.panel.appendChild(done);

    document.body.appendChild(this.panel);
  }

  _addLabel(text) {
    const el = document.createElement('div');
    el.className = 'terrain-section';
    el.textContent = text;
    this.panel.appendChild(el);
  }

  // Returns a handle whose `set(v)` updates both the slider and its readout.
  _addSlider(label, min, max, step, value, onInput, format = null) {
    const row = document.createElement('label');
    row.className = 'terrain-row';
    const cap = document.createElement('span');
    const val = document.createElement('b');
    const fmt = format ?? ((v) => (step < 1 ? Number(v).toFixed(2) : String(Math.round(v))));
    cap.textContent = label;
    val.textContent = fmt(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => {
      const n = parseFloat(input.value);
      val.textContent = fmt(n);
      onInput(n);
    });
    const head = document.createElement('div');
    head.className = 'terrain-row-head';
    head.append(cap, val);
    row.append(head, input);
    this.panel.appendChild(row);
    return { input, set: (v) => { input.value = v; val.textContent = fmt(v); } };
  }

  _addCheckbox(label, checked, onChange) {
    const row = document.createElement('label');
    row.className = 'terrain-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = label;
    input.addEventListener('change', () => {
      row.classList.toggle('is-off', !input.checked);
      onChange(input.checked);
    });
    row.classList.toggle('is-off', !checked);
    row.append(input, span);
    this.panel.appendChild(row);
    return { input, set: (on) => { input.checked = on; row.classList.toggle('is-off', !on); } };
  }

  _addSelect(label, options, value, onChange) {
    const row = document.createElement('label');
    row.className = 'terrain-row';
    const head = document.createElement('div');
    head.className = 'terrain-row-head';
    const cap = document.createElement('span');
    cap.textContent = label;
    const select = document.createElement('select');
    for (const [val, text] of options) {
      const option = document.createElement('option');
      option.value = val;
      option.textContent = text;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    head.append(cap);
    row.append(head, select);
    this.panel.appendChild(row);
    return { select, set: (v) => { select.value = v; } };
  }

  _addTerrainDetail() {
    this._addLabel('Terrain');
    this._terrainDetailControls = {
      regionSize: this._addSlider('Region size', 64, 512, 8, this.terrain.regionSize,
        (v) => { this.terrain.setRegionSize(v); this._markDirty(); this._flushCollider(); this._refreshHeightmap(); }, (v) => `${Math.round(v)}m`),
    };
  }

  _addLayers() {
    this._addLabel('Layers');
    this._waterEnabled = this._addCheckbox('Water plane', this.terrain.waterEnabled, (on) => {
      this.terrain.setWaterEnabled(on);
      this._layerSlider?.classList.toggle('water-off', !on);
    });
    const waterU = this.terrain.waterMesh?.material?.uniforms;
    this._refractionEnabled = this._addCheckbox('Refraction', this.terrain.refractionEnabled, (on) => this.terrain.setRefractionEnabled(on));
    this._waterDarkness = this._addSlider('Water darkness', 0, 1, 0.01, this.terrain.waterDarkness ?? waterU?.uWaterDarkness?.value ?? 0.5,
      (v) => this.terrain.setWaterDarkness(v), (v) => (v < 0.2 ? 'Pristine' : v < 0.4 ? 'Clear' : v < 0.6 ? 'Ocean' : v < 0.8 ? 'Murky' : 'Swamp'));

    this._layerSlider = document.createElement('div');
    this._layerSlider.className = 'terrain-layer-slider';
    if (!this.terrain.waterEnabled) this._layerSlider.classList.add('water-off');

    const track = document.createElement('div');
    track.className = 'terrain-layer-track';
    this._layerGradient = document.createElement('div');
    this._layerGradient.className = 'terrain-layer-gradient';
    track.appendChild(this._layerGradient);

    this._layerHandles = {};
    for (const layer of LAYER_ORDER) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `terrain-layer-handle ${layer}`;
      handle.dataset.layer = layer;
      handle.setAttribute('aria-label', `${LAYER_LABELS[layer] ?? layer} height`);
      track.appendChild(handle);
      this._layerHandles[layer] = handle;
    }
    this._layerSlider.appendChild(track);

    const readouts = document.createElement('div');
    readouts.className = 'terrain-layer-readouts';
    this._layerReadouts = {};
    for (const [layer, cap] of [['water', 'Water'], ['grass', 'Grass'], ['rock', 'Rock'], ['snow', 'Snow']]) {
      const line = document.createElement('span');
      line.innerHTML = `${cap} <b>—</b>`;
      this._layerReadouts[layer] = line.querySelector('b');
      readouts.appendChild(line);
    }
    this._layerSlider.append(readouts);
    this.panel.appendChild(this._layerSlider);

    this._bindLayerSlider();
    this._syncLayerSlider();
  }

  _heightToPercent(value) {
    const { min, max } = this._layerRange;
    return ((value - min) / (max - min)) * 100;
  }

  _heightFromPointer(clientX) {
    const track = this._layerSlider.querySelector('.terrain-layer-track');
    const rect = track.getBoundingClientRect();
    const t = THREE.MathUtils.clamp((clientX - rect.left) / rect.width, 0, 1);
    const raw = this._layerRange.min + t * (this._layerRange.max - this._layerRange.min);
    return Math.round(raw * 2) / 2;
  }

  _clampLayerHeight(layer, value) {
    const index = LAYER_ORDER.indexOf(layer);
    const previous = LAYER_ORDER[index - 1];
    const next = LAYER_ORDER[index + 1];
    const min = previous ? this._layerHeights[previous] + LAYER_GAP : this._layerRange.min;
    const max = next ? this._layerHeights[next] - LAYER_GAP : this._layerRange.max;
    return THREE.MathUtils.clamp(value, min, max);
  }

  _applyLayerHeights() {
    const h = this._layerHeights;
    this.terrain.setWaterLevel(h.water);
    this.terrain.setTextureHeights({
      sandMax: h.grass,
      grassStart: h.grass,
      grassEnd: h.rock,
      rockStart: h.rock,
      snowStart: h.snow,
    });
    this._syncLayerSlider();
  }

  _syncLayerSlider() {
    const h = this._layerHeights;
    for (const layer of LAYER_ORDER) {
      const handle = this._layerHandles[layer];
      if (handle) handle.style.left = `${this._heightToPercent(h[layer])}%`;
      if (this._layerReadouts[layer]) this._layerReadouts[layer].textContent = `${h[layer].toFixed(1)}m`;
    }

    const w = this._heightToPercent(h.water);
    const g = this._heightToPercent(h.grass);
    const r = this._heightToPercent(h.rock);
    const s = this._heightToPercent(h.snow);
    this._layerGradient.style.background = `linear-gradient(90deg,
      #1f8aa5 0%, #1f8aa5 ${w}%,
      #d8c995 ${w}%, #d8c995 ${g}%,
      #6d8b35 ${g}%, #6d8b35 ${r}%,
      #8c928f ${r}%, #8c928f ${s}%,
      #f2f5f4 ${s}%, #f2f5f4 100%)`;
  }

  _bindLayerSlider() {
    const moveLayer = (layer, clientX) => {
      this._layerHeights[layer] = this._clampLayerHeight(layer, this._heightFromPointer(clientX));
      this._applyLayerHeights();
    };

    for (const handle of Object.values(this._layerHandles)) {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        moveLayer(handle.dataset.layer, e.clientX);
      });
      handle.addEventListener('pointermove', (e) => {
        if (handle.hasPointerCapture(e.pointerId)) moveLayer(handle.dataset.layer, e.clientX);
      });
    }
  }

  _addTiling() {
    this._addLabel('Texture');
    this._tilingSliders = {
      density: this._addSlider('Texture scale', 4, 48, 1, this.terrain.textureDensity,
        (v) => this.terrain.setTextureDensity(v), (v) => `${Math.round(v)}×`),
      blend: this._addSlider('Blend width', 1, 12, 0.5, this.terrain.textureBlendWidth, (v) => {
        this.terrain.textureBlendWidth = v;
        this.terrain.syncTextureHeightUniforms();
      }, (v) => `${Number(v).toFixed(1)}m`),
    };
  }

  _addPBR() {
    this._addLabel('PBR');
    const waterU = this.terrain.waterMesh?.material?.uniforms;
    const pbrOn = (waterU?.uPBREnabled?.value ?? 1) > 0.5;
    const ior = waterU?.uWaterIOR?.value ?? 1.33;

    this._pbrSliders = {
      normal: this._addSlider('Normal strength', 0, 2, 0.05, this.terrain.normalStrength,
        (v) => this.terrain.setNormalStrength(v)),
      metal: this._addSlider('Metal', 0, 2, 0.01, this.terrain.terrainMetalIntensity ?? 1,
        (v) => this._setTerrainPBRIntensity('terrainMetalIntensity', 'uTerrainMetalIntensity', 'setTerrainMetalIntensity', v), (v) => `${Math.round(v * 100)}%`),
      roughness: this._addSlider('Roughness', 0, 2, 0.01, this.terrain.terrainRoughnessIntensity ?? 1.75,
        (v) => this._setTerrainPBRIntensity('terrainRoughnessIntensity', 'uTerrainRoughnessIntensity', 'setTerrainRoughnessIntensity', v), (v) => `${Math.round(v * 100)}%`),
      ao: this._addSlider('Land AO', 0, 2, 0.01, this.terrain.terrainAOIntensity,
        (v) => this.terrain.setTerrainAOIntensity(v), (v) => `${Math.round(v * 100)}%`),
      ior: this._addSlider('Water IOR', 1.0, 1.55, 0.01, ior,
        (v) => this.terrain.setWaterIOR(v)),
    };
    this._waterPBR = this._addCheckbox('Water PBR', pbrOn, (on) => this.terrain.setPBREnabled(on));
  }

  _addShading() {
    this._addLabel('Terrain shading');
    this.terrain.setShadowsEnabled(false);
    this.terrain.setCastShadowsEnabled(false);
    this.renderer.shadowMap.enabled = false;
    this._shadingChecks = {
      wetSand: this._addCheckbox('Wet sand', this.terrain.wetSandEnabled, (on) => this.terrain.setWetSandEnabled(on)),
    };
    this._shadingSliders = {
      wetSandHeight: this._addSlider('Wet sand height', 0, 4, 0.05, this.terrain.wetSandHeight ?? 0.25,
        (v) => this.terrain.setWetSandHeight(v), (v) => `${Number(v).toFixed(2)}m`),
    };
  }

  _syncTerrainControls() {
    const t = this.terrain;
    const u = t.waterMesh?.material?.uniforms;
    this._tilingSliders?.density?.set(t.textureDensity);
    this._tilingSliders?.blend?.set(t.textureBlendWidth);
    this._pbrSliders?.normal?.set(t.normalStrength);
    this._pbrSliders?.metal?.set(t.terrainMetalIntensity ?? 1);
    this._pbrSliders?.roughness?.set(t.terrainRoughnessIntensity ?? 1.75);
    this._pbrSliders?.ao?.set(t.terrainAOIntensity);
    this._pbrSliders?.ior?.set(u?.uWaterIOR?.value ?? 1.33);
    this._waterPBR?.set((u?.uPBREnabled?.value ?? 1) > 0.5);
    this._refractionEnabled?.set(t.refractionEnabled);
    this._waterDarkness?.set(t.waterDarkness ?? u?.uWaterDarkness?.value ?? 0.5);
    this._shadingChecks?.wetSand?.set(t.wetSandEnabled);
    this._shadingSliders?.wetSandHeight?.set(t.wetSandHeight ?? 0.25);
  }

  _setTerrainPBRIntensity(prop, uniform, setter, value) {
    if (typeof this.terrain[setter] === 'function') {
      this.terrain[setter](value);
      return;
    }
    this.terrain[prop] = value;
    const shader = this.terrain.terrainMesh?.material?.userData?.shader;
    if (shader?.uniforms?.[uniform]) shader.uniforms[uniform].value = value;
  }

  _addActions() {
    this._addLabel('Actions');
    const actions = document.createElement('div');
    actions.className = 'terrain-actions';
    const mkAction = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mkAction('Randomize', () => { this.terrain.randomize(); this._markDirty(); this._flushCollider(); this._refreshHeightmap(); });
    mkAction('Flatten', () => { this.terrain.level(); this._markDirty(); this._flushCollider(); this._refreshHeightmap(); });
    mkAction('Heightmap', () => this.terrain.downloadHeightmap());
    this.panel.appendChild(actions);
  }

  _addHeightmapPreview() {
    const card = document.createElement('div');
    card.className = 'terrain-heightmap';
    const meta = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'terrain-heightmap-label';
    label.textContent = 'Heightmap';
    this._heightmapStats = document.createElement('div');
    this._heightmapStats.className = 'terrain-heightmap-stats';
    meta.append(label, this._heightmapStats);
    this._heightmapCanvas = document.createElement('canvas');
    this._heightmapCanvas.width = 64;
    this._heightmapCanvas.height = 64;
    this._heightmapCanvas.setAttribute('aria-label', 'Heightmap preview');
    card.append(meta, this._heightmapCanvas);
    this.panel.appendChild(card);
    this._refreshHeightmap();
  }

  _refreshHeightmap() {
    if (!this._heightmapCanvas) return;
    this._heightmapStats.textContent = this.terrain.drawHeightmapPreview(this._heightmapCanvas);
  }

  // Brush modes toggle: clicking the active one turns the brush off.
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

  // Custom painting binding: like the library's bindTerrainPainting, but it
  // re-applies the brush every animation frame while the button is held — so you
  // don't need to keep wiggling the mouse to keep raising/lowering. The brush
  // tracks the latest cursor hit; if the cursor leaves the terrain it pauses.
  _bindPaint() {
    if (this._binding) return;
    const region = this.terrain;
    const dom = this.dom;
    const getHit = (e) => getTerrainHitFromPointer(
      region, dom, this.camera, this.raycaster, this.pointer, e.clientX, e.clientY,
    );

    let painting = false;
    let lastPoint = null;   // latest terrain hit (null = cursor off-terrain, paint pauses)
    let shiftDown = false;
    let raf = null;

    const apply = (point) => region.paintAt(point, { temporaryLower: shiftDown, live: true, emit: false });
    const tick = () => {
      raf = painting ? requestAnimationFrame(tick) : null;
      if (painting && lastPoint) apply(lastPoint);
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      const hit = getHit(e);
      if (!hit) return;
      painting = true;
      shiftDown = e.shiftKey;
      lastPoint = hit.point.clone();
      region.beginStroke();
      this.orbit.enabled = false;
      dom.setPointerCapture(e.pointerId);
      apply(lastPoint);
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const onMove = (e) => {
      shiftDown = e.shiftKey;
      const hit = getHit(e);
      if (!hit) {
        if (region.brushCursor) region.brushCursor.visible = false;
        lastPoint = null; // off-terrain: pause continuous paint until back on
        return;
      }
      const previewMode = e.shiftKey ? 'lower' : region.brush.mode;
      if (region.brushCursor) region.updateBrushCursor(region.brushCursor, hit.point, { mode: previewMode });
      if (painting) lastPoint = hit.point.clone();
    };

    const onUp = (e) => {
      if (!painting) return;
      painting = false;
      lastPoint = null;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      region.endStroke();
      this.orbit.enabled = true;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };

    const onLeave = () => { if (!painting && region.brushCursor) region.brushCursor.visible = false; };
    const onCtx = (e) => e.preventDefault();

    dom.addEventListener('contextmenu', onCtx);
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('pointerleave', onLeave);

    this._binding = {
      unbind() {
        painting = false;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        dom.removeEventListener('contextmenu', onCtx);
        dom.removeEventListener('pointerdown', onDown);
        dom.removeEventListener('pointermove', onMove);
        dom.removeEventListener('pointerup', onUp);
        dom.removeEventListener('pointercancel', onUp);
        dom.removeEventListener('pointerleave', onLeave);
      },
    };
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

  _resolveTextureBase(terrain) {
    const sand = terrain.textures?.sand;
    if (typeof sand === 'string') return sand.replace(/\/terrain-sand\.png$/, '');
    return null;
  }

  // Seed per-layer PBR channel sources from the bundled CDN URLs so repacking
  // a single channel keeps the other three at their current (default or
  // previously-uploaded) source.
  _resolvePBRSources(terrain) {
    const base = this._textureBase;
    const sources = {};
    if (!base) return sources;
    for (const layer of TERRAIN_TEXTURE_LAYERS) {
      sources[layer] = {};
      for (const ch of PBR_CHANNELS) {
        sources[layer][ch] = `${base}/terrain-${layer}_${ch}.png`;
      }
    }
    return sources;
  }

  _addTextures() {
    this._addLabel('Textures');
    const hint = document.createElement('div');
    hint.className = 'terrain-hint';
    hint.innerHTML = 'Click or drop an image onto any slot to retexture. Albedo sets the layer color; M/R/N/AO replace PBR maps. Use × to revert.';
    this.panel.appendChild(hint);

    for (const layer of TERRAIN_TEXTURE_LAYERS) this.panel.appendChild(this._makeLayerCard(layer));
  }

  _makeLayerCard(layer) {
    const card = document.createElement('div');
    card.className = 'avatar-mat-card';

    const head = document.createElement('div');
    head.className = 'avatar-mat-head';
    const name = document.createElement('span');
    name.textContent = LAYER_LABELS[layer] ?? layer;
    head.appendChild(name);
    card.appendChild(head);

    const slots = document.createElement('div');
    slots.className = 'terrain-slots';
    slots.appendChild(this._makeTextureSlot(layer, 'Albedo'));
    for (const ch of PBR_CHANNELS) slots.appendChild(this._makePBRSlot(layer, ch));
    card.appendChild(slots);
    return card;
  }

  _makePBRSlot(layer, channel) {
    const b = document.createElement('div');
    b.className = 'terrain-slot filled';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.title = `${LAYER_LABELS[layer] ?? layer} · ${channel}`;
    const tag = document.createElement('span');
    tag.className = 'terrain-slot-tag';
    tag.textContent = PBR_CHANNEL_LABELS[channel] ?? channel;
    b.appendChild(tag);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'terrain-slot-x';
    x.textContent = '×';
    x.setAttribute('aria-label', `Detach ${LAYER_LABELS[layer] ?? layer} ${channel}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setPBRSource(layer, channel, null);
    });
    b.appendChild(x);

    b._objUrl = null;
    const show = (url, owned) => {
      if (b._objUrl) URL.revokeObjectURL(b._objUrl);
      b._objUrl = owned ? url : null;
      b.style.backgroundImage = url ? `url("${url}")` : '';
      b.classList.toggle('is-custom', !!owned);
    };

    const current = this._pbrSources[layer]?.[channel];
    if (current) show(current, false);

    const apply = (file) => {
      if (!file?.type?.startsWith('image/')) return;
      const url = URL.createObjectURL(file);
      this._setPBRSource(layer, channel, url, () => show(url, true));
    };

    b.addEventListener('click', () => this._pickFile(apply));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._pickFile(apply); } });
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

  // Repack and apply a PBR channel for a layer. `source` is a URL string or
  // null (null reverts to the bundled default). `onApplied` runs after the
  // uniform update succeeds.
  async _setPBRSource(layer, channel, source, onApplied) {
    if (!this._textureBase) return;
    const sources = this._pbrSources[layer] ?? {};
    const bundled = (ch) => `${this._textureBase}/terrain-${layer}_${ch}.png`;
    sources[channel] = source ?? bundled(channel);
    this._pbrSources[layer] = sources;

    const cap = layer.charAt(0).toUpperCase() + layer.slice(1);
    const isWater = layer === 'water';
    const mat = isWater ? this.terrain.waterMesh?.material : this.terrain.terrainMesh?.material;
    if (!mat) return;
    const uniforms = isWater ? mat.uniforms : mat.userData?.shader?.uniforms;
    if (!uniforms) return;

    try {
      if (channel === 'normal') {
        const packed = await loadPBRTextureSet({ [layer]: { normal: sources.normal } });
        const tex = packed[layer]?.normal;
        if (tex) uniforms[`u${cap}Normal`].value = tex;
      } else {
        const packed = await loadPBRTextureSet({
          [layer]: { metal: sources.metal, roughness: sources.roughness, ao: sources.ao },
        });
        const tex = packed[layer]?.mrao;
        if (tex) uniforms[`u${cap}MRAO`].value = tex;
      }
      onApplied?.();
    } catch (err) {
      console.error(`Failed to repack ${layer}.${channel}:`, err);
    }
  }

  _texturePreviewUrl(tex) {
    if (!tex) return null;
    if (typeof tex === 'string') return tex;
    if (tex.isTexture) return tex.userData?.objectUrl || tex.image?.currentSrc || tex.image?.src || null;
    return null;
  }

  _addPhysics() {
    const p = this.player;
    if (!p) return;
    this._addLabel('Physics');
    const sync = [];
    const add = (label, min, max, step, get, set) => {
      const c = this._addSlider(label, min, max, step, get(), set);
      sync.push(() => c.set(get()));
    };
    add('Gravity', 4, 60, 1, () => -p.gravity, (v) => { p.gravity = -v; });
    add('Walk speed', 0.5, 8, 0.1, () => p.walkSpeed, (v) => { p.walkSpeed = v; });
    add('Run speed', 1, 14, 0.1, () => p.runSpeed, (v) => { p.runSpeed = v; });
    add('Jump height', 0.2, 6, 0.1, () => p.jumpHeight, (v) => { p.jumpHeight = v; });
    add('Run-jump boost', 0, 3, 0.1, () => p.runJumpBoost, (v) => { p.runJumpBoost = v; });
    add('Fly speed', 1, 16, 0.1, () => p.flySpeed, (v) => { p.flySpeed = v; });
    add('Max climb °', 10, 85, 1, () => p.maxClimbAngle, (v) => p.setMaxClimbAngle(v));

    const reset = document.createElement('button');
    reset.className = 'terrain-reset';
    reset.textContent = 'Reset physics';
    reset.addEventListener('click', () => { p.resetPhysics(); for (const s of sync) s(); });
    this.panel.appendChild(reset);
  }

  _makeTextureSlot(layer, label = 'Albedo') {
    const b = document.createElement('div');
    b.className = 'terrain-slot';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.title = `${LAYER_LABELS[layer] ?? layer} · ${label}`;
    const tag = document.createElement('span');
    tag.className = 'terrain-slot-tag';
    tag.textContent = label;
    b.appendChild(tag);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'terrain-slot-x';
    x.textContent = '×';
    x.setAttribute('aria-label', `Detach ${LAYER_LABELS[layer] ?? layer} ${label}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._textureBase) return;
      const defaultUrl = `${this._textureBase}/terrain-${layer}.png`;
      this.terrain.setTerrainTexture(layer, defaultUrl);
      show(defaultUrl, false);
    });
    b.appendChild(x);

    b._objUrl = null;
    const show = (url, owned) => {
      if (b._objUrl) URL.revokeObjectURL(b._objUrl);
      b._objUrl = owned ? url : null;
      b.style.backgroundImage = url ? `url("${url}")` : '';
      b.classList.toggle('filled', !!url);
      b.classList.toggle('is-custom', !!owned);
    };

    const existing = this._texturePreviewUrl(this.terrain.textures?.[layer]);
    if (existing) show(existing, false);

    const apply = (file) => {
      if (!file?.type?.startsWith('image/')) return;
      this.terrain.setTerrainTexture(layer, file);
      show(URL.createObjectURL(file), true);
    };

    b.addEventListener('click', () => this._pickFile(apply));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._pickFile(apply); } });
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

  open() {
    if (this.active) return;
    this.active = true;
    showPanel(this.panel);

    this._prevMouseButtons = { ...this.orbit.mouseButtons };
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

    this._prevOnChange = this.terrain.onHeightmapChange;
    this.terrain.onHeightmapChange = () => {
      this._markDirty();
      this._refreshHeightmap();
    };

    this._layerHeights = {
      water: this.terrain.waterLevel,
      grass: this.terrain.textureHeights.grassStart,
      rock: this.terrain.textureHeights.rockStart,
      snow: this.terrain.textureHeights.snowStart,
    };
    this._waterEnabled?.set(this.terrain.waterEnabled);
    this._layerSlider?.classList.toggle('water-off', !this.terrain.waterEnabled);
    this._syncTerrainControls();
    this._syncLayerSlider();
    this._refreshHeightmap();

    if (this._mode) this._bindPaint();
    this._onUp = () => this._flushCollider();
    this.dom.addEventListener('pointerup', this._onUp);
    this.dom.addEventListener('pointercancel', this._onUp);
  }

  close() {
    if (!this.active) return;
    this.active = false;
    hidePanel(this.panel);
    this._unbindPaint();
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

  _flushCollider() {
    if (!this._dirty) return;
    this._dirty = false;
    this.player.rebuildTerrainCollider();
  }
}
