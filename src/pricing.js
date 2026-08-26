// Estimation engine.
//
// A tattooist does not price by multiplying an hourly rate: they price the piece
// — its size, how detailed it is, whether it is colour, where it sits on the body,
// whether it covers something. So the price is built from those properties, from
// a reference price the studio sets.
//
// How long it takes is a separate question with a separate model, in duration.js.
// The two used to share one number, which quietly claimed that anything costing
// 35 % more takes 35 % longer — see that file for why it does not.
//
// The point is not to be exact. It is to give the client an honest bracket, to
// show what drives it, and to flag a budget nowhere near the work before anyone
// spends an evening in DMs.

import { duration } from './duration.js';

export const DETAIL_LEVELS = ['simple', 'medium', 'high', 'hyperrealism'];
export const COLOR_MODES = ['linework', 'blackwork', 'blackgrey', 'color'];

/** How much of the price is the drawing itself: the single biggest factor. */
const DETAIL_FACTOR = { simple: 0.7, medium: 1, high: 1.45, hyperrealism: 2 };
const DETAIL_LABEL = {
  simple: 'Motif simple', medium: 'Détail moyen',
  high: 'Très détaillé', hyperrealism: 'Hyperréalisme',
};

const COLOR_FACTOR = { linework: 0.85, blackwork: 1, blackgrey: 1.1, color: 1.35 };
const COLOR_LABEL = {
  linework: 'Ligne seule', blackwork: 'Noir plein',
  blackgrey: 'Noir & gris', color: 'Couleur',
};

// Areas that are harder to tattoo: thin skin, movement, breaks for the client.
const TOUGH_PLACEMENTS = [
  ['rib', 1.25], ['côte', 1.25], ['sternum', 1.2], ['stomach', 1.15], ['ventre', 1.15],
  ['hand', 1.2], ['main', 1.2], ['finger', 1.25], ['doigt', 1.25],
  ['neck', 1.2], ['cou', 1.2], ['throat', 1.25], ['gorge', 1.25],
  ['head', 1.25], ['tête', 1.25], ['face', 1.3], ['visage', 1.3],
  ['foot', 1.2], ['pied', 1.2], ['ankle', 1.1], ['cheville', 1.1],
  ['knee', 1.2], ['genou', 1.2], ['elbow', 1.2], ['coude', 1.2],
  ['spine', 1.15], ['colonne', 1.15], ['armpit', 1.3], ['aisselle', 1.3],
];

const COVER_UP_FACTOR = 1.4;

// Duration is a different question from price and has its own model, fitted to
// what studios publish about their own work. Asking one number to answer both is
// what made the hours wrong.
export { MAX_SESSION_HOURS } from './duration.js';

/** The size everything is measured against: the studio's reference piece. */
export const REFERENCE_SIZE_CM = 10;

// The size curve.
//
// Bands were the first attempt and were wrong: at a boundary one centimetre moved
// the price by half, and inside a band four centimetres moved nothing. A table of
// anchors joined by straight lines replaced them, and was wrong more quietly —
// the price was continuous but its slope was not, so the cost of one more
// centimetre jumped every time the client crossed an anchor: 12.5 % at 5 cm,
// 20 % at 6 cm, 8.7 % at 15 cm, 12 % at 16 cm. Dragging the size control felt
// like the price was surging and stalling at random. Worse, the anchors implied
// a scaling exponent that swung between 0.44 and 1.63 from one segment to the
// next, which is noise nobody chose.
//
// What a tattoo actually costs has two parts, and they behave differently. There
// is a fixed part — the sitting, the stencil, the setup — which is why a tiny
// piece is never nearly free. And there is the work itself, which grows faster
// than the longest dimension because it fills an area, but slower than the area
// itself because a big piece carries proportionally more open space. So:
//
//     weight = FIXED + RATE * size^EXPONENT
//
// fitted to the three sizes a studio can actually judge: a 2 cm flash at about a
// third of the reference piece, the 10 cm reference at 1.5, and a 40 cm back
// piece at about six times the reference. The result is smooth everywhere, and
// so is its slope.
const SIZE_FIXED = 0.4;
const SIZE_EXPONENT = 1.5;
/** The reference piece weighs exactly this, which is what makes it the reference. */
const REFERENCE_WEIGHT = 1.5;
// Derived rather than typed, so the curve passes through the reference exactly.
// A studio migrating off an hourly rate has its reference price computed from this
// weight, and a rounding drift here would quietly reprice every one of them.
const SIZE_RATE = (REFERENCE_WEIGHT - SIZE_FIXED) / (REFERENCE_SIZE_CM ** SIZE_EXPONENT);

/** Relative weight of a size, in the same units as the reference piece. */
export function sizeWeight(sizeCm) {
  const size = Math.max(1, Number(sizeCm) || 1);
  return SIZE_FIXED + SIZE_RATE * (size ** SIZE_EXPONENT);
}

/** 1 at the reference size, so the studio's reference price means what it says. */
export const sizeFactor = (sizeCm) => sizeWeight(sizeCm) / sizeWeight(REFERENCE_SIZE_CM);

export function placementFactor(placement = '') {
  const p = String(placement).toLowerCase();
  let best = 1;
  for (const [needle, factor] of TOUGH_PLACEMENTS) {
    if (p.includes(needle) && factor > best) best = factor;
  }
  return best;
}

const round2 = (n) => Math.round(n * 100) / 100;
const roundTo5 = (cents) => Math.round(cents / 500) * 500;

/**
 * How wide the bracket should be. A small simple piece is predictable; a large
 * hyperrealist cover-up is not, and a narrow range on it would be a promise the
 * artist cannot keep.
 */
export function spreadFor(weight) {
  return Math.min(0.3, Math.max(0.12, 0.1 + weight * 0.014));
}

/** The studio's reference price, falling back to an hourly rate for older setups. */
export function referencePrice(artist) {
  const explicit = Number(artist.reference_price_cents) || 0;
  if (explicit > 0) return explicit;
  // Studios configured before pricing moved off the clock: their reference piece
  // is what their hourly rate charged for it.
  return Math.round((Number(artist.hourly_rate_cents) || 12000) * sizeWeight(REFERENCE_SIZE_CM));
}

/**
 * @param {object} brief   size_cm, detail_level, color_mode, placement, cover_up, budget_cents
 * @param {object} artist  reference_price_cents, minimum_cents, deposit_percent
 */
export function estimate(brief, artist) {
  const reference = referencePrice(artist);
  const minimum = Math.max(0, Number(artist.minimum_cents) || 0);
  const depositPercent = Math.min(100, Math.max(0, Number(artist.deposit_percent) ?? 30));

  // Rounded before they are multiplied, not after. The client is shown these
  // numbers and told they explain the price; if the shown figures multiply out to
  // something else, the explanation is a decoration. A tenth of a percent is
  // nothing to the studio and everything to whether the page can be trusted.
  const factors = [
    { key: 'size', label: `Taille ${Math.round(Number(brief.size_cm) || 0)} cm`, factor: sizeFactor(brief.size_cm) },
    { key: 'detail', label: DETAIL_LABEL[brief.detail_level] ?? 'Détail moyen', factor: DETAIL_FACTOR[brief.detail_level] ?? 1 },
    { key: 'color', label: COLOR_LABEL[brief.color_mode] ?? 'Noir plein', factor: COLOR_FACTOR[brief.color_mode] ?? 1 },
    { key: 'placement', label: brief.placement ? `Zone : ${brief.placement}` : 'Zone standard', factor: placementFactor(brief.placement) },
    { key: 'cover_up', label: 'Recouvrement', factor: brief.cover_up ? COVER_UP_FACTOR : 1 },
  ].map((item) => ({ ...item, factor: round2(item.factor) }));

  const combined = factors.reduce((total, item) => total * item.factor, 1);
  const byKey = Object.fromEntries(factors.map((item) => [item.key, item.factor]));
  const midpoint = Math.max(minimum, Math.round(reference * combined));
  const flooredByMinimum = midpoint === minimum && Math.round(reference * combined) < minimum;

  // Weight drives how wide the bracket should be: it measures how much work is in
  // there, which is what makes a price hard to promise. It is not a duration, and
  // no longer pretends to be one.
  const weight = sizeWeight(brief.size_cm)
    * byKey.detail * byKey.color * byKey.placement * byKey.cover_up;
  const spread = spreadFor(weight);
  const time = duration(brief);
  const low = Math.max(minimum, roundTo5(midpoint * (1 - spread)));
  const high = Math.max(low, roundTo5(midpoint * (1 + spread)));

  const budget = Number(brief.budget_cents) || 0;
  const budgetGap = budget > 0 && budget < low ? low - budget : 0;

  return {
    // What the price is made of — the client sees why, not just how much.
    reference_price_cents: reference,
    factors: factors.filter((item) => item.factor !== 1 || item.key === 'size'),
    floored_by_minimum: flooredByMinimum,

    // Two different hours, because they answer two different questions. The
    // needle time is the work; the chair time is what the client blocks out, and
    // it carries the stencil and setup of every session it takes.
    hours: time.needle_hours,
    chair_hours: time.chair_hours,
    session_hours: time.session_hours,
    setup_hours: time.setup_hours,
    sessions: time.sessions,
    duration_factors: time.factors,
    spread_percent: Math.round(spread * 100),
    low_cents: low,
    high_cents: high,
    midpoint_cents: midpoint,
    deposit_cents: suggestDeposit(midpoint, depositPercent),
    // Surfaced in the inbox so the artist triages in one glance instead of a DM thread.
    budget_gap_cents: budgetGap,
    budget_realistic: budgetGap === 0,
  };
}

export function suggestDeposit(priceCents, depositPercent) {
  const price = Math.max(0, Number(priceCents) || 0);
  const percent = Math.min(100, Math.max(0, Number(depositPercent) ?? 30));
  return Math.min(price, roundTo5(price * (percent / 100)));
}

export function formatMoney(cents, currency = 'EUR') {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format((Number(cents) || 0) / 100);
}
