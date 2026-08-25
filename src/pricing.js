// Estimation engine: turns a structured brief into hours, a price range and a deposit.
// The point is not to be exact — it is to give the client an honest bracket and to
// filter out briefs whose budget is nowhere near the artist's rate before anyone
// spends an hour in DMs.

export const DETAIL_LEVELS = ['simple', 'medium', 'high', 'hyperrealism'];
export const COLOR_MODES = ['linework', 'blackwork', 'blackgrey', 'color'];

const DETAIL_MULTIPLIER = { simple: 0.8, medium: 1, high: 1.35, hyperrealism: 1.7 };
const COLOR_MULTIPLIER = { linework: 0.85, blackwork: 1, blackgrey: 1.1, color: 1.3 };

// Areas that are slower to work on: thin skin, movement, or the client needing breaks.
const TOUGH_PLACEMENTS = [
  ['rib', 1.25], ['sternum', 1.2], ['stomach', 1.15], ['hand', 1.2], ['finger', 1.25],
  ['neck', 1.2], ['throat', 1.25], ['head', 1.25], ['face', 1.3], ['foot', 1.2],
  ['ankle', 1.1], ['knee', 1.2], ['elbow', 1.2], ['spine', 1.15], ['armpit', 1.3],
];

export const MAX_SESSION_HOURS = 6;
const COVER_UP_MULTIPLIER = 1.4;

function baseHours(sizeCm) {
  const size = Math.max(1, Number(sizeCm) || 1);
  if (size <= 5) return 0.75;
  if (size <= 10) return 1.5;
  if (size <= 15) return 2.5;
  if (size <= 20) return 4;
  if (size <= 30) return 6;
  if (size <= 40) return 9;
  return 12 + (size - 40) * 0.25;
}

export function placementMultiplier(placement = '') {
  const p = String(placement).toLowerCase();
  let best = 1;
  for (const [needle, mult] of TOUGH_PLACEMENTS) {
    if (p.includes(needle) && mult > best) best = mult;
  }
  return best;
}

const roundQuarter = (h) => Math.max(0.5, Math.round(h * 4) / 4);
const roundTo5 = (cents) => Math.round(cents / 500) * 500;

/**
 * @param {object} brief   size_cm, detail_level, color_mode, placement, cover_up, budget_cents
 * @param {object} artist  hourly_rate_cents, minimum_cents, deposit_percent
 */
export function estimate(brief, artist) {
  const hourlyRate = Math.max(1000, Number(artist.hourly_rate_cents) || 12000);
  const minimum = Math.max(0, Number(artist.minimum_cents) || 0);
  const depositPercent = Math.min(100, Math.max(0, Number(artist.deposit_percent) ?? 30));

  const hours = roundQuarter(
    baseHours(brief.size_cm)
      * (DETAIL_MULTIPLIER[brief.detail_level] ?? 1)
      * (COLOR_MULTIPLIER[brief.color_mode] ?? 1)
      * placementMultiplier(brief.placement)
      * (brief.cover_up ? COVER_UP_MULTIPLIER : 1),
  );

  const midpoint = Math.max(minimum, Math.round(hours * hourlyRate));
  const low = Math.max(minimum, roundTo5(midpoint * 0.9));
  const high = Math.max(low, roundTo5(midpoint * 1.15));
  const sessions = Math.max(1, Math.ceil(hours / MAX_SESSION_HOURS));
  const deposit = suggestDeposit(midpoint, depositPercent);

  const budget = Number(brief.budget_cents) || 0;
  const budgetGap = budget > 0 && budget < low ? low - budget : 0;

  return {
    hours,
    sessions,
    low_cents: low,
    high_cents: high,
    midpoint_cents: midpoint,
    deposit_cents: deposit,
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
