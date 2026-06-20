// MultiplayerManager — WebRTC P2P sessions over copy-paste connection strings.
//
// Host generates an invite string (SDP offer + id). A guest pastes it, gets an
// answer string to send back. The host pastes the answer to finish the handshake.
// No signaling server — Google's public STUN servers help peers find each other.
//
// Topology: star. Guests connect only to the host, who relays remote state so
// everyone sees everyone else. Player pose + locomotion clip are synced at ~20 Hz.

import * as THREE from 'three';
import { Avatar, initGltfAnim, getGltfClip } from 'metaverse-avatar';
import { resolveAgentName } from './agentName.js';
import { showPanel, hidePanel } from './panelFade.js';

const CONNECTION_PREFIX = 'mv1:';
const SYNC_INTERVAL = 1 / 20;
const LOCO_GLB = 'https://cdn.jsdelivr.net/npm/metaverse-avatar@0.1.2/anims/UAL1_Standard.glb';
const LOCO_ANIMS = {
  walk: 'Walk_Loop',
  run: 'Jog_Fwd_Loop',
  stand: 'Idle_Loop',
  jump: 'Jump_Start',
  hover: 'Swim_Idle_Loop',
  crouchIdle: 'Crouch_Idle_Loop',
  crouchWalk: 'Crouch_Fwd_Loop',
};

// Google's public STUN fleet (no auth). Google does not operate a free public
// TURN relay; STUN is enough for most LAN / home-NAT setups.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

function encodeSignal(obj) {
  return CONNECTION_PREFIX + btoa(JSON.stringify(obj));
}

function decodeSignal(str) {
  const trimmed = str.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  if (!trimmed.startsWith(CONNECTION_PREFIX)) {
    throw new Error('Invalid string — paste the full mv1:… code from the host');
  }
  return JSON.parse(atob(trimmed.slice(CONNECTION_PREFIX.length)));
}

function waitForIce(pc, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }

    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };

    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (e) => {
      if (!e.candidate) finish();
    };

    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export class MultiplayerManager {
  constructor({ scene, player, modelsUrl, onStatus }) {
    this.scene = scene;
    this.player = player;
    this.modelsUrl = modelsUrl;
    this.onStatus = onStatus ?? (() => {});

    this.localId = crypto.randomUUID();
    this.localName = '';
    this.isHost = false;
    this.peers = new Map();         // peerId -> { pc, dc, name, playerId, isPending }
    this.remotes = new Map();       // playerId -> { avatar, clips, pos, yaw, anim, name }
    this.pendingOffers = new Map(); // offerId -> { pc, peerId }
    this._syncAcc = 0;
    this._clips = null;
    this._clipsReady = false;
    this._open = false;

    this._buildPanel();
  }

  setLocalName(name) { this.localName = resolveAgentName(name); }

  open() { this._open = true; showPanel(this.panel); }
  close() { this._open = false; hidePanel(this.panel); }
  isOpen() { return this._open; }
  toggle() { this._open ? this.close() : this.open(); }

  get connectedCount() { return this.peers.size; }

  // ---- signaling (copy-paste) -------------------------------------------

  async createHostOffer() {
    this.isHost = true;
    const offerId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('metaverse', { ordered: true });

    this.pendingOffers.set(offerId, { pc, peerId });
    this._registerPeer(peerId, pc, dc, { isPending: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    this._setStatus('Invite ready — send the string to a guest');
    return encodeSignal({ type: 'offer', id: offerId, sdp: pc.localDescription.sdp });
  }

  async joinWithOffer(encoded) {
    const signal = decodeSignal(encoded);
    if (signal.type !== 'offer') throw new Error('Expected a host invite (offer)');

    this.isHost = false;
    const peerId = crypto.randomUUID();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.ondatachannel = (e) => {
      if (!this.peers.has(peerId)) this._registerPeer(peerId, pc, e.channel);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    this._setStatus('Answer ready — copy it and send back to the host');
    return encodeSignal({ type: 'answer', offerId: signal.id, sdp: pc.localDescription.sdp });
  }

  async acceptAnswer(encoded) {
    if (!this.isHost) throw new Error('Only the host can accept an answer');
    const signal = decodeSignal(encoded);
    if (signal.type !== 'answer') throw new Error('Expected an answer from a guest');

    const pending = this.pendingOffers.get(signal.offerId);
    if (!pending) throw new Error('Unknown invite — generate a new one or check the string');

    await pending.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    this.pendingOffers.delete(signal.offerId);

    const peer = this.peers.get(pending.peerId);
    if (peer) {
      peer.isPending = false;
      if (peer.dc?.readyState === 'open') this._onChannelOpen(peer);
    }

    this._setStatus(`${this._activePeerCount()} peer${this._activePeerCount() === 1 ? '' : 's'} connected`);
  }

  disconnect() {
    for (const [, peer] of this.peers) this._teardownPeer(peer);
    for (const [, remote] of this.remotes) this._teardownRemote(remote);
    this.peers.clear();
    this.remotes.clear();
    this.pendingOffers.clear();
    this.isHost = false;
    this._syncAcc = 0;
    this._setStatus('Disconnected');
    this._updatePeerList();
    this.onStatus('offline', 0);
  }

  // ---- per-frame sync + remote interpolation ----------------------------

  update(dt) {
    this._syncAcc += dt;
    if (this._syncAcc < SYNC_INTERVAL) return;
    this._syncAcc = 0;

    const state = this.player.getNetworkState();
    const msg = JSON.stringify({
      t: 'state',
      id: this.localId,
      name: this.localName,
      ...state,
    });
    this._broadcast(msg);
  }

  tickRemotes(dt) {
    for (const [, r] of this.remotes) {
      if (!r.avatar) continue;
      const k = 1 - Math.exp(-14 * dt);
      r.avatar.group.position.lerp(r.pos, k);
      r.avatar.group.rotation.y = lerpAngle(r.avatar.group.rotation.y, r.yaw, k);
      r.avatar.update(dt);
    }
  }

  // ---- internals --------------------------------------------------------

  async _ensureClips(avatar) {
    if (this._clipsReady) return this._clips;
    await initGltfAnim(LOCO_GLB, avatar);
    this._clips = {};
    for (const [key, name] of Object.entries(LOCO_ANIMS)) {
      const clip = getGltfClip(LOCO_GLB, name);
      if (clip) this._clips[key] = clip;
    }
    this._clipsReady = true;
    return this._clips;
  }

  async _spawnRemote(playerId, name) {
    if (this.remotes.has(playerId)) return this.remotes.get(playerId);

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

    const clips = await this._ensureClips(avatar);
    avatar.crossFadeTo(clips.stand, 0, true);

    const remote = {
      avatar,
      clips,
      anim: 'stand',
      pos: new THREE.Vector3(),
      yaw: 0,
      name: name || 'Guest',
    };
    this.remotes.set(playerId, remote);
    return remote;
  }

  _teardownRemote(remote) {
    if (remote?.avatar) {
      this.scene.remove(remote.avatar.group);
      remote.avatar.stop?.();
    }
  }

  _registerPeer(peerId, pc, dc, opts = {}) {
    const peer = {
      pc,
      dc,
      peerId,
      name: 'Guest',
      playerId: null,
      isPending: !!opts.isPending,
    };
    this.peers.set(peerId, peer);

    dc.onopen = () => this._onChannelOpen(peer);
    dc.onmessage = (e) => this._onMessage(peer, e.data);
    dc.onclose = () => this._onPeerDisconnect(peerId);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._onPeerDisconnect(peerId);
      }
    };
  }

  _onChannelOpen(peer) {
    if (peer.isPending) return;
    peer.dc.send(JSON.stringify({ t: 'hello', id: this.localId, name: this.localName }));
    this._setStatus(`${this._activePeerCount()} peer${this._activePeerCount() === 1 ? '' : 's'} connected`);
    this._updatePeerList();
    this.onStatus(this.isHost ? 'host' : 'guest', this._activePeerCount());
  }

  async _onMessage(fromPeer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'hello') {
      fromPeer.name = resolveAgentName(msg.name);
      fromPeer.playerId = msg.id;
      await this._spawnRemote(msg.id, fromPeer.name);
      this._updatePeerList();
      return;
    }

    if (msg.t === 'state') {
      if (msg.id === this.localId) return;

      const r = await this._spawnRemote(msg.id, msg.name);
      r.pos.set(msg.x, msg.y, msg.z);
      r.yaw = msg.yaw;
      if (msg.name) r.name = msg.name;
      if (msg.anim && msg.anim !== r.anim) {
        r.anim = msg.anim;
        const clip = r.clips[msg.anim] ?? r.clips.stand;
        if (clip) r.avatar.crossFadeTo(clip, 0.2, true);
      }
      if (msg.speed != null) r.avatar.setSpeed(msg.speed);

      // Host relays every guest's state to the rest of the room.
      if (this.isHost) this._broadcast(raw, fromPeer.peerId);
      return;
    }
  }

  _activePeerCount() {
    let n = 0;
    for (const [, peer] of this.peers) if (!peer.isPending) n++;
    return n;
  }

  _broadcast(raw, exceptPeerId = null) {
    for (const [id, peer] of this.peers) {
      if (id === exceptPeerId) continue;
      if (peer.dc?.readyState === 'open') peer.dc.send(raw);
    }
  }

  _onPeerDisconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this._teardownPeer(peer);
    this.peers.delete(peerId);
    for (const [offerId, pending] of this.pendingOffers) {
      if (pending.peerId === peerId) this.pendingOffers.delete(offerId);
    }
    const n = this._activePeerCount();
    this._setStatus(n ? `${n} peer(s) connected` : 'Disconnected');
    this._updatePeerList();
    this.onStatus(n ? (this.isHost ? 'host' : 'guest') : 'offline', n);
  }

  _teardownPeer(peer) {
    try { peer.dc?.close(); } catch { /* noop */ }
    try { peer.pc?.close(); } catch { /* noop */ }
    if (peer.playerId) {
      const remote = this.remotes.get(peer.playerId);
      if (remote) {
        this._teardownRemote(remote);
        this.remotes.delete(peer.playerId);
      }
    }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _updatePeerList() {
    if (!this._peerList) return;
    const lines = [];
    for (const [, peer] of this.peers) {
      if (peer.isPending) lines.push('… awaiting answer');
      else if (peer.name) lines.push(peer.name);
    }
    for (const [, remote] of this.remotes) {
      if (!lines.includes(remote.name)) lines.push(remote.name);
    }
    this._peerList.textContent = lines.length ? lines.join(' · ') : 'No peers';
  }

  // ---- UI ---------------------------------------------------------------

  _buildPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'connect-panel';
    this.panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'connect-panel-title';
    title.textContent = 'Connect';
    this.panel.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'connect-hint';
    hint.innerHTML = 'Two-step handshake over WebRTC (Google STUN). The guest always gets an <b>answer string</b> to send back — the link is not live until the host accepts it.';
    this.panel.appendChild(hint);

    const modes = document.createElement('div');
    modes.className = 'connect-modes seg';
    const hostBtn = document.createElement('button');
    hostBtn.textContent = 'Host';
    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    modes.append(hostBtn, joinBtn);
    this.panel.appendChild(modes);

    const hostPane = document.createElement('div');
    hostPane.className = 'connect-pane';
    const joinPane = document.createElement('div');
    joinPane.className = 'connect-pane';
    joinPane.style.display = 'none';

    const mkArea = (label, readOnly = false) => {
      const wrap = document.createElement('label');
      wrap.className = 'connect-field';
      const cap = document.createElement('span');
      cap.textContent = label;
      const ta = document.createElement('textarea');
      ta.rows = 4;
      ta.spellcheck = false;
      if (readOnly) ta.readOnly = true;
      wrap.append(cap, ta);
      return { wrap, ta };
    };

    const invite = mkArea('Invite string');
    const answerIn = mkArea('Guest answer');
    const offerIn = mkArea('1 · Paste host invite');
    const answerOut = mkArea('2 · Your answer (send to host)', true);

    const mkBtn = (text, primary = false) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (primary) b.className = 'connect-primary';
      return b;
    };

    const genInvite = mkBtn('Generate invite', true);
    const copyInvite = mkBtn('Copy invite');
    const acceptAnswer = mkBtn('Accept answer', true);
    const connectBtn = mkBtn('Connect', true);
    const copyAnswer = mkBtn('Copy answer');
    const disconnectBtn = mkBtn('Disconnect');
    disconnectBtn.className = 'danger';

    hostPane.append(
      genInvite, invite.wrap, copyInvite,
      answerIn.wrap, acceptAnswer,
    );
    joinPane.append(offerIn.wrap, connectBtn, answerOut.wrap, copyAnswer);

    this._statusEl = document.createElement('div');
    this._statusEl.className = 'connect-status';
    this._statusEl.textContent = 'Offline';

    this._peerList = document.createElement('div');
    this._peerList.className = 'connect-peers';
    this._peerList.textContent = 'No peers';

    this.panel.append(hostPane, joinPane, this._statusEl, this._peerList, disconnectBtn);

    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'connect-done';
    done.addEventListener('click', () => this.close());
    this.panel.appendChild(done);

    document.body.appendChild(this.panel);

    const setMode = (mode) => {
      const host = mode === 'host';
      hostBtn.classList.toggle('active', host);
      joinBtn.classList.toggle('active', !host);
      hostPane.style.display = host ? 'flex' : 'none';
      joinPane.style.display = host ? 'none' : 'flex';
    };
    hostBtn.addEventListener('click', () => setMode('host'));
    joinBtn.addEventListener('click', () => setMode('join'));
    setMode('host');

    const routePastedCode = (text) => {
      const raw = text.trim().replace(/\s+/g, '');
      if (!raw.startsWith(CONNECTION_PREFIX)) return;
      try {
        const signal = decodeSignal(raw);
        if (signal.type === 'offer') {
          setMode('join');
          offerIn.ta.value = raw;
          this._setStatus('Invite detected — click Connect');
          return;
        }
        if (signal.type === 'answer') {
          setMode('host');
          answerIn.ta.value = raw;
          this._setStatus('Answer detected — click Accept answer');
        }
      } catch { /* not our format yet */ }
    };

    for (const ta of [invite.ta, answerIn.ta, offerIn.ta, answerOut.ta]) {
      ta.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text');
        if (text) setTimeout(() => routePastedCode(text), 0);
      });
    }

    const runAsync = async (btn, busy, work) => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = busy;
      try {
        await work();
      } catch (err) {
        console.error('[connect]', err);
        this._setStatus(err?.message || 'Connection failed');
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    };

    genInvite.addEventListener('click', () => runAsync(genInvite, 'Generating…', async () => {
      this._setStatus('Gathering network route…');
      invite.ta.value = await this.createHostOffer();
      answerIn.ta.value = '';
      invite.ta.classList.add('connect-ready');
      invite.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this._updatePeerList();
    }));

    copyInvite.addEventListener('click', async () => {
      if (!invite.ta.value) return;
      await navigator.clipboard.writeText(invite.ta.value);
      this._setStatus('Invite copied');
    });

    acceptAnswer.addEventListener('click', () => runAsync(acceptAnswer, 'Linking…', async () => {
      const raw = answerIn.ta.value.trim();
      if (!raw) throw new Error('Paste the guest answer first');
      this._setStatus('Finishing handshake…');
      await this.acceptAnswer(raw);
      answerIn.ta.value = '';
      this._updatePeerList();
    }));

    connectBtn.addEventListener('click', () => runAsync(connectBtn, 'Connecting…', async () => {
      const raw = offerIn.ta.value.trim();
      if (!raw) throw new Error('Paste the host invite first');
      this._setStatus('Building answer (step 1 of 2)…');
      answerOut.ta.value = await this.joinWithOffer(raw);
      answerOut.ta.classList.add('connect-ready');
      answerOut.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this.onStatus('connecting', 0);
    }));

    copyAnswer.addEventListener('click', async () => {
      if (!answerOut.ta.value) return;
      await navigator.clipboard.writeText(answerOut.ta.value);
      this._setStatus('Answer copied');
    });

    disconnectBtn.addEventListener('click', () => this.disconnect());
  }
}