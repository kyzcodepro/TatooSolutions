// The duration model, held against the figures studios publish about their own
// work. Every expectation below is a range somebody printed on a real price or
// FAQ page, not a number invented here — the sources are listed at the foot of
// src/duration.js. When a studio corrects these with its own figures, this file
// is what should be edited first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, setupHours, placementTimeFactor, MAX_SESSION_HOURS } from '../src/duration.js';
import { estimate } from '../src/pricing.js';

/** Asserts chair time falls inside a published range. */
function within(label, brief, [low, high]) {
  const result = duration(brief);
  assert.ok(result.chair_hours >= low && result.chair_hours <= high,
    `${label}: ${result.chair_hours} h sur place, hors de la fourchette publiée ${low}–${high} h`);
  return result;
}

test('published size ranges', () => {
  within('5 cm, simple line work (15–45 min)', { size_cm: 5, detail_level: 'simple', color_mode: 'linework' }, [0.25, 0.75]);
  within('10 cm, some detail (1–3 h)', { size_cm: 10, detail_level: 'medium', color_mode: 'blackgrey' }, [1, 3]);
  within('15 cm, some detail (1–3 h)', { size_cm: 15, detail_level: 'medium', color_mode: 'blackgrey' }, [1, 3]);
});

test('published body-part ranges, in the bold black work those figures describe', () => {
  within('sternum ~20 cm (2–4 h)',
    { size_cm: 20, detail_level: 'medium', color_mode: 'blackwork', placement: 'sternum' }, [2, 4.5]);
  within('forearm panel ~25 cm (2–5 h+)',
    { size_cm: 25, detail_level: 'medium', color_mode: 'blackwork', placement: 'avant-bras' }, [2, 5.5]);
  within('thigh, one side ~30 cm (3–5 h+)',
    { size_cm: 30, detail_level: 'simple', color_mode: 'blackwork', placement: 'cuisse' }, [3, 5.5]);
  within('chest ~35 cm (4–6 h+)',
    { size_cm: 35, detail_level: 'simple', color_mode: 'blackwork', placement: 'torse' }, [4, 6.5]);
  within('full sleeve ~55 cm (12–16 h+)',
    { size_cm: 55, detail_level: 'medium', color_mode: 'blackwork' }, [12, 18]);
  within('full back ~55 cm (12–20 h+)',
    { size_cm: 55, detail_level: 'medium', color_mode: 'blackwork', placement: 'dos' }, [12, 20]);
  within('full leg sleeve ~75 cm (16–30 h+)',
    { size_cm: 75, detail_level: 'medium', color_mode: 'blackwork' }, [16, 30]);
});

test('a palm-sized portrait costs hours that realism actually costs', () => {
  // The anchor: a palm-sized piece is two hours in a traditional style and six to
  // eight as photorealism. Traditional is bold and efficient but not bare — it is
  // the middle of this scale, not the bottom — so the ratio is read between
  // "medium" and "hyperréalisme", holding the rendering still.
  const traditional = duration({ size_cm: 10, detail_level: 'medium', color_mode: 'blackgrey' });
  const realism = duration({ size_cm: 10, detail_level: 'hyperrealism', color_mode: 'blackgrey' });
  const ratio = realism.needle_hours / traditional.needle_hours;
  assert.ok(ratio >= 3 && ratio <= 4, `réalisme vs traditionnel : ×${ratio.toFixed(1)}, attendu ×3–4`);

  // And in colour, which is where the six-to-eight figure comes from.
  const colourRealism = duration({ size_cm: 10, detail_level: 'hyperrealism', color_mode: 'color' });
  assert.ok(colourRealism.chair_hours >= 5 && colourRealism.chair_hours <= 8,
    `photoréalisme couleur, paume : ${colourRealism.chair_hours} h, attendu 6–8 h`);
  assert.ok(traditional.chair_hours <= 2.5,
    `la même pièce en traditionnel : ${traditional.chair_hours} h, attendu ~2 h`);
});

test('colour adds the 20–40 % of time it is reported to add', () => {
  const grey = duration({ size_cm: 20, detail_level: 'high', color_mode: 'blackgrey' });
  const colour = duration({ size_cm: 20, detail_level: 'high', color_mode: 'color' });
  const extra = colour.needle_hours / grey.needle_hours - 1;
  assert.ok(extra >= 0.2 && extra <= 0.4, `couleur : +${Math.round(extra * 100)} %, attendu +20–40 %`);
});

test('a hand takes about twice what the same piece takes on an arm', () => {
  const arm = duration({ size_cm: 12, detail_level: 'medium', color_mode: 'blackgrey', placement: 'bras' });
  const hand = duration({ size_cm: 12, detail_level: 'medium', color_mode: 'blackgrey', placement: 'main' });
  const ratio = hand.needle_hours / arm.needle_hours;
  assert.ok(ratio >= 1.8 && ratio <= 2.2, `main vs bras : ×${ratio.toFixed(2)}, attendu ×2`);
  assert.equal(placementTimeFactor('paume de la main'), 2);
});

test('a cover-up adds the 25–50 % it is reported to add', () => {
  const fresh = duration({ size_cm: 18, detail_level: 'high', color_mode: 'blackgrey' });
  const cover = duration({ size_cm: 18, detail_level: 'high', color_mode: 'blackgrey', cover_up: true });
  const extra = cover.needle_hours / fresh.needle_hours - 1;
  assert.ok(extra >= 0.25 && extra <= 0.5, `recouvrement : +${Math.round(extra * 100)} %, attendu +25–50 %`);
});

test('a piece that hurts is not the same as a piece that is slow', () => {
  // Ribs and sternum carry a heavy price premium and only a light time one:
  // published sternum pieces sit at 2–4 h, like anywhere else that size.
  const plain = duration({ size_cm: 20, detail_level: 'medium', color_mode: 'blackgrey' });
  const ribs = duration({ size_cm: 20, detail_level: 'medium', color_mode: 'blackgrey', placement: 'côtes' });
  const hand = duration({ size_cm: 20, detail_level: 'medium', color_mode: 'blackgrey', placement: 'main' });
  assert.ok(ribs.needle_hours > plain.needle_hours, 'ribs do slow the work somewhat');
  assert.ok(hand.needle_hours > ribs.needle_hours, 'but a hand slows it far more');

  // And the price says the opposite: ribs cost more than a hand.
  const artist = { reference_price_cents: 20000, minimum_cents: 0, deposit_percent: 30 };
  const ribsPrice = estimate({ size_cm: 20, detail_level: 'medium', color_mode: 'blackgrey', placement: 'côtes' }, artist);
  const handPrice = estimate({ size_cm: 20, detail_level: 'medium', color_mode: 'blackgrey', placement: 'main' }, artist);
  assert.ok(ribsPrice.midpoint_cents > handPrice.midpoint_cents,
    'the two rankings are genuinely different, which is the whole point');
});

test('every session carries its own setup, and the setup grows with the piece', () => {
  assert.equal(setupHours(3), 0.5, 'a small piece still needs half an hour of stencil and prep');
  assert.equal(setupHours(50), 1, 'a big one needs an hour');
  assert.ok(setupHours(25) > setupHours(5));

  const big = duration({ size_cm: 60, detail_level: 'high', color_mode: 'color' });
  assert.ok(big.sessions > 1, 'a piece this size cannot be one sitting');
  const overhead = big.chair_hours - big.needle_hours;
  assert.ok(Math.abs(overhead - big.sessions * big.setup_hours) < 0.3,
    `l'installation est comptée une fois par séance (${overhead} h pour ${big.sessions} séances)`);
});

test('no appointment is ever longer than a body can sit', () => {
  for (const size of [10, 25, 40, 60, 90, 150]) {
    for (const detail of ['simple', 'medium', 'high', 'hyperrealism']) {
      const result = duration({ size_cm: size, detail_level: detail, color_mode: 'color', cover_up: true, placement: 'main' });
      assert.ok(result.session_hours <= MAX_SESSION_HOURS,
        `${size} cm ${detail} : séance de ${result.session_hours} h, au-delà du plafond`);
      assert.ok(result.session_hours > 0);
      assert.ok(result.chair_hours >= result.needle_hours, 'chair time includes the needle time');
    }
  }
});

test('longer work never comes back as fewer hours', () => {
  let previous = 0;
  for (let cm = 1; cm <= 120; cm += 1) {
    const result = duration({ size_cm: cm, detail_level: 'medium', color_mode: 'blackgrey' });
    assert.ok(result.needle_hours >= previous, `${cm} cm takes less than ${cm - 1} cm`);
    previous = result.needle_hours;
  }
  for (const [a, b] of [['simple', 'medium'], ['medium', 'high'], ['high', 'hyperrealism']]) {
    assert.ok(duration({ size_cm: 20, detail_level: b }).needle_hours
      > duration({ size_cm: 20, detail_level: a }).needle_hours, `${b} must take longer than ${a}`);
  }
});

test('the estimate hands both numbers on, and they mean different things', () => {
  const artist = { reference_price_cents: 20000, minimum_cents: 0, deposit_percent: 30 };
  const result = estimate({ size_cm: 45, detail_level: 'high', color_mode: 'color' }, artist);
  assert.ok(result.chair_hours > result.hours, 'chair time is needle time plus setup');
  assert.ok(result.session_hours <= MAX_SESSION_HOURS);
  assert.ok(result.sessions > 1);
  assert.ok(result.duration_factors.length, 'and the client can see what drove it');
  const rebuilt = result.duration_factors.reduce((total, item) => total * item.factor, 1.25);
  assert.ok(Math.abs(rebuilt - result.hours) < 0.3, 'the breakdown reproduces the needle time');
});
