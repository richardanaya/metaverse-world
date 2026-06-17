// Sky clouds — perspective-correct world-space sampling with volumetric lighting.
//
// Key fix: The old approach sampled a UV-mapped plane which stretches infinitely
// at the horizon (plane viewed edge-on). Now we derive UVs from world XZ coords,
// so cloud patterns stay consistent regardless of viewing angle.
//
// Techniques:
//  • World-space UV derivation → no horizon stretching
//  • Canvas texture base + procedural detail fBm → organic shapes
//  • Domain-warped noise → natural cumulus formations
//  • Beer-Lambert + Henyey-Greenstein + powder → realistic light scattering
//  • View-angle horizon fade → natural atmospheric perspective
//  • Distance detail fade → far clouds lose detail naturally
//  • 3 parallax layers at different altitudes → depth

import * as THREE from 'three';

const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying float vViewAngle;
  varying float vDistFromCamera;

  uniform vec3 uCameraPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vViewDir = normalize(worldPos.xyz - uCameraPos);
    vViewAngle = abs(vViewDir.y);
    vDistFromCamera = length(worldPos.xyz - uCameraPos);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying float vViewAngle;
  varying float vDistFromCamera;

  uniform sampler2D uCloudMap;
  uniform vec2 uOffset;
  uniform float uOpacity;
  uniform vec3 uCloudColor;
  uniform vec3 uShadowColor;
  uniform vec3 uSunDir;
  uniform float uSunElevation;
  uniform float uTime;
  uniform float uWorldScale;      // world units per UV tile
  uniform float uPowder;
  uniform float uDetailMix;
  uniform float uLayerThickness;  // fake depth for lighting (world units)

  // --- Hash & noise ---
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // fBm with domain warping for organic shapes
  float fbm(vec2 p) {
    // Domain warp for natural cumulus shapes
    vec2 q = vec2(
      vnoise(p + vec2(0.0, 0.0)),
      vnoise(p + vec2(5.2, 1.3))
    );
    p += q * 0.4;

    float v = 0.0;
    float a = 0.5;
    vec2 shift = vec2(100.0);
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.02 + shift;
      a *= 0.5;
    }
    return v;
  }

  // Curl noise for animated turbulence
  vec2 curlNoise(vec2 p) {
    float e = 0.01;
    float n1 = vnoise(p + vec2(0.0, e));
    float n2 = vnoise(p - vec2(0.0, e));
    float n3 = vnoise(p + vec2(e, 0.0));
    float n4 = vnoise(p - vec2(e, 0.0));
    return vec2((n1 - n2) / (2.0 * e), -(n3 - n4) / (2.0 * e));
  }

  float sampleDensity(vec2 worldXZ) {
    // Convert world XZ to UV (world-space sampling — no stretching!)
    vec2 worldUv = worldXZ / uWorldScale + uOffset;

    // Base cloud texture (canvas-generated tile, seamless wrap)
    float baseTex = texture(uCloudMap, worldUv).r;

    // Procedural detail via fBm (domain-warped)
    vec2 detailUv = worldUv * 2.5 + uTime * 0.003;
    float detail = fbm(detailUv);

    // Animated turbulence
    vec2 turb = curlNoise(worldUv * 3.0 + uTime * 0.01) * 0.015;
    float turbDetail = vnoise(worldUv * 4.0 + turb + uTime * 0.005);

    // Blend: base texture + procedural detail
    float density = mix(baseTex, detail, uDetailMix);
    density = mix(density, turbDetail, uDetailMix * 0.3);

    // Power curve for natural cloud shape
    density = pow(clamp(density, 0.0, 1.0), 0.75);

    return density;
  }

  // Beer-Lambert light absorption through cloud depth
  float beer(float density, float depth) {
    return exp(-density * depth);
  }

  // Powder effect: bright glow deep in clouds toward sun
  float powder(float density, float cosAngle) {
    return (1.0 - exp(-density * 2.5)) * (1.0 + max(0.0, cosAngle));
  }

  // Henyey-Greenstein phase for forward scattering (silver lining)
  float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
  }

  void main() {
    // --- Sample cloud density at this world position ---
    float density = sampleDensity(vWorldPos.xz);
    if (density < 0.015) discard;

    // --- View angle based fading (perspective-correct) ---
    // Clouds fade at the horizon due to atmospheric haze
    float horizonFade = smoothstep(0.0, 0.12, vViewAngle);
    if (horizonFade < 0.001) discard;

    // Distance fade: very far clouds become haze
    float distFade = 1.0 - smoothstep(2000.0, 4500.0, vDistFromCamera);

    // Distance-based detail loss (far clouds get simpler)
    float detailLoss = smoothstep(1500.0, 3000.0, vDistFromCamera);
    density *= mix(1.0, 0.6, detailLoss);

    // --- Lighting ---
    vec3 sunDir = normalize(uSunDir);
    float cosSun = dot(normalize(vViewDir.xz), normalize(sunDir.xz));

    // Fake depth based on viewing angle through cloud layer
    float viewDepth = uLayerThickness / max(0.1, vViewAngle);

    // Beer-Lambert: light absorbed through cloud depth
    float extinction = beer(density, viewDepth * (1.0 - cosSun * 0.4));

    // Powder: bright highlights deep in clouds toward sun
    float powderGlow = powder(density, cosSun) * uPowder;

    // Henyey-Greenstein: silver lining at cloud edges
    float phase = hgPhase(cosSun, 0.45);
    float silverLining = phase * 0.18;

    // Self-shadow: underside darker
    float sunHeight = max(0.05, sunDir.y);
    float selfShadow = mix(0.55, 1.0, cosSun * 0.5 + 0.5);
    selfShadow *= mix(0.7, 1.0, sunHeight);

    // Combined lighting
    float lighting = 0.42 + 0.58 * (1.0 - extinction);
    lighting += silverLining + powderGlow * 0.35;
    lighting = clamp(lighting, 0.0, 1.6);

    // Golden hour tint: warm colors when sun is low
    float sunElev = clamp(uSunElevation, 0.0, 1.0);
    vec3 sunsetTint = mix(
      vec3(1.0, 0.45, 0.18),   // deep sunset orange
      vec3(1.0, 0.78, 0.55),   // warm gold
      smoothstep(0.0, 0.25, sunElev)
    );
    vec3 timeTint = mix(sunsetTint, vec3(1.0), smoothstep(0.15, 0.4, sunElev));

    // Final color
    vec3 baseColor = mix(uShadowColor, uCloudColor, density);
    vec3 lit = baseColor * lighting * selfShadow * timeTint;

    // Silver lining glow on thin edges
    float edge = smoothstep(0.05, 0.2, density) * (1.0 - smoothstep(0.2, 0.5, density));
    lit += uCloudColor * edge * silverLining * 2.5;

    float alpha = density * uOpacity * horizonFade * distFade;
    gl_FragColor = vec4(lit, clamp(alpha, 0.0, 1.0));
  }
`;

// Soft cumulus-like tile: multi-pass layered blobs for organic shapes.
function createCloudTexture(size = 512, seed = 42) {
  const rng = (() => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  const drawBlobs = (count, minR, maxR, alpha) => {
    for (let i = 0; i < count; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = minR + rng() * (maxR - minR);
      const a = alpha * (0.65 + rng() * 0.35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.4, `rgba(255,255,255,${a * 0.5})`);
      g.addColorStop(0.75, `rgba(255,255,255,${a * 0.15})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Large cumulus masses
  drawBlobs(70, size * 0.08, size * 0.22, 0.25);
  ctx.filter = 'blur(12px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';

  // Medium detail
  drawBlobs(140, size * 0.03, size * 0.1, 0.18);
  ctx.filter = 'blur(5px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';

  // Fine wispy detail
  drawBlobs(200, size * 0.01, size * 0.04, 0.12);
  ctx.filter = 'blur(2px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';

  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i] / 255;
    const byte = Math.floor(Math.pow(v, 1.05) * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = byte;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Layer presets: each at a different altitude with parallax depth
const LAYER_PRESETS = [
  { altitude: 0,    opacityMul: 1.0,  speedMul: 1.0,  worldScale: 600,  detailMix: 0.4,  thickness: 30,  phase: 0 },
  { altitude: 20,   opacityMul: 0.45, speedMul: 0.55, worldScale: 800,  detailMix: 0.55, thickness: 20,  phase: 42 },
  { altitude: 45,   opacityMul: 0.18, speedMul: 0.3,  worldScale: 1100, detailMix: 0.65, thickness: 12,  phase: 85 },
];

const DEFAULTS = {
  enabled: true,
  altitude: 80,
  planeSize: 8000,
  snapGrid: 800,
  opacity: 0.85,
  windSpeed: 0.012,
  windDirection: 255,
  cloudColor: new THREE.Color(0xf6f9ff),
  shadowColor: new THREE.Color(0xa8b8cc),
  powder: 0.6,
};

function smoothstepJS(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class CloudLayer {
  constructor({ scene, camera, sky = null }) {
    this.scene = scene;
    this.camera = camera;
    this.sky = sky;
    this.params = {
      ...DEFAULTS,
      cloudColor: DEFAULTS.cloudColor.clone(),
      shadowColor: DEFAULTS.shadowColor.clone(),
    };
    this.scrolls = LAYER_PRESETS.map(() => new THREE.Vector2(0, 0));
    this.meshes = [];
    this.materials = [];
    this.texture = null;
    this._sunDir = new THREE.Vector3();
  }

  init() {
    this.texture = createCloudTexture();
    const geo = new THREE.PlaneGeometry(this.params.planeSize, this.params.planeSize, 1, 1);

    for (let i = 0; i < LAYER_PRESETS.length; i++) {
      const layer = LAYER_PRESETS[i];
      const scroll = this.scrolls[i];
      scroll.set(layer.phase * 0.01, layer.phase * 0.007);

      const material = new THREE.ShaderMaterial({
        uniforms: {
          uCloudMap: { value: this.texture },
          uOffset: { value: scroll },
          uCameraPos: { value: new THREE.Vector3() },
          uOpacity: { value: this.params.opacity * layer.opacityMul },
          uCloudColor: { value: this.params.cloudColor },
          uShadowColor: { value: this.params.shadowColor },
          uSunDir: { value: this._sunDir },
          uSunElevation: { value: 0.5 },
          uTime: { value: 0 },
          uWorldScale: { value: layer.worldScale },
          uPowder: { value: this.params.powder },
          uDetailMix: { value: layer.detailMix },
          uLayerThickness: { value: layer.thickness },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });

      const mesh = new THREE.Mesh(geo.clone(), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1 + i;
      mesh.frustumCulled = false;
      mesh.userData.layer = i;
      this.meshes.push(mesh);
      this.materials.push(material);
      this.scene.add(mesh);
    }
    this._syncVisibility();
    return this;
  }

  _syncVisibility() {
    const on = this.params.enabled;
    for (const mesh of this.meshes) mesh.visible = on;
  }

  _applyColorsToMaterials() {
    for (const mat of this.materials) {
      mat.uniforms.uCloudColor.value.copy(this.params.cloudColor);
      mat.uniforms.uShadowColor.value.copy(this.params.shadowColor);
    }
  }

  getAtmosphereSettings() {
    const p = this.params;
    return {
      cloudsEnabled: p.enabled,
      cloudOpacity: p.opacity,
      cloudAltitude: p.altitude,
      cloudWindSpeed: p.windSpeed,
      cloudWindDirection: p.windDirection,
      cloudColor: p.cloudColor.getHex(),
      cloudShadowColor: p.shadowColor.getHex(),
      cloudPowder: p.powder,
    };
  }

  applyAtmosphereSettings(data = {}) {
    const p = this.params;
    if (data.cloudsEnabled != null) p.enabled = !!data.cloudsEnabled;
    if (data.cloudOpacity != null) p.opacity = data.cloudOpacity;
    if (data.cloudAltitude != null) p.altitude = data.cloudAltitude;
    if (data.cloudWindSpeed != null) p.windSpeed = data.cloudWindSpeed;
    if (data.cloudWindDirection != null) p.windDirection = data.cloudWindDirection;
    if (data.cloudColor != null) p.cloudColor.setHex(data.cloudColor);
    if (data.cloudShadowColor != null) p.shadowColor.setHex(data.cloudShadowColor);
    if (data.cloudPowder != null) p.powder = data.cloudPowder;

    for (let i = 0; i < this.materials.length; i++) {
      const mat = this.materials[i];
      const layer = LAYER_PRESETS[i];
      mat.uniforms.uOpacity.value = p.opacity * layer.opacityMul;
      mat.uniforms.uPowder.value = p.powder;
    }
    this._applyColorsToMaterials();
    this._syncVisibility();
  }

  update(dt) {
    if (!this.meshes.length || !this.params.enabled) return;

    const p = this.params;
    const cam = this.camera.position;
    const snap = p.snapGrid;
    const baseX = Math.floor(cam.x / snap) * snap;
    const baseZ = Math.floor(cam.z / snap) * snap;
    const wind = p.windDirection * Math.PI / 180;

    for (let i = 0; i < this.meshes.length; i++) {
      const layer = LAYER_PRESETS[i];
      const mesh = this.meshes[i];
      const scroll = this.scrolls[i];

      // Position plane centered near camera at the layer's altitude
      mesh.position.set(baseX, p.altitude + layer.altitude, baseZ);

      // Wind scroll (world-space UV offset)
      const speed = p.windSpeed * layer.speedMul;
      scroll.x += Math.cos(wind) * speed * dt;
      scroll.y += Math.sin(wind) * speed * dt;

      const mat = this.materials[i];
      mat.uniforms.uCameraPos.value.set(cam.x, cam.y, cam.z);
      mat.uniforms.uTime.value += dt;
    }

    if (this.sky) {
      const sun = this.sky.material.uniforms.sunPosition.value;
      this._sunDir.copy(sun);
      const sunElev = THREE.MathUtils.clamp(sun.y, 0.0, 1.0);

      for (const mat of this.materials) {
        mat.uniforms.uSunDir.value.copy(this._sunDir);
        mat.uniforms.uSunElevation.value = sunElev;
      }

      // Dynamic color: sunrise/sunset warmth, midday brightness
      const warmPhase = smoothstepJS(0.0, 0.35, sunElev);
      p.cloudColor.setRGB(
        0.82 + warmPhase * 0.18,
        0.85 + warmPhase * 0.12,
        0.92 + warmPhase * 0.08,
      );
      p.shadowColor.setRGB(
        0.55 + warmPhase * 0.18,
        0.6 + warmPhase * 0.15,
        0.75 + warmPhase * 0.1,
      );
      this._applyColorsToMaterials();
    }
  }

  dispose() {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.texture?.dispose?.();
    for (const mat of this.materials) mat.dispose();
    this.meshes = [];
    this.materials = [];
  }
}
