// SkyEditor — a floating sidebar to tweak the Preetham Sky, opened from the
// right-click menu ("Edit sky…") when you right-click empty sky.
//
// Controls the sun direction (elevation / azimuth — which also moves the scene's
// directional light so lighting and sky stay in sync), the atmospheric scattering
// uniforms (turbidity / rayleigh / mie / mie-G), renderer exposure, and the
// Minecraft-style cloud layer (opacity, altitude, wind).

import * as THREE from 'three';

export class SkyEditor {
  constructor({ sky, light, renderer, clouds = null }) {
    this.sky = sky;
    this.u = sky.material.uniforms;
    this.light = light;
    this.renderer = renderer;
    this.clouds = clouds;
    this.active = false;

    // Derive the starting sun elevation/azimuth from the sky's current sun dir.
    const d = this.u.sunPosition.value;
    this.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)));
    this.azimuth = THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z));
    this.lightDist = light.position.length() || 220; // keep the light's distance

    this._build();
  }

  open() { this.active = true; this.panel.style.display = 'flex'; }
  close() { this.active = false; this.panel.style.display = 'none'; }

  _build() {
    this.panel = document.createElement('div');
    this.panel.className = 'sky-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'sky-panel-title';
    title.textContent = 'Sky';
    this.panel.appendChild(title);

    this._section('Sun');
    this._slider('Elevation', 0, 90, 0.5, this.elevation, (v) => { this.elevation = v; this._updateSun(); });
    this._slider('Azimuth', -180, 180, 1, this.azimuth, (v) => { this.azimuth = v; this._updateSun(); });

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
    const p = this.clouds.params;
    this._section('Clouds');
    this._checkbox('Enabled', p.enabled, (on) => {
      this.clouds.applyAtmosphereSettings({ cloudsEnabled: on });
    });
    this._slider('Opacity', 0, 1, 0.01, p.opacity, (v) => {
      this.clouds.applyAtmosphereSettings({ cloudOpacity: v });
    });
    this._slider('Altitude (m)', 55, 140, 1, p.altitude, (v) => {
      this.clouds.applyAtmosphereSettings({ cloudAltitude: v });
    });
    this._slider('Wind speed', 0, 0.04, 0.001, p.windSpeed, (v) => {
      this.clouds.applyAtmosphereSettings({ cloudWindSpeed: v });
    });
    this._slider('Wind direction', 0, 360, 1, p.windDirection, (v) => {
      this.clouds.applyAtmosphereSettings({ cloudWindDirection: v });
    });
    this._slider('Tiling', 3, 10, 0.5, p.tile, (v) => {
      this.clouds.applyAtmosphereSettings({ cloudTile: v });
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
  }

  // Recompute the sun direction from elevation/azimuth, and aim both the sky and
  // the scene's directional light at it.
  _updateSun() {
    const phi = THREE.MathUtils.degToRad(90 - this.elevation);
    const theta = THREE.MathUtils.degToRad(this.azimuth);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    this.u.sunPosition.value.copy(dir);
    this.light.position.copy(dir).multiplyScalar(this.lightDist);
  }
}