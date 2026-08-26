import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, suggestDeposit, placementFactor, sizeFactor, sizeWeight, REFERENCE_SIZE_CM } from '../src/pricing.js';

const artist = { reference_price_cents: 18000, minimum_cents: 8000, deposit_percent: 30 };

test('a small simple piece falls back to the shop minimum', () => {
  const result = estimate({ size_cm: 3, detail_level: 'simple', color_mode: 'linework' }, artist);
  assert.equal(result.hours, 0.5);
  assert.equal(result.low_cents, artist.minimum_cents);
  assert.ok(result.high_cents >= result.low_cents);
});

test('price grows with size, detail and colour', () => {
  const small = estimate({ size_cm: 8, detail_level: 'simple', color_mode: 'linework' }, artist);
  const big = estimate({ size_cm: 25, detail_level: 'high', color_mode: 'color' }, artist);
  assert.ok(big.hours > small.hours);
  assert.ok(big.midpoint_cents > small.midpoint_cents);
});

test('tough placements cost more hours than an easy one', () => {
  const forearm = estimate({ size_cm: 15, detail_level: 'medium', color_mode: 'blackwork', placement: 'forearm' }, artist);
  const ribs = estimate({ size_cm: 15, detail_level: 'medium', color_mode: 'blackwork', placement: 'ribs' }, artist);
  assert.ok(ribs.hours > forearm.hours);
  assert.equal(placementFactor('left forearm'), 1);
});

test('cover-ups carry a surcharge', () => {
  const plain = estimate({ size_cm: 20, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  const cover = estimate({ size_cm: 20, detail_level: 'medium', color_mode: 'blackwork', cover_up: true }, artist);
  assert.ok(cover.hours > plain.hours);
});

test('long pieces are split into sessions', () => {
  const sleeve = estimate({ size_cm: 45, detail_level: 'high', color_mode: 'color' }, artist);
  assert.ok(sleeve.sessions > 1);
});

test('an unrealistic budget is flagged with the gap', () => {
  const result = estimate(
    { size_cm: 30, detail_level: 'high', color_mode: 'color', budget_cents: 15000 },
    artist,
  );
  assert.equal(result.budget_realistic, false);
  assert.equal(result.budget_gap_cents, result.low_cents - 15000);
});

test('a budget above the bracket is realistic', () => {
  const result = estimate({ size_cm: 8, detail_level: 'medium', color_mode: 'blackwork', budget_cents: 50000 }, artist);
  assert.equal(result.budget_realistic, true);
  assert.equal(result.budget_gap_cents, 0);
});

test('deposit is a rounded percentage capped at the price', () => {
  assert.equal(suggestDeposit(30000, 30), 9000);
  assert.equal(suggestDeposit(30000, 200), 30000);
  assert.equal(suggestDeposit(30000, -5), 0);
});

test('the price never jumps at a size boundary', () => {
  // The bug this pins: bands made 10 -> 11 cm cost 67 % more, and 6 -> 10 cm cost
  // nothing at all. A client moving the slider stops trusting a number that does
  // either of those.
  let worst = { jump: 0, at: 0 };
  let previous = null;
  for (let size = 3; size <= 80; size++) {
    const { midpoint_cents } = estimate({ size_cm: size, detail_level: 'medium', color_mode: 'blackwork' }, artist);
    if (previous) {
      assert.ok(midpoint_cents >= previous, `price fell from ${size - 1} to ${size} cm`);
      const jump = (midpoint_cents - previous) / previous;
      if (jump > worst.jump) worst = { jump, at: size };
    }
    previous = midpoint_cents;
  }
  assert.ok(worst.jump <= 0.25, `a single centimetre moved the price by ${Math.round(worst.jump * 100)} % at ${worst.at} cm`);
});

test('every centimetre changes the price — no flat stretches', () => {
  // Above the shop minimum, where the floor no longer masks the curve.
  let previous = estimate({ size_cm: 12, detail_level: 'medium', color_mode: 'blackwork' }, artist).midpoint_cents;
  for (let size = 13; size <= 40; size++) {
    const { midpoint_cents } = estimate({ size_cm: size, detail_level: 'medium', color_mode: 'blackwork' }, artist);
    assert.ok(midpoint_cents > previous, `${size - 1} and ${size} cm cost the same`);
    previous = midpoint_cents;
  }
});

test('the bracket widens with the length of the work', () => {
  const small = estimate({ size_cm: 6, detail_level: 'simple', color_mode: 'linework' }, artist);
  const large = estimate({ size_cm: 45, detail_level: 'high', color_mode: 'color' }, artist);
  // A one-hour liner is predictable; a twenty-hour back piece is not, and a narrow
  // range on it would be a promise the artist cannot keep.
  assert.ok(large.spread_percent > small.spread_percent);
  assert.ok(small.spread_percent >= 12 && large.spread_percent <= 30);

  const width = (e) => (e.high_cents - e.low_cents) / e.midpoint_cents;
  assert.ok(width(large) > width(small));
});

test('the displayed duration is rounded but the price is not quantised by it', () => {
  const a = estimate({ size_cm: 17, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  const b = estimate({ size_cm: 18, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  assert.equal(a.hours % 0.25, 0, 'hours are spoken in quarters');
  assert.notEqual(a.midpoint_cents, b.midpoint_cents, 'but a centimetre still moves the money');
});

test('the price is built from the properties, not from a clock', () => {
  // Same size, same everything but the drawing: complexity is what moves it.
  const simple = estimate({ size_cm: 10, detail_level: 'simple', color_mode: 'linework' }, artist);
  const dense = estimate({ size_cm: 10, detail_level: 'hyperrealism', color_mode: 'color' }, artist);
  assert.ok(dense.midpoint_cents > simple.midpoint_cents * 3);

  // The reference piece is exactly what the studio said it charges for one.
  const reference = estimate({ size_cm: 10, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  assert.equal(reference.midpoint_cents, artist.reference_price_cents);
  assert.equal(sizeFactor(10), 1);
});

test('the estimate shows what drives it', () => {
  const result = estimate({
    size_cm: 18, detail_level: 'high', color_mode: 'blackgrey', placement: 'côtes', cover_up: true,
  }, artist);

  const byKey = Object.fromEntries(result.factors.map((f) => [f.key, f]));
  assert.ok(byKey.size.factor > 2, 'an 18 cm piece is more than twice the reference');
  assert.equal(byKey.detail.label, 'Très détaillé');
  assert.ok(byKey.placement.factor > 1, 'ribs cost more');
  assert.equal(byKey.cover_up.factor, 1.4);
  // Neutral factors are not paraded as if they changed something.
  const neutral = estimate({ size_cm: 10, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  assert.deepEqual(neutral.factors.map((f) => f.key), ['size']);
});

test('a studio configured before the change keeps its prices', () => {
  // Its reference piece is what its hourly rate charged for one.
  const legacy = { hourly_rate_cents: 12000, minimum_cents: 8000, deposit_percent: 30 };
  const result = estimate({ size_cm: 10, detail_level: 'medium', color_mode: 'blackwork' }, legacy);
  assert.equal(result.midpoint_cents, 18000);
});

/* ----------------------------------------- the curve, and what the client reads */

test('the curve never accelerates as the piece grows', () => {
  // The model itself, before any rounding: past the smallest sizes, one more
  // centimetre may only ever cost a smaller share than the one before. A table of
  // anchors joined by straight lines surged again at every anchor — 12.5 % at
  // 5 cm, 20 % at 6 cm — which is what this forbids.
  let previous = sizeWeight(4);
  let previousJump = Infinity;
  for (let cm = 5; cm <= 120; cm += 1) {
    const weight = sizeWeight(cm);
    const jump = (weight - previous) / previous;
    assert.ok(jump > 0, `${cm} cm must weigh more than ${cm - 1} cm`);
    assert.ok(jump <= previousJump,
      `the curve accelerated at ${cm} cm (${(jump * 100).toFixed(2)} % after ${(previousJump * 100).toFixed(2)} %)`);
    previousJump = jump;
    previous = weight;
  }
});

test('the price rises smoothly with the size, with no cliff anywhere', () => {
  const artist = { reference_price_cents: 20000, minimum_cents: 0, deposit_percent: 30 };
  const at = (cm) => estimate({ size_cm: cm, detail_level: 'medium', color_mode: 'blackwork' }, artist).midpoint_cents;

  let previous = at(2);
  for (let cm = 3; cm <= 80; cm += 1) {
    const price = at(cm);
    const jump = (price - previous) / previous;
    assert.ok(jump > 0, `${cm} cm should cost more than ${cm - 1} cm`);
    assert.ok(jump < 0.2, `one centimetre moved the price by ${Math.round(jump * 100)} % at ${cm} cm`);
    previous = price;
  }
});

test('the reference piece costs exactly the reference price', () => {
  const artist = { reference_price_cents: 24000, minimum_cents: 0, deposit_percent: 30 };
  const result = estimate({ size_cm: REFERENCE_SIZE_CM, detail_level: 'medium', color_mode: 'blackwork' }, artist);
  assert.equal(result.midpoint_cents, 24000);
  assert.equal(result.factors.find((f) => f.key === 'size').factor, 1);
});

test('the breakdown the client is shown multiplies out to the price they are quoted', () => {
  const artist = { reference_price_cents: 21000, minimum_cents: 0, deposit_percent: 30 };
  for (const brief of [
    { size_cm: 25, detail_level: 'hyperrealism', color_mode: 'color', cover_up: true, placement: 'côtes' },
    { size_cm: 7, detail_level: 'simple', color_mode: 'linework' },
    { size_cm: 44, detail_level: 'high', color_mode: 'blackgrey', placement: 'main' },
    { size_cm: 3, detail_level: 'medium', color_mode: 'blackwork' },
  ]) {
    const result = estimate(brief, artist);
    const rebuilt = result.factors.reduce((total, item) => total * item.factor, result.reference_price_cents);
    assert.equal(Math.round(rebuilt), result.midpoint_cents,
      `${JSON.stringify(brief)} : le détail affiché donne ${Math.round(rebuilt)} pour un prix annoncé de ${result.midpoint_cents}`);
  }
});

test('hours and price agree on how much work is in there', () => {
  const artist = { reference_price_cents: 20000, minimum_cents: 0, deposit_percent: 30 };
  const simple = estimate({ size_cm: 20, detail_level: 'simple', color_mode: 'linework' }, artist);
  const hard = estimate({ size_cm: 20, detail_level: 'hyperrealism', color_mode: 'color', cover_up: true }, artist);
  assert.ok(hard.midpoint_cents > simple.midpoint_cents);
  assert.ok(hard.hours > simple.hours, 'what costs more also takes longer');
  assert.ok(hard.sessions >= simple.sessions);
});
