// WorldIO — import / export high-level world entities as JSON.
//
// Entities: terrain, avatar, atmosphere, objects (blocks).
// Export: pick entities + filename → download .json
// Import: drop or pick a file → checkbox entities present → merge into world

import { Avatar, initGltfAnim, getGltfClip, PBR_CHANNELS } from 'metaverse-avatar';
import { TERRAIN_TEXTURE_LAYERS } from 'metaverse-terrain';
import { avatarEntityKey, parseAvatarEntityKey } from './agentName.js';
import { showPanel, hidePanel } from './panelFade.js';

const FORMAT = 'metaverse-world';
// v1: blocks stored in world (Y-up) coordinates.
// v2: blocks stored in the Z-up authoring frame (z = height). v1 files are
//      auto-converted on import via BlockSummoner.importState({ worldToZUp }).
const VERSION = 2;
const LOCO_GLB = 'https://cdn.jsdelivr.net/npm/metaverse-avatar@0.2.0/anims/UAL1_Standard.glb';
const LOCO_STAND = 'Idle_Loop';

const STATIC_ENTITY_KEYS = ['terrain', 'atmosphere', 'objects'];
const STATIC_ENTITY_LABELS = {
  terrain: 'Terrain',
  atmosphere: 'Atmosphere',
  objects: 'Objects',
};

// ---- binary helpers -----------------------------------------------------

function float32ToBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToFloat32(b64, length) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, length);
}

async function imageToDataUrl(img) {
  if (!img?.width) throw new Error('empty image');
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

async function dataUrlToFile(dataUrl, name = 'texture.png') {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

function sanitizeFilename(name) {
  const base = (name || 'world-export').trim().replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'world-export';
}

function isWorldFile(data) {
  return data && data.format === FORMAT && typeof data.entities === 'object';
}

// ---- WorldIO ------------------------------------------------------------

export class WorldIO {
  constructor({
    terrain, player, avatar, avatarEditor, skyEditor, blocks, renderer,
    multiplayer, scene, modelsUrl, getAgentName, clouds = null,
  }) {
    this.terrain = terrain;
    this.player = player;
    this.avatar = avatar;
    this.avatarEditor = avatarEditor;
    this.skyEditor = skyEditor;
    this.blocks = blocks;
    this.renderer = renderer;
    this.multiplayer = multiplayer;
    this.scene = scene;
    this.modelsUrl = modelsUrl;
    this.getAgentName = getAgentName ?? (() => player.agentName || 'avatar');
    this.clouds = clouds;

    this._open = false;
    this._parsed = null;
    this._importedAgents = new Map(); // name -> { avatar }
    this._clipsReady = false;
    this._standClip = null;
    this._buildPanel();
  }

  open(mode = 'import') {
    this._open = true;
    showPanel(this.panel);
    this._setMode(mode);
    if (mode === 'export') this._refreshExportChecks();
  }
  close() { this._open = false; hidePanel(this.panel); }
  isOpen() { return this._open; }

  // ---- export -----------------------------------------------------------

  async _exportTerrain() {
    const t = this.terrain;
    const textures = {};
    for (const layer of TERRAIN_TEXTURE_LAYERS) {
      const src = t.textures?.[layer];
      if (typeof src === 'string') {
        textures[layer] = { kind: 'url', src };
      } else if (src?.isTexture && src.image) {
        try {
          textures[layer] = { kind: 'dataUrl', src: await imageToDataUrl(src.image) };
        } catch {
          const url = src.image?.currentSrc || src.image?.src;
          if (url) textures[layer] = { kind: 'url', src: url };
        }
      }
    }

    return {
      regionSize: t.regionSize,
      samples: t.samples,
      minHeight: t.minHeight,
      maxHeight: t.maxHeight,
      waterLevel: t.waterLevel,
      waterEnabled: t.waterEnabled,
      textureDensity: t.textureDensity,
      textureHeights: { ...t.textureHeights },
      textureBlendWidth: t.textureBlendWidth,
      normalStrength: t.normalStrength,
      terrainAOIntensity: t.terrainAOIntensity,
      wetSandEnabled: t.wetSandEnabled,
      wetSandHeight: t.wetSandHeight,
      shadowsEnabled: false,
      castShadowsEnabled: false,
      heightMap: float32ToBase64(t.heightMap),
      textures,
    };
  }

  _listAgentsForExport() {
    const agents = [{ name: this.getAgentName(), isLocal: true, avatar: this.avatar, editor: this.avatarEditor }];
    if (this.multiplayer) {
      for (const [, remote] of this.multiplayer.remotes) {
        if (!remote.avatar) continue;
        agents.push({ name: remote.name, isLocal: false, remote });
      }
    }
    for (const [name, entry] of this._importedAgents) {
      if (agents.some((a) => a.name === name)) continue;
      agents.push({ name, isLocal: false, avatar: entry.avatar });
    }
    return agents;
  }

  async _exportAvatarData(avatar, editor, remote = null) {
    const g = avatar.group;
    const skins = {};

    for (const region of avatar.getRegions()) {
      skins[region] = {};
      for (const ch of PBR_CHANNELS) {
        const img = avatar.getSkinMap(region, ch.key);
        if (!img) continue;
        try {
          skins[region][ch.key] = await imageToDataUrl(img);
        } catch {
          const url = img.currentSrc || img.src;
          if (url) skins[region][ch.key] = { url };
        }
      }
    }

    const transform = remote
      ? {
        x: remote.pos.x, y: remote.pos.y, z: remote.pos.z,
        ry: remote.yaw,
        sx: g.scale.x, sy: g.scale.y, sz: g.scale.z,
      }
      : {
        x: g.position.x, y: g.position.y, z: g.position.z,
        ry: g.rotation.y,
        sx: g.scale.x, sy: g.scale.y, sz: g.scale.z,
      };

    return {
      shape: editor ? { ...editor.sliderState } : {},
      transform,
      skins,
    };
  }

  _avatarsFromFile(data) {
    const { entities } = data;
    if (entities.avatars && typeof entities.avatars === 'object') return entities.avatars;
    if (entities.avatar) {
      const name = entities.avatar.name || 'Imported';
      return { [name]: { ...entities.avatar, name } };
    }
    return {};
  }

  _entityCount(data) {
    const avatars = this._avatarsFromFile(data);
    return STATIC_ENTITY_KEYS.filter((k) => data.entities[k]).length + Object.keys(avatars).length;
  }

  _exportAtmosphere() {
    const s = this.skyEditor;
    const u = s.u;
    const out = {
      elevation: s.elevation,
      azimuth: s.azimuth,
      turbidity: u.turbidity.value,
      rayleigh: u.rayleigh.value,
      mieCoefficient: u.mieCoefficient.value,
      mieDirectionalG: u.mieDirectionalG.value,
      exposure: this.renderer.toneMappingExposure,
      envIntensityMin: s.envIntensityMin,
      envIntensityMax: s.envIntensityMax,
    };
    if (this.clouds) Object.assign(out, this.clouds.getAtmosphereSettings());
    return out;
  }

  _exportObjects() {
    return { blocks: this.blocks.exportState() };
  }

  async exportWorld(name, keys) {
    const entities = {};
    if (keys.includes('terrain')) entities.terrain = await this._exportTerrain();
    if (keys.includes('atmosphere')) entities.atmosphere = this._exportAtmosphere();
    if (keys.includes('objects')) entities.objects = this._exportObjects();

    const avatarNames = keys.map(parseAvatarEntityKey).filter(Boolean);
    if (avatarNames.length) {
      entities.avatars = {};
      const roster = this._listAgentsForExport();
      for (const agentName of avatarNames) {
        const agent = roster.find((a) => a.name === agentName);
        if (!agent) continue;
        const payload = agent.remote
          ? await this._exportAvatarData(agent.remote.avatar, null, agent.remote)
          : await this._exportAvatarData(agent.avatar, agent.editor ?? null);
        entities.avatars[agentName] = { name: agentName, isLocal: !!agent.isLocal, ...payload };
      }
    }

    return {
      format: FORMAT,
      version: VERSION,
      name: sanitizeFilename(name),
      created: new Date().toISOString(),
      entities,
    };
  }

  downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(filename)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- import -----------------------------------------------------------

  async _importTerrain(data) {
    const t = this.terrain;
    const length = data.samples * data.samples;
    const heightMap = base64ToFloat32(data.heightMap, length);

    if (heightMap.length !== t.heightMap.length) {
      throw new Error('Terrain heightmap size mismatch');
    }

    t.heightMap.set(heightMap);
    if (data.waterLevel != null) t.setWaterLevel(data.waterLevel);
    if (data.textureDensity != null) t.setTextureDensity(data.textureDensity);
    if (data.textureHeights) t.setTextureHeights(data.textureHeights);
    if (data.waterEnabled != null) t.setWaterEnabled(data.waterEnabled);
    if (data.normalStrength != null) t.setNormalStrength(data.normalStrength);
    if (data.terrainAOIntensity != null) t.setTerrainAOIntensity(data.terrainAOIntensity);
    if (data.wetSandEnabled != null) t.setWetSandEnabled(data.wetSandEnabled);
    if (data.wetSandHeight != null) t.setWetSandHeight(data.wetSandHeight);
    t.setShadowsEnabled(false);
    t.setCastShadowsEnabled(false);
    this.renderer.shadowMap.enabled = false;
    if (data.textureBlendWidth != null) {
      t.textureBlendWidth = data.textureBlendWidth;
      t.syncTextureHeightUniforms();
    }

    if (data.textures) {
      for (const layer of TERRAIN_TEXTURE_LAYERS) {
        const tex = data.textures[layer];
        if (!tex) continue;
        if (tex.kind === 'dataUrl' && tex.src) {
          const file = await dataUrlToFile(tex.src, `${layer}.png`);
          t.setTerrainTexture(layer, file);
        }
      }
    }

    t.sync();
    this.player.rebuildTerrainCollider();
  }

  async _ensureStandClip(avatar) {
    if (!this._clipsReady) {
      await initGltfAnim(LOCO_GLB, avatar);
      this._standClip = getGltfClip(LOCO_GLB, LOCO_STAND);
      this._clipsReady = true;
    }
    return this._standClip;
  }

  async _spawnImportedAgent(name, data) {
    const existing = this._importedAgents.get(name);
    if (existing) {
      this.scene.remove(existing.avatar.group);
      existing.avatar.stop?.();
      this._importedAgents.delete(name);
    }

    const avatar = await new Avatar().load(this.modelsUrl);
    avatar.group.rotation.y = -Math.PI / 2;
    avatar.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    avatar.setBlinking(true);
    this.scene.add(avatar.group);

    const clip = await this._ensureStandClip(avatar);
    if (clip) avatar.crossFadeTo(clip, 0, true);

    await this._applyAvatarData(avatar, data, { syncPlayer: false });
    this._importedAgents.set(name, { avatar, name });
    return avatar;
  }

  async _applyAvatarData(avatar, data, { syncPlayer = false } = {}) {
    if (data.shape && Object.keys(data.shape).length) {
      avatar.applyShape(data.shape);
      if (syncPlayer && avatar === this.avatar) {
        this.avatarEditor.sliderState = { ...data.shape };
        for (const [id, val] of Object.entries(data.shape)) {
          const ref = this.avatarEditor._inputs.get(id);
          if (ref) {
            ref.input.value = Math.round(val * 100);
            ref.val.textContent = ref.input.value;
          }
        }
      }
    }

    if (data.skins) {
      for (const [region, maps] of Object.entries(data.skins)) {
        for (const [channel, src] of Object.entries(maps)) {
          if (!src) continue;
          try {
            const dataUrl = typeof src === 'string' ? src : src.url;
            if (!dataUrl) continue;
            const img = await loadImageFromDataUrl(dataUrl);
            avatar.setSkinMap(region, channel, img);
          } catch { /* skip bad maps */ }
        }
      }
    }

    if (data.transform) {
      const g = avatar.group;
      const tr = data.transform;
      g.position.set(tr.x ?? g.position.x, tr.y ?? g.position.y, tr.z ?? g.position.z);
      if (tr.ry != null) g.rotation.y = tr.ry;
      if (tr.sx != null) g.scale.set(tr.sx, tr.sy ?? tr.sx, tr.sz ?? tr.sx);

      if (syncPlayer) {
        this.player.yaw = g.rotation.y;
        const body = this.player.body?.translation();
        if (body) {
          const feet = this.player.feetOffset;
          this.player.body.setTranslation({
            x: tr.x ?? body.x, y: (tr.y ?? body.y - feet) + feet, z: tr.z ?? body.z,
          }, true);
          this.player.body.setNextKinematicTranslation({
            x: tr.x ?? body.x, y: (tr.y ?? body.y - feet) + feet, z: tr.z ?? body.z,
          });
        }
      }
    }
  }

  async _importAvatar(data) {
    await this._applyAvatarData(this.avatar, data, { syncPlayer: true });
  }

  tickAgents(dt) {
    for (const [, entry] of this._importedAgents) entry.avatar.update(dt);
  }

  _importAtmosphere(data) {
    const s = this.skyEditor;
    const u = s.u;
    if (data.elevation != null) s.elevation = data.elevation;
    if (data.azimuth != null) s.azimuth = data.azimuth;
    if (data.turbidity != null) u.turbidity.value = data.turbidity;
    if (data.rayleigh != null) u.rayleigh.value = data.rayleigh;
    if (data.mieCoefficient != null) u.mieCoefficient.value = data.mieCoefficient;
    if (data.mieDirectionalG != null) u.mieDirectionalG.value = data.mieDirectionalG;
    if (data.exposure != null) this.renderer.toneMappingExposure = data.exposure;
    if (data.envIntensityMin != null) s.envIntensityMin = data.envIntensityMin;
    if (data.envIntensityMax != null) s.envIntensityMax = data.envIntensityMax;
    s._updateSun();
    this.clouds?.applyAtmosphereSettings(data);
  }

  _importObjects(data, fileVersion = VERSION) {
    if (data.blocks?.length) {
      this.blocks.importState(data.blocks, { worldToZUp: fileVersion < 2 });
    }
  }

  async importWorld(keys) {
    if (!this._parsed) throw new Error('No file loaded');
    const { entities } = this._parsed;
    const avatars = this._avatarsFromFile(this._parsed);
    const localName = this.getAgentName();

    if (keys.includes('terrain') && entities.terrain) await this._importTerrain(entities.terrain);
    if (keys.includes('atmosphere') && entities.atmosphere) this._importAtmosphere(entities.atmosphere);
    if (keys.includes('objects') && entities.objects) this._importObjects(entities.objects, this._parsed.version ?? 1);

    for (const key of keys) {
      const agentName = parseAvatarEntityKey(key);
      if (!agentName) continue;
      const data = avatars[agentName];
      if (!data) continue;
      if (agentName === localName) await this._importAvatar(data);
      else await this._spawnImportedAgent(agentName, data);
    }
  }

  _loadFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  async _handleFile(file) {
    const data = await this._loadFile(file);
    if (!isWorldFile(data)) throw new Error('Not a metaverse world file');

    this._parsed = data;
    this._fileNameEl.textContent = file.name;
    const count = this._entityCount(data);
    this._fileMetaEl.textContent = `${data.name || 'untitled'} · ${count} entit${count === 1 ? 'y' : 'ies'}`;

    this._importChecks.innerHTML = '';
    for (const key of STATIC_ENTITY_KEYS) {
      if (!data.entities[key]) continue;
      this._importChecks.appendChild(this._makeCheckbox(key, STATIC_ENTITY_LABELS[key], true));
    }
    for (const [agentName, agentData] of Object.entries(this._avatarsFromFile(data))) {
      const label = agentData.name || agentName;
      this._importChecks.appendChild(this._makeCheckbox(avatarEntityKey(agentName), label, true));
    }

    if (!this._importChecks.children.length) {
      throw new Error('File contains no importable entities');
    }

    this._importPane.style.display = 'flex';
    this._dropZone.classList.add('loaded');
    this._doImport.disabled = false;
    this._setStatus('Select entities to import');
  }

  // ---- UI ---------------------------------------------------------------

  _setStatus(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
  }

  _makeCheckbox(id, label, checked = true) {
    const row = document.createElement('label');
    row.className = 'io-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = label;
    row.append(input, span);
    return row;
  }

  _checkedKeys(container) {
    return [...container.querySelectorAll('input[type=checkbox]:checked')].map((el) => el.value);
  }

  _refreshExportChecks() {
    this._exportChecks.innerHTML = '';
    for (const key of STATIC_ENTITY_KEYS) {
      this._exportChecks.appendChild(this._makeCheckbox(key, STATIC_ENTITY_LABELS[key], true));
    }
    const agents = this._listAgentsForExport();
    if (agents.length) {
      const head = document.createElement('div');
      head.className = 'io-section-label';
      head.textContent = 'Agents';
      this._exportChecks.appendChild(head);
    }
    for (const agent of agents) {
      this._exportChecks.appendChild(
        this._makeCheckbox(avatarEntityKey(agent.name), agent.name, true),
      );
    }
  }

  _buildPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'connect-panel io-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'connect-panel-title';
    title.textContent = 'World I/O';
    this.panel.appendChild(title);

    const modes = document.createElement('div');
    modes.className = 'connect-modes seg';
    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    modes.append(importBtn, exportBtn);
    this.panel.appendChild(modes);

    // Export pane
    this._exportPane = document.createElement('div');
    this._exportPane.className = 'connect-pane';

    const nameField = document.createElement('label');
    nameField.className = 'connect-field io-name-field';
    const nameCap = document.createElement('span');
    nameCap.textContent = 'Export filename';
    this._nameInput = document.createElement('input');
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'my-world';
    this._nameInput.spellcheck = false;
    nameField.append(nameCap, this._nameInput);

    const exportHint = document.createElement('div');
    exportHint.className = 'connect-hint';
    exportHint.textContent = 'Choose which entities to include in the download.';

    this._exportChecks = document.createElement('div');
    this._exportChecks.className = 'io-checks';

    const doExport = document.createElement('button');
    doExport.textContent = 'Download JSON';
    doExport.className = 'connect-primary';

    this._exportPane.append(nameField, exportHint, this._exportChecks, doExport);

    // Import pane
    this._importPane = document.createElement('div');
    this._importPane.className = 'connect-pane';
    this._importPane.style.display = 'none';

    this._dropZone = document.createElement('div');
    this._dropZone.className = 'io-dropzone';
    this._dropZone.innerHTML = '<b>Drop a .json file here</b><span>or click to browse</span>';

    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = '.json,application/json';
    this._fileInput.style.display = 'none';

    this._fileNameEl = document.createElement('div');
    this._fileNameEl.className = 'io-file-name';
    this._fileMetaEl = document.createElement('div');
    this._fileMetaEl.className = 'io-file-meta';

    const importHint = document.createElement('div');
    importHint.className = 'connect-hint';
    importHint.textContent = 'Check the entities you want to merge into your current world.';

    this._importChecks = document.createElement('div');
    this._importChecks.className = 'io-checks';

    this._doImport = document.createElement('button');
    this._doImport.textContent = 'Import selected';
    this._doImport.className = 'connect-primary';
    this._doImport.disabled = true;

    this._importPane.append(
      this._dropZone, this._fileNameEl, this._fileMetaEl,
      importHint, this._importChecks, this._doImport,
    );

    this._statusEl = document.createElement('div');
    this._statusEl.className = 'connect-status';
    this._statusEl.textContent = '';

    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'connect-done';
    done.addEventListener('click', () => this.close());

    this.panel.append(this._exportPane, this._importPane, this._statusEl, done);
    document.body.appendChild(this.panel);
    document.body.appendChild(this._fileInput);

    const setMode = (mode) => {
      const exp = mode === 'export';
      exportBtn.classList.toggle('active', exp);
      importBtn.classList.toggle('active', !exp);
      this._exportPane.style.display = exp ? 'flex' : 'none';
      this._importPane.style.display = exp ? 'none' : 'flex';
      this._setStatus('');
    };
    this._setMode = setMode;
    importBtn.addEventListener('click', () => setMode('import'));
    exportBtn.addEventListener('click', () => { setMode('export'); this._refreshExportChecks(); });
    setMode('import');

    const runAsync = async (btn, busy, fn) => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = busy;
      try {
        await fn();
      } catch (err) {
        console.error('[world-io]', err);
        this._setStatus(err?.message || 'Operation failed');
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    };

    doExport.addEventListener('click', () => runAsync(doExport, 'Exporting…', async () => {
      const keys = this._checkedKeys(this._exportChecks);
      if (!keys.length) throw new Error('Select at least one entity');
      const name = this._nameInput.value.trim() || 'world-export';
      this._setStatus('Serializing…');
      const data = await this.exportWorld(name, keys);
      this.downloadJson(data, name);
      this._setStatus(`Downloaded ${sanitizeFilename(name)}.json`);
    }));

    this._doImport.addEventListener('click', () => runAsync(this._doImport, 'Importing…', async () => {
      const keys = this._checkedKeys(this._importChecks);
      if (!keys.length) throw new Error('Select at least one entity');
      this._setStatus('Applying…');
      await this.importWorld(keys);
      this._setStatus(`Imported ${keys.length} entit${keys.length === 1 ? 'y' : 'ies'}`);
    }));

    this._dropZone.addEventListener('click', () => this._fileInput.click());
    this._fileInput.addEventListener('change', () => {
      const file = this._fileInput.files?.[0];
      if (file) runAsync(this._doImport, 'Reading…', () => this._handleFile(file));
      this._fileInput.value = '';
    });

    for (const el of [this._dropZone, this.panel]) {
      el.addEventListener('dragover', (e) => { e.preventDefault(); this._dropZone.classList.add('drag'); });
      el.addEventListener('dragleave', () => this._dropZone.classList.remove('drag'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        this._dropZone.classList.remove('drag');
        const file = e.dataTransfer?.files?.[0];
        if (file) runAsync(this._doImport, 'Reading…', () => this._handleFile(file));
      });
    }
  }
}