// SkyEditor — a floating sidebar to tweak the Preetham Sky, opened from the
// right-click menu ("Edit sky…") when you right-click empty sky.
//
// Controls the sun direction (elevation / azimuth), the atmospheric scattering
// uniforms (turbidity / rayleigh / mie / mie-G), renderer exposure, and the
// Minecraft-style cloud layer (shape, noise, wind, color).

import * as THREE from 'three';
import { DEFAULT_CLOUD_SETTINGS } from 'metaverse-sky';
import { showPanel, hidePanel } from './panelFade.js';

const PHASE_NAMES = [
  'New', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent', 'New',
];
function phaseLabel(phase) {
  const i = Math.round(phase * 8);
  return PHASE_NAMES[Math.max(0, Math.min(8, i))];
}

export class SkyEditor {
  constructor({
    sky,
    light = null,
    renderer,
    clouds = null,
    precipitation = null,
    celestialBodies = null,
    onSunChange = null,
    onWindChange = null,
    envIntensityMin = 1.0,
    envIntensityMax = 2.0,
  }) {
    this.sky = sky;
    this.u = sky.material.uniforms;
    this.light = light;
    this.renderer = renderer;
    this.clouds = clouds;
    this.precipitation = precipitation;
    this.celestialBodies = celestialBodies;
    this.onSunChange = onSunChange;
    this.onWindChange = onWindChange;
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
    if (this.precipitation) this._buildPrecipitationSection();
    if (this.celestialBodies) this._buildCelestialSection();

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
    this._checkbox('High quality', p.quality > 0, (on) => {
      c.applyAtmosphereSettings({ cloudQuality: on ? 1 : 0 });
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
    this._slider('Edge softness', 0, 1, 0.01, p.softness, (v) => {
      c.applyAtmosphereSettings({ cloudSoftness: v });
    });
    this._slider('Darkness', 0, 1, 0.01, p.darkness, (v) => {
      c.applyAtmosphereSettings({ cloudDarkness: v });
    }, (v) => (v < 0.2 ? 'Bright' : v < 0.45 ? 'Cloudy' : v < 0.7 ? 'Overcast' : 'Storm'));

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

    const seedActions = document.createElement('div');
    seedActions.className = 'seg';
    const randomize = document.createElement('button');
    randomize.type = 'button';
    randomize.textContent = 'Randomize seed';
    randomize.addEventListener('click', () => {
      const seed = Math.floor(Math.random() * 1000);
      c.applyAtmosphereSettings({ cloudNoiseSeed: seed });
      this._cloudSeedSlider?.set(seed);
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset clouds';
    reset.addEventListener('click', () => this._resetClouds());
    seedActions.append(randomize, reset);
    this.panel.appendChild(seedActions);

    this._section('Cloud wind');
    this._slider('Speed', 0, 0.15, 0.001, p.windSpeed, (v) => {
      c.applyAtmosphereSettings({ cloudWindSpeed: v });
      this.onWindChange?.({ speed: v, directionDeg: p.windDirection });
    });
    this._slider('Direction', 0, 360, 1, p.windDirection, (v) => {
      c.applyAtmosphereSettings({ cloudWindDirection: v });
      this.onWindChange?.({ speed: p.windSpeed, directionDeg: v });
    });

    this._section('Cloud color');
    this._checkbox('Tint from sun', p.autoTint, (on) => {
      c.applyAtmosphereSettings({ cloudAutoTint: on });
    });
    this._color('Color', p.cloudColor.getHex(), (hex) => {
      c.applyAtmosphereSettings({ cloudColor: hex, cloudAutoTint: false });
    });
  }

  _buildPrecipitationSection() {
    const p = this.precipitation.params;
    this._section('Precipitation');
    const buttons = document.createElement('div');
    buttons.className = 'seg';
    for (const type of ['none', 'rain', 'snow', 'hail']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      b.classList.toggle('active', p.type === type);
      b.addEventListener('click', () => {
        this.precipitation.setPrecipitation({ type });
        for (const el of buttons.children) el.classList.toggle('active', el === b);
      });
      buttons.appendChild(b);
    }
    this.panel.appendChild(buttons);
    this._slider('Intensity', 0, 3, 0.01, p.intensity, (v) => {
      this.precipitation.setPrecipitation({ intensity: v });
    });
    this._slider('Fall speed', 0.1, 3, 0.05, p.speed, (v) => {
      this.precipitation.setPrecipitation({ speed: v });
    }, (v) => `${Number(v).toFixed(1)}×`);
    this._slider('Size', 0.2, 3, 0.05, p.size, (v) => {
      this.precipitation.setPrecipitation({ size: v });
    }, (v) => `${Number(v).toFixed(1)}×`);
    this._slider('Wind drift', 0, 2, 0.05, p.windDrift, (v) => {
      this.precipitation.setPrecipitation({ windDrift: v });
    }, (v) => `${Number(v).toFixed(1)}×`);
  }

  _buildCelestialSection() {
    const bodies = this.celestialBodies;
    const s = bodies.settings;
    this._section('Celestial');
    this._checkbox('Show bodies', s.visible, (on) => bodies.setVisible(on));
    this._slider('Moon phase', 0, 1, 0.01, s.moonPhase, (v) => {
      bodies.setMoonPhase(v);
    }, (v) => phaseLabel(v));
    this._slider('Moon elevation', -10, 80, 1, s.moonElevation, (v) => {
      bodies.setMoon({ moonElevation: v });
    }, (v) => `${Math.round(v)}°`);
    this._slider('Moon azimuth', -180, 180, 1, s.moonAzimuth, (v) => {
      bodies.setMoon({ moonAzimuth: v });
    }, (v) => `${Math.round(v)}°`);
    this._slider('Moon size', 6, 160, 0.5, s.moonSize, (v) => {
      bodies.setMoon({ moonSize: v });
    });
    this._slider('Moon glow', 0, 1, 0.01, s.moonGlow, (v) => {
      bodies.setMoon({ moonGlow: v });
    }, (v) => `${Math.round(v * 100)}%`);
    this._slider('Moon horizon boost', 0, 1, 0.01, s.moonHorizonBoost, (v) => {
      bodies.setMoon({ moonHorizonBoost: v });
    }, (v) => `${Math.round(v * 100)}%`);
    this._slider('Sun elevation', -10, 90, 1, s.sunElevation, (v) => {
      bodies.setSun({ sunElevation: v });
    }, (v) => `${Math.round(v)}°`);
    this._slider('Sun azimuth', -180, 180, 1, s.sunAzimuth, (v) => {
      bodies.setSun({ sunAzimuth: v });
    }, (v) => `${Math.round(v)}°`);
    this._checkbox('Show planets', s.planetsVisible, (on) => bodies.setPlanets({ planetsVisible: on }));
    this._slider('Planet scale', 0.25, 3, 0.05, s.planetScale, (v) => {
      bodies.setPlanets({ planetScale: v });
    });
    this._slider('Planet glow', 0, 2, 0.01, s.planetGlow, (v) => {
      bodies.setPlanets({ planetGlow: v });
    }, (v) => `${Math.round(v * 100)}%`);
    this._checkbox('Show stars', s.starsVisible, (on) => bodies.setStars({ starsVisible: on }));
    this._slider('Star opacity', 0, 1, 0.01, s.starOpacity, (v) => {
      bodies.setStars({ starOpacity: v });
    }, (v) => `${Math.round(v * 100)}%`);
    this._slider('Star size', 0.25, 3, 0.05, s.starSize, (v) => {
      bodies.setStars({ starSize: v });
    });
  }

  _resetClouds() {
    if (!this.clouds) return;
    const d = DEFAULT_CLOUD_SETTINGS;
    this.clouds.applyAtmosphereSettings({
      ...d,
      cloudColor: d.cloudColor,
      cloudsEnabled: this.clouds.params.enabled,
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

  _slider(label, min, max, step, value, onInput, format = null) {
    const row = document.createElement('label');
    row.className = 'sky-row';
    const head = document.createElement('div');
    head.className = 'sky-row-head';
    const cap = document.createElement('span');
    const val = document.createElement('b');
    const fmt = format ?? ((v) => (step < 1 ? Number(v).toFixed(step < 0.01 ? 3 : 2) : String(Math.round(v))));
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
    if (label === 'Seed') this._cloudSeedSlider = this._lastSlider;
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
