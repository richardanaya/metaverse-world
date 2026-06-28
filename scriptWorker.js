// Object scripting worker. Runs user-authored object scripts off the main thread.
// Scripts may define `function onClick(event) { mvSetColor('#ff6600'); }`.
// `export function onClick...` is also accepted for convenience.

const objects = new Map(); // objectId -> [{ name, onClick }]

function compileScript(source, name = 'script.js') {
  const code = String(source ?? '').replace(/export\s+function\s+onClick\s*\(/g, 'function onClick(');
  const factory = new Function(`
    "use strict";
    ${code}
    return { onClick: (typeof onClick === 'function' ? onClick : null) };
  //# sourceURL=${name.replace(/[^\w.-]/g, '_')}
  `);
  return factory();
}

function globalsFor(objectId, state = {}) {
  const cloneArray = (v, fallback) => Array.isArray(v) ? [...v] : [...fallback];
  const set = (command, value) => postMessage({ type: 'command', command, objectId, value });
  return {
    mvSetColor(color) {
      postMessage({ type: 'command', command: 'setColor', objectId, color });
    },
    mvGetPosition() { return cloneArray(state.position, [0, 0, 0]); },
    mvSetPosition(v) { set('setPosition', v); state.position = cloneArray(v, [0, 0, 0]); },
    mvGetScale() { return cloneArray(state.scale, [1, 1, 1]); },
    mvSetScale(v) { set('setScale', v); state.scale = cloneArray(v, [1, 1, 1]); },
    mvGetRotation() { return cloneArray(state.rotation, [0, 0, 0, 1]); },
    mvSetRotation(q) { set('setRotation', q); state.rotation = cloneArray(q, [0, 0, 0, 1]); },
    mvLog(...args) {
      postMessage({ type: 'log', objectId, args: args.map((arg) => {
        try { return typeof arg === 'string' ? arg : JSON.stringify(arg); }
        catch { return String(arg); }
      }) });
    },
  };
}

self.onmessage = (e) => {
  const msg = e.data ?? {};
  try {
    if (msg.type === 'register') {
      const compiled = [];
      for (const script of msg.scripts ?? []) {
        try {
          const mod = compileScript(script.content, script.name);
          if (mod.onClick) compiled.push({ name: script.name, onClick: mod.onClick });
        } catch (err) {
          postMessage({ type: 'error', objectId: msg.objectId, script: script.name, error: String(err?.message ?? err) });
        }
      }
      objects.set(msg.objectId, compiled);
      postMessage({ type: 'registered', objectId: msg.objectId, count: compiled.length });
      return;
    }

    if (msg.type === 'click') {
      const scripts = objects.get(msg.objectId) ?? [];
      const globals = globalsFor(msg.objectId, msg.state ?? {});
      const prevSetColor = self.mvSetColor;
      const prevLog = self.mvLog;
      const prevGetPosition = self.mvGetPosition, prevSetPosition = self.mvSetPosition;
      const prevGetScale = self.mvGetScale, prevSetScale = self.mvSetScale;
      const prevGetRotation = self.mvGetRotation, prevSetRotation = self.mvSetRotation;
      self.mvSetColor = globals.mvSetColor;
      self.mvGetPosition = globals.mvGetPosition;
      self.mvSetPosition = globals.mvSetPosition;
      self.mvGetScale = globals.mvGetScale;
      self.mvSetScale = globals.mvSetScale;
      self.mvGetRotation = globals.mvGetRotation;
      self.mvSetRotation = globals.mvSetRotation;
      self.mvLog = globals.mvLog;
      try {
        for (const script of scripts) {
          try { script.onClick(msg.event ?? {}); }
          catch (err) { postMessage({ type: 'error', objectId: msg.objectId, script: script.name, error: String(err?.message ?? err) }); }
        }
      } finally {
        self.mvSetColor = prevSetColor;
        self.mvGetPosition = prevGetPosition;
        self.mvSetPosition = prevSetPosition;
        self.mvGetScale = prevGetScale;
        self.mvSetScale = prevSetScale;
        self.mvGetRotation = prevGetRotation;
        self.mvSetRotation = prevSetRotation;
        self.mvLog = prevLog;
      }
    }
  } catch (err) {
    postMessage({ type: 'error', objectId: msg.objectId, error: String(err?.message ?? err) });
  }
};
