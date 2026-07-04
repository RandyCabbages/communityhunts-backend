// Single source of truth (backend) for the overlay/widget config shape.
// Mirrors the frontend src/overlay/overlayConfig.js — keep the enums in sync across both apps.
const OVERLAY_AESTHETICS = ['classic', 'pass', 'linecheck', 'docket'];
const OVERLAY_SIZES = ['board', 'compact'];
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_OVERLAY_CONFIG = { aesthetic: 'classic', size: 'board', accent: null };

function sanitizeOverlayConfig(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return {
    aesthetic: OVERLAY_AESTHETICS.includes(r.aesthetic) ? r.aesthetic : 'classic',
    size:      OVERLAY_SIZES.includes(r.size) ? r.size : 'board',
    accent:    (typeof r.accent === 'string' && HEX6.test(r.accent)) ? r.accent : null,
  };
}

module.exports = { DEFAULT_OVERLAY_CONFIG, OVERLAY_AESTHETICS, OVERLAY_SIZES, HEX6, sanitizeOverlayConfig };
