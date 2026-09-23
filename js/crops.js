// Crop defaults. Seed-packet values entered on a planting or seed packet always
// win over these. To add a crop, add an entry — no migration needed, because
// plantings store the crop key plus their own timing copy.
//
// germ:    [min, max] days from sowing to sprouting (seed method only)
// dtm:     [min, max] days to maturity, counted from the planted date
//          (sowing date for seeds, transplant date for transplants)
// thin:    whether seedlings are normally thinned
// spacing: final spacing in inches
// canopy:  water use at maturity relative to bare soil over a 12" opening
//          (leaf area spreads well past the rim: a grown tomato is ~6x)
// minTempF: forecast low that triggers a cold alert (includes no container margin)
// overwinter: skip the fall-timing allowance (e.g. garlic)

export const CROPS = {
  radish:   { name: 'Radish',       unit: 'count', method: 'seed',       germ: [3, 10],  dtm: [22, 35],   thin: true,  spacing: 2,  canopy: 1.0, minTempF: 25 },
  spinach:  { name: 'Spinach',      unit: 'oz',    method: 'seed',       germ: [5, 14],  dtm: [37, 50],   thin: true,  spacing: 4,  canopy: 1.5, minTempF: 20 },
  chard:    { name: 'Swiss chard',  unit: 'oz',    method: 'seed',       germ: [5, 14],  dtm: [50, 60],   thin: true,  spacing: 8,  canopy: 2.5, minTempF: 25 },
  garlic:   { name: 'Garlic',       unit: 'count', method: 'clove',      germ: null,     dtm: [260, 290], thin: false, spacing: 5,  canopy: 1.0, minTempF: -10, overwinter: true },
  peas:     { name: 'Peas',         unit: 'oz',    method: 'seed',       germ: [7, 14],  dtm: [55, 70],   thin: false, spacing: 2,  canopy: 2.5, minTempF: 28 },
  tomato:   { name: 'Tomato',       unit: 'lb',    method: 'transplant', germ: null,     dtm: [55, 85],   thin: false, spacing: 18, canopy: 6.0, minTempF: 35 },
  pepper:   { name: 'Pepper',       unit: 'count', method: 'transplant', germ: null,     dtm: [60, 90],   thin: false, spacing: 18, canopy: 3.5, minTempF: 38 },
  lettuce:  { name: 'Lettuce',      unit: 'oz',    method: 'seed',       germ: [4, 10],  dtm: [45, 60],   thin: true,  spacing: 6,  canopy: 1.4, minTempF: 28 },
  kale:     { name: 'Kale',         unit: 'oz',    method: 'seed',       germ: [5, 10],  dtm: [50, 65],   thin: true,  spacing: 12, canopy: 2.5, minTempF: 15 },
  carrot:   { name: 'Carrot',       unit: 'count', method: 'seed',       germ: [10, 21], dtm: [60, 75],   thin: true,  spacing: 2,  canopy: 1.2, minTempF: 20 },
  beet:     { name: 'Beet',         unit: 'count', method: 'seed',       germ: [5, 14],  dtm: [50, 60],   thin: true,  spacing: 3,  canopy: 1.3, minTempF: 25 },
  bean:     { name: 'Bush bean',    unit: 'oz',    method: 'seed',       germ: [7, 14],  dtm: [50, 60],   thin: false, spacing: 4,  canopy: 2.5, minTempF: 34 },
  cucumber: { name: 'Cucumber',     unit: 'count', method: 'seed',       germ: [5, 10],  dtm: [50, 65],   thin: true,  spacing: 12, canopy: 5.0, minTempF: 38 },
  basil:    { name: 'Basil',        unit: 'oz',    method: 'transplant', germ: null,     dtm: [30, 60],   thin: false, spacing: 10, canopy: 1.8, minTempF: 40 },
  scallion: { name: 'Green onion',  unit: 'count', method: 'seed',       germ: [7, 14],  dtm: [60, 80],   thin: false, spacing: 1,  canopy: 0.8, minTempF: 20 },
  other:    { name: 'Other',        unit: 'oz',    method: 'seed',       germ: null,     dtm: null,       thin: false, spacing: null, canopy: 1.8, minTempF: 32 },
};

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
