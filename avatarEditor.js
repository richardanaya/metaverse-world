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

import { SLIDERS, SEX_PRESETS, PBR_CHANNELS } from 'metaverse-avatar';

const REGION_LABELS = { face: 'Face', upper: 'Upper body', lower: 'Lower body', eyes: 'Eyes' };

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
  constructor({ avatar }) {
    this.avatar = avatar;
    this.active = false;
    this.sliderState = {};   // id -> t (-1.5..1.5)
    this._inputs = new Map(); // id -> range input (for preset / reset sync)

    // One shared hidden file input, re-targeted per upload.
    this._file = document.createElement('input');
    this._file.type = 'file';
    this._file.accept = 'image/*';
    this._file.style.display = 'none';
    document.body.appendChild(this._file);

    this._build();
  }

  open() { this.active = true; this.panel.style.display = 'flex'; }
  close() { this.active = false; this.panel.style.display = 'none'; }

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
    const shapeTab = this._tabButton('Shape', tabs, this._shapePane);
    this._tabButton('Appearance', tabs, this._lookPane);
    shapeTab.classList.add('active');
    this.panel.appendChild(tabs);

    this._buildShape(this._shapePane);
    this._buildAppearance(this._lookPane);
    this.panel.append(this._shapePane, this._lookPane);

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
    const preset = SEX_PRESETS[sex];
    if (!preset) return;
    for (const [id, t] of Object.entries(preset)) {
      this.sliderState[id] = t;
      const ref = this._inputs.get(id);
      if (ref) { ref.input.value = Math.round(t * 100); ref.val.textContent = ref.input.value; }
    }
    this.avatar.applyShape(this.sliderState);
  }

  _reset() {
    this.sliderState = {};
    for (const { input, val } of this._inputs.values()) { input.value = 0; val.textContent = '0'; }
    this.avatar.applyShape(this.sliderState);
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
      for (const ch of PBR_CHANNELS) {
        const slot = this._makeSlot(region, ch);
        slots.appendChild(slot);
        made.push(slot);
      }
      clr.addEventListener('click', () => made.forEach((slot) => slot.clearMap()));
      card.appendChild(slots);
      pane.appendChild(card);
    }
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
        this.avatar.setSkinMap(region, ch.key, img);
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

    b.clearMap = () => { this.avatar.setSkinMap(region, ch.key, null); setUrl(null); };
    return b;
  }
}
