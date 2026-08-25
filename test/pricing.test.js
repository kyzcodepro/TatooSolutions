import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, suggestDeposit, placementMultiplier } from '../src/pricing.js';

const artist = { hourly_rate_cents: 12000, minimum_cents: 8000, deposit_percent: 30 };

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
  assert.equal(placementMultiplier('left forearm'), 1);
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
