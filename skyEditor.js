// SkyEditor — a floating sidebar to tweak the Preetham Sky, opened from the
// right-click menu ("Edit sky…") when you right-click empty sky.
//
// Controls the sun direction (elevation / azimuth), the atmospheric scattering
// uniforms (turbidity / rayleigh / mie / mie-G), renderer exposure, and the
// Minecraft-style cloud layer (shape, noise, wind, color).

import * as THREE from 'three';
import { showPanel, hidePanel } from './panelFade.js';

export class SkyEditor {
  constructor({
    sky,
    light = null,
    renderer,
    clouds = null,
    onSunChange = null,
    envIntensityMin = 1.0,
    envIntensityMax = 2.0,
  }) {
    this.sky = sky;
    this.u = sky.material.uniforms;
    this.light = light;
    this.renderer = renderer;
    this.clouds = clouds;
    this.onSunChange = onSunChange;
    this.envIntensityMin = envIntensityMin;
    this.envIntensityMax = envIntensityMax;
    this.active = false;

    // Derive the starting sun elevation/azimuth from the sky's current sun dir.
    const d = this.u.sunPosition.value;
    this.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)));
    this.azimuth = THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z));
    this.lightDist = light?.position.length() || 220;

    this._build();
  }

  open() { this.active = true; showPanel(this.panel); }
  close() { this.active = false; hidePanel(this.panel); }

  _build() {
    this.panel = document.createElement('div');
    this.panel.className = 'sky-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'sky-panel-title';
    title.textContent = 'Sky';
    this.panel.appendChild(title);

    this._section('Sun');
    this._slider('Elevation', -20, 90, 0.5, this.elevation, (v) => { this.elevation = v; this._updateSun(); });
    this._slider('Azimuth', -180, 180, 1, this.azimuth, (v) => { this.azimuth = v; this._updateSun(); });

    this._section('Environment');
    this._slider('IBL min', 0, 2, 0.01, this.envIntensityMin, (v) => {
      this.envIntensityMin = v;
      if (this.envIntensityMin > this.envIntensityMax) this.envIntensityMax = this.envIntensityMin;
      this._envMaxSlider?.set(this.envIntensityMax);
      this.onSunChange?.();
    });
    this._envMinSlider = this._lastSlider;
    this._slider('IBL max', 0, 2, 0.01, this.envIntensityMax, (v) => {
      this.envIntensityMax = v;
      if (this.envIntensityMax < this.envIntensityMin) this.envIntensityMin = this.envIntensityMax;
      this._envMinSlider?.set(this.envIntensityMin);
      this.onSunChange?.();
    });
    this._envMaxSlider = this._lastSlider;

    this._section('Atmosphere');
    this._slider('Turbidity', 0, 20, 0.1, this.u.turbidity.value, (v) => { this.u.turbidity.value = v; });
    this._slider('Rayleigh', 0, 4, 0.05, this.u.rayleigh.value, (v) => { this.u.rayleigh.value = v; });
    this._slider('Haze (Mie)', 0, 0.1, 0.001, this.u.mieCoefficient.value, (v) => { this.u.mieCoefficient.value = v; });
    this._slider('Sun glow (Mie-G)', 0, 1, 0.01, this.u.mieDirectionalG.value, (v) => { this.u.mieDirectionalG.value = v; });
    this._slider('Exposure', 0, 1, 0.01, this.renderer.toneMappingExposure, (v) => { this.renderer.toneMappingExposure = v; });

    if (this.clouds) this._buildCloudSection();

    const done = document.createElement('button');
    done.className = 'sky-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => this.close());
    this.panel.appendChild(done);

    document.body.appendChild(this.panel);
  }

  _buildCloudSection() {
    const c = this.clouds;
    const p = c.params;
    this._section('Clouds');
    this._checkbox('Enabled', p.enabled, (on) => {
      c.applyAtmosphereSettings({ cloudsEnabled: on });
    });
    this._slider('Opacity', 0, 1, 0.01, p.opacity, (v) => {
      c.applyAtmosphereSettings({ cloudOpacity: v });
    });
    this._slider('Altitude (m)', 55, 140, 1, p.altitude, (v) => {
      c.applyAtmosphereSettings({ cloudAltitude: v });
    });
    this._slider('Tiling', 3, 10, 0.5, p.tile, (v) => {
      c.applyAtmosphereSettings({ cloudTile: v });
    });

    this._section('Cloud shape');
    this._slider('Puff scale', 0.5, 2, 0.05, p.puffScale, (v) => {
      c.applyAtmosphereSettings({ cloudPuffScale: v });
    });
    this._slider('Layer height', 0.5, 2, 0.05, p.layerHeight, (v) => {
      c.applyAtmosphereSettings({ cloudLayerHeight: v });
    });
    this._slider('Corner roundness', 0.05, 0.35, 0.01, p.roundness, (v) => {
      c.applyAtmosphereSettings({ cloudRoundness: v });
    });
    this._slider('Edge softness', 0, 0.5, 0.01, p.softness, (v) => {
      c.applyAtmosphereSettings({ cloudSoftness: v });
    });

    this._section('Cloud noise');
    this._slider('Coverage', 0.2, 0.8, 0.01, p.coverage, (v) => {
      c.applyAtmosphereSettings({ cloudCoverage: v });
    });
    this._slider('Pattern scale', 0.01, 0.08, 0.001, p.noiseScale, (v) => {
      c.applyAtmosphereSettings({ cloudNoiseScale: v });
    });
    this._slider('Detail (octaves)', 3, 7, 1, p.noiseOctaves, (v) => {
      c.applyAtmosphereSettings({ cloudNoiseOctaves: v });
    });
    this._slider('Jitter', 0, 0.2, 0.005, p.noiseJitter, (v) => {
      c.applyAtmosphereSettings({ cloudNoiseJitter: v });
    });
    this._slider('Seed', 0, 999, 1, p.noiseSeed, (v) => {
      c.applyAtmosphereSettings({ cloudNoiseSeed: v });
    });

    this._section('Cloud wind');
    this._slider('Speed', 0, 0.15, 0.001, p.windSpeed, (v) => {
      c.applyAtmosphereSettings({ cloudWindSpeed: v });
    });
    this._slider('Direction', 0, 360, 1, p.windDirection, (v) => {
      c.applyAtmosphereSettings({ cloudWindDirection: v });
    });

    this._section('Cloud color');
    this._checkbox('Tint from sun', p.autoTint, (on) => {
      c.applyAtmosphereSettings({ cloudAutoTint: on });
    });
    this._color('Color', p.cloudColor.getHex(), (hex) => {
      c.applyAtmosphereSettings({ cloudColor: hex, cloudAutoTint: false });
    });
  }

  _checkbox(label, checked, onChange) {
    const row = document.createElement('label');
    row.className = 'sky-check';
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
  }

  _section(text) {
    const el = document.createElement('div');
    el.className = 'sky-section';
    el.textContent = text;
    this.panel.appendChild(el);
  }

  _color(label, hex, onInput) {
    const row = document.createElement('label');
    row.className = 'sky-row';
    const head = document.createElement('div');
    head.className = 'sky-row-head';
    const cap = document.createElement('span');
    cap.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'sky-color';
    input.value = `#${hex.toString(16).padStart(6, '0')}`;
    input.addEventListener('input', () => onInput(parseInt(input.value.slice(1), 16)));
    head.append(cap);
    row.append(head, input);
    this.panel.appendChild(row);
  }

  _slider(label, min, max, step, value, onInput) {
    const row = document.createElement('label');
    row.className = 'sky-row';
    const head = document.createElement('div');
    head.className = 'sky-row-head';
    const cap = document.createElement('span');
    const val = document.createElement('b');
    const fmt = (v) => (step < 1 ? Number(v).toFixed(step < 0.01 ? 3 : 2) : String(Math.round(v)));
    cap.textContent = label;
    val.textContent = fmt(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', () => { val.textContent = fmt(input.value); onInput(parseFloat(input.value)); });
    head.append(cap, val);
    row.append(head, input);
    this.panel.appendChild(row);
    this._lastSlider = {
      set: (v) => {
        input.value = v;
        val.textContent = fmt(v);
      },
    };
  }

  // Recompute the sun direction from elevation/azimuth and update the sky.
  _updateSun() {
    const phi = THREE.MathUtils.degToRad(90 - this.elevation);
    const theta = THREE.MathUtils.degToRad(this.azimuth);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    this.u.sunPosition.value.copy(dir);
    if (this.light) this.light.position.copy(dir).multiplyScalar(this.lightDist);
    this.onSunChange?.();
  }
}