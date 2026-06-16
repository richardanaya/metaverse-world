// Agent display names — from login, or avatar-<shortid> when blank.

export function shortId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export function resolveAgentName(input) {
  const trimmed = (input ?? '').trim();
  return trimmed || `avatar-${shortId()}`;
}

export function avatarEntityKey(name) {
  return `avatar:${name}`;
}

export function parseAvatarEntityKey(key) {
  return key.startsWith('avatar:') ? key.slice(7) : null;
}