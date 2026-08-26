// Estimation engine.
//
// A tattooist does not price by multiplying an hourly rate: they price the piece
// — its size, how detailed it is, whether it is colour, where it sits on the body,
// whether it covers something. So the price is built from those properties, from
// a reference price the studio sets, and the duration is a by-product used for
// planning sessions rather than the thing being sold.
//
// The point is not to be exact. It is to give the client an honest bracket, to
// show what drives it, and to flag a budget nowhere near the work before anyone
// spends an evening in DMs.

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
export const MAX_SESSION_HOURS = 6;

/** The size everything is measured against: the studio's reference piece. */
export const REFERENCE_SIZE_CM = 10;

// The size curve, continuous through observed anchors. Bands were tempting and
// wrong: at a boundary one centimetre moved the price by half, and inside a band
// four centimetres moved nothing — a client watching that stops believing it.
const SIZE_ANCHORS = [[2, 0.5], [5, 0.75], [10, 1.5], [15, 2.5], [20, 4], [30, 6], [40, 9]];
const BEYOND_LAST_PER_CM = 0.25;

/** Relative weight of a size, in the same units as the anchors. */
export function sizeWeight(sizeCm) {
  const size = Math.max(1, Number(sizeCm) || 1);
  const [firstCm, firstWeight] = SIZE_ANCHORS[0];
  if (size <= firstCm) return (size / firstCm) * firstWeight;

  for (let i = 1; i < SIZE_ANCHORS.length; i++) {
    const [cm, weight] = SIZE_ANCHORS[i];
    if (size <= cm) {
      const [prevCm, prevWeight] = SIZE_ANCHORS[i - 1];
      return prevWeight + ((size - prevCm) / (cm - prevCm)) * (weight - prevWeight);
    }
  }
  const [lastCm, lastWeight] = SIZE_ANCHORS[SIZE_ANCHORS.length - 1];
  return lastWeight + (size - lastCm) * BEYOND_LAST_PER_CM;
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

const roundQuarter = (h) => Math.max(0.5, Math.round(h * 4) / 4);
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

  const factors = [
    { key: 'size', label: `Taille ${Math.round(Number(brief.size_cm) || 0)} cm`, factor: sizeFactor(brief.size_cm) },
    { key: 'detail', label: DETAIL_LABEL[brief.detail_level] ?? 'Détail moyen', factor: DETAIL_FACTOR[brief.detail_level] ?? 1 },
    { key: 'color', label: COLOR_LABEL[brief.color_mode] ?? 'Noir plein', factor: COLOR_FACTOR[brief.color_mode] ?? 1 },
    { key: 'placement', label: brief.placement ? `Zone : ${brief.placement}` : 'Zone standard', factor: placementFactor(brief.placement) },
    { key: 'cover_up', label: 'Recouvrement', factor: brief.cover_up ? COVER_UP_FACTOR : 1 },
  ];

  const combined = factors.reduce((total, item) => total * item.factor, 1);
  const midpoint = Math.max(minimum, Math.round(reference * combined));
  const flooredByMinimum = midpoint === minimum && Math.round(reference * combined) < minimum;

  // Weight, not hours, drives the uncertainty: it is the same measure of "how
  // much work is in there" without pretending to know a duration.
  // Everything that makes the piece harder also makes it longer — including the
  // area: thin skin and breaks slow the work down as surely as fine detail does.
  const weight = sizeWeight(brief.size_cm) * (DETAIL_FACTOR[brief.detail_level] ?? 1)
    * (COLOR_FACTOR[brief.color_mode] ?? 1) * placementFactor(brief.placement)
    * (brief.cover_up ? COVER_UP_FACTOR : 1);
  const spread = spreadFor(weight);
  const low = Math.max(minimum, roundTo5(midpoint * (1 - spread)));
  const high = Math.max(low, roundTo5(midpoint * (1 + spread)));

  const sessions = Math.max(1, Math.ceil(weight / MAX_SESSION_HOURS));
  const budget = Number(brief.budget_cents) || 0;
  const budgetGap = budget > 0 && budget < low ? low - budget : 0;

  return {
    // What the price is made of — the client sees why, not just how much.
    reference_price_cents: reference,
    factors: factors
      .filter((item) => item.factor !== 1 || item.key === 'size')
      .map((item) => ({ ...item, factor: Math.round(item.factor * 100) / 100 })),
    floored_by_minimum: flooredByMinimum,

    hours: roundQuarter(weight),
    sessions,
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
