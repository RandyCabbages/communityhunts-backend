// Single source of truth (backend) for the overlay/widget config shape.
// Mirrors the frontend src/overlay/overlayConfig.js — keep the enums in sync across both apps.
const OVERLAY_AESTHETICS = ['classic', 'pass', 'linecheck', 'docket'];
const OVERLAY_SIZES = ['board', 'compact'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
// Curated, already-loadable faces. Mirror WIDGET_FONTS in the frontend overlayConfig.js.
const WIDGET_FONTS = ['Inter', 'DM Sans', 'Chakra Petch', 'JetBrains Mono'];
// Widget background system (atomic stream widgets). Mirror widgetBackground.js on the frontend.
const WIDGET_FILLS = ['gradient', 'solid', 'glass', 'none'];
const WIDGET_PATTERNS = ['none', 'dots', 'grid', 'diagonal', 'glow', 'sheen', 'noise', 'hatch', 'scanlines', 'carbon'];
const MAX_AMOUNT = 1e12;

const DEFAULT_OVERLAY_CONFIG = {
  aesthetic: 'classic', size: 'board', accent: null,
  primaryColor: null, secondaryColor: null, bgPanel: null, bgGradient: null,
  font: null, depositAccent: null, withdrawAccent: null,
  depositAmount: 0, withdrawAmount: 0,
  showFullWordLabels: false, scrollDuringOpening: false,
  panelOpacity: 1, winHighlight: null, hideSlotCount: false, hideMultiplier: false,
  widgetFill: 'gradient', widgetPattern: 'none',
};

const hex = (v) => (typeof v === 'string' && HEX6.test(v)) ? v : null;
const amt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_AMOUNT) : 0; };
const unit01 = (v, dflt = 1) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : dflt; };

function sanitizeOverlayConfig(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return {
    aesthetic: OVERLAY_AESTHETICS.includes(r.aesthetic) ? r.aesthetic : 'classic',
    size:      OVERLAY_SIZES.includes(r.size) ? r.size : 'board',
    accent:    hex(r.accent),
    primaryColor: hex(r.primaryColor), secondaryColor: hex(r.secondaryColor),
    bgPanel: hex(r.bgPanel), bgGradient: hex(r.bgGradient),
    depositAccent: hex(r.depositAccent), withdrawAccent: hex(r.withdrawAccent),
    font: WIDGET_FONTS.includes(r.font) ? r.font : null,
    depositAmount: amt(r.depositAmount), withdrawAmount: amt(r.withdrawAmount),
    showFullWordLabels: Boolean(r.showFullWordLabels), scrollDuringOpening: Boolean(r.scrollDuringOpening),
    panelOpacity: unit01(r.panelOpacity), winHighlight: hex(r.winHighlight),
    hideSlotCount: Boolean(r.hideSlotCount), hideMultiplier: Boolean(r.hideMultiplier),
    widgetFill: WIDGET_FILLS.includes(r.widgetFill) ? r.widgetFill : 'gradient',
    widgetPattern: WIDGET_PATTERNS.includes(r.widgetPattern) ? r.widgetPattern : 'none',
  };
}

// Persist a sanitized overlayConfig under an arbitrary settings key (a user id OR a shared-hunt
// key like modHuntKey/affiliateHuntKey). Keeps the mod/affiliate save routes thin and testable;
// mirrors what PUT /api/settings does for a personal overlay. Returns the sanitized config so the
// caller can broadcast the live-restyle.
async function persistOverlayConfig(getSettings, saveSettings, key, raw) {
  const current = await getSettings(key);
  current.overlayConfig = sanitizeOverlayConfig(raw);
  await saveSettings(key, current);
  return current.overlayConfig;
}

module.exports = { DEFAULT_OVERLAY_CONFIG, OVERLAY_AESTHETICS, OVERLAY_SIZES, WIDGET_FONTS, WIDGET_FILLS, WIDGET_PATTERNS, HEX6, sanitizeOverlayConfig, persistOverlayConfig };
