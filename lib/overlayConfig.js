// Single source of truth (backend) for the overlay/widget config shape.
// Mirrors the frontend src/overlay/overlayConfig.js — keep the enums in sync across both apps.
const OVERLAY_AESTHETICS = ['classic', 'pass', 'linecheck', 'docket'];
const OVERLAY_SIZES = ['board', 'compact'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
// Curated, already-loadable faces. Mirror WIDGET_FONTS in the frontend overlayConfig.js.
const WIDGET_FONTS = ['Inter', 'DM Sans', 'Chakra Petch', 'JetBrains Mono'];
const MAX_AMOUNT = 1e12;

const DEFAULT_OVERLAY_CONFIG = {
  aesthetic: 'classic', size: 'board', accent: null,
  primaryColor: null, secondaryColor: null, bgPanel: null, bgGradient: null,
  font: null, depositAccent: null, withdrawAccent: null,
  depositAmount: 0, withdrawAmount: 0,
  showFullWordLabels: false, scrollDuringOpening: false,
};

const hex = (v) => (typeof v === 'string' && HEX6.test(v)) ? v : null;
const amt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_AMOUNT) : 0; };

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
  };
}

module.exports = { DEFAULT_OVERLAY_CONFIG, OVERLAY_AESTHETICS, OVERLAY_SIZES, WIDGET_FONTS, HEX6, sanitizeOverlayConfig };
