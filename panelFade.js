// Shared fade in/out for overlay panels (connect, import/export, editors, menus).

const FADE_MS = 280;

function cancelShow(panel) {
  if (!panel._fadeRaf) return;
  cancelAnimationFrame(panel._fadeRaf);
  panel._fadeRaf = 0;
}

function clearInlineFade(panel) {
  panel.style.transition = '';
  panel.style.opacity = '';
}

export function showPanel(panel, { display = 'flex' } = {}) {
  if (!panel) return;
  clearTimeout(panel._fadeTimer);
  clearTimeout(panel._fadeInTimer);
  cancelShow(panel);
  panel.dataset.open = '1';
  panel.classList.remove('is-hiding');
  panel.classList.add('is-visible');
  panel.style.display = display;
  panel.style.transition = 'none';
  panel.style.opacity = '0';
  void panel.offsetHeight;
  panel.style.transition = `opacity ${FADE_MS}ms ease`;
  panel.style.opacity = '1';
  panel._fadeInTimer = setTimeout(() => {
    clearInlineFade(panel);
    panel._fadeInTimer = null;
  }, FADE_MS + 30);
}

export function hidePanel(panel) {
  if (!panel) return;
  cancelShow(panel);
  clearTimeout(panel._fadeTimer);
  clearTimeout(panel._fadeInTimer);
  delete panel.dataset.open;
  if (panel.style.display === 'none') {
    panel.classList.remove('is-visible', 'is-hiding');
    clearInlineFade(panel);
    return;
  }
  panel.classList.remove('is-visible');
  panel.style.transition = `opacity ${FADE_MS}ms ease`;
  panel.style.opacity = '0';
  panel._fadeTimer = setTimeout(() => {
    panel.style.display = 'none';
    clearInlineFade(panel);
    panel.classList.remove('is-hiding');
    panel._fadeTimer = null;
  }, FADE_MS + 30);
}

export function isPanelOpen(panel) {
  return panel?.dataset.open === '1' || panel?.classList.contains('is-visible');
}