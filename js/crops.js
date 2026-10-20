// Crop data lives in crops-data.js (see the notes there).
import './crops-data.js';

export const CROPS = globalThis.GARDEN_CROPS;

export const UNITS = ['count', 'oz', 'lb', 'bunch'];
export const METHODS = { seed: 'Direct seeded', transplant: 'Transplant', clove: 'Clove / bulb' };

export function crop(key) {
  return CROPS[key] || CROPS.other;
}

// A planting's effective timing: packet values where entered, crop defaults otherwise.
export function timingFor(planting) {
  const c = crop(planting.crop);
  const t = planting.timing || {};
  const pick = (a, b) => (a !== null && a !== undefined && a !== '' ? Number(a) : b);
  const germ = c.germ || [null, null];
  const dtm = c.dtm || [null, null];
  return {
    germMin: pick(t.germMin, germ[0]),
    germMax: pick(t.germMax, germ[1]),
    dtmMin: pick(t.dtmMin, dtm[0]),
    dtmMax: pick(t.dtmMax, dtm[1]),
    spacing: pick(t.spacing, c.spacing),
    fromPacket: !!(t.germMin || t.germMax || t.dtmMin || t.dtmMax),
  };
}
