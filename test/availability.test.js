// Opening hours are wall-clock local, storage is UTC, and the two disagree twice
// a year. That is the part worth pinning down.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableSlots, offsetAt, zonedToUtc, zonedParts, withinWorkingHours,
  parseWorkingHours, DEFAULT_WORKING_HOURS,
} from '../src/availability.js';

const PARIS = 'Europe/Paris';
const studio = { workingHours: DEFAULT_WORKING_HOURS, timeZone: PARIS, leadHours: 48 };
const inParis = (iso) => new Date(iso).toLocaleString('fr-FR', {
  timeZone: PARIS, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

test('a wall-clock time survives the clock change', () => {
  // France moves to summer time on the last Sunday of March 2026 (the 29th).
  assert.equal(offsetAt(Date.UTC(2026, 2, 28, 12), PARIS) / 3600000, 1);
  assert.equal(offsetAt(Date.UTC(2026, 2, 30, 12), PARIS) / 3600000, 2);

  // The same "11:00" names two different instants either side of it.
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 3, day: 27, hours: 11 }, PARIS)).toISOString(),
    '2026-03-27T10:00:00.000Z');
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 3, day: 30, hours: 11 }, PARIS)).toISOString(),
    '2026-03-30T09:00:00.000Z');

  // And back again in October.
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 10, day: 26, hours: 11 }, PARIS)).toISOString(),
    '2026-10-26T10:00:00.000Z');
});

test('a slot is judged against the studio local day, not the UTC one', () => {
  // 23:30 UTC on a Tuesday is already Wednesday 01:30 in Paris — a closed hour.
  const late = { starts_at: '2026-09-01T23:30:00.000Z', ends_at: '2026-09-02T01:30:00.000Z' };
  assert.equal(withinWorkingHours(late.starts_at, late.ends_at, studio), false);
  assert.equal(zonedParts(new Date(late.starts_at).getTime(), PARIS).weekday, 3, 'Wednesday in Paris');

  // Wednesday 09:00 UTC is 11:00 Paris: exactly opening time.
  assert.equal(withinWorkingHours('2026-09-02T09:00:00.000Z', '2026-09-02T13:00:00.000Z', studio), true);
  // A session running past closing is refused even though it starts inside.
  assert.equal(withinWorkingHours('2026-09-02T15:00:00.000Z', '2026-09-02T19:00:00.000Z', studio), false);
});

test('slots land on open days, inside the window, after the lead time', () => {
  // Wednesday 26 August 2026, 09:00 UTC.
  const from = Date.UTC(2026, 7, 26, 9);
  const slots = availableSlots(studio, { durationHours: 4, from, limit: 8 });

  assert.ok(slots.length > 0);
  for (const slot of slots) {
    const parts = zonedParts(new Date(slot.starts_at).getTime(), PARIS);
    assert.ok(DEFAULT_WORKING_HOURS[parts.weekday].open, `${inParis(slot.starts_at)} is a closed day`);
    assert.ok(parts.hours >= 11, `${inParis(slot.starts_at)} is before opening`);
    assert.equal(withinWorkingHours(slot.starts_at, slot.ends_at, studio), true);
    // The 48 h lead time: nobody wants a proposal for tomorrow morning.
    assert.ok(new Date(slot.starts_at).getTime() >= from + 48 * 3600000);
  }
  // Sunday and Monday are closed, so nothing lands on 30 or 31 August.
  assert.ok(!slots.some((s) => ['30', '31'].includes(inParis(s.starts_at).match(/\d+/)?.[0])));
});

test('a booked session and a closed period take their slots off the table', () => {
  const from = Date.UTC(2026, 7, 26, 9);
  const free = availableSlots(studio, { durationHours: 4, from, limit: 4 });
  const first = free[0];

  const withBusy = availableSlots(studio, {
    durationHours: 4, from, limit: 4,
    busy: [{ starts_at: first.starts_at, ends_at: first.ends_at }],
  });
  assert.ok(!withBusy.some((s) => s.starts_at === first.starts_at), 'the taken slot is gone');

  // A whole week closed pushes everything past it.
  const holiday = availableSlots(studio, {
    durationHours: 4, from, limit: 3,
    busy: [{ starts_at: '2026-08-26T00:00:00.000Z', ends_at: '2026-09-07T00:00:00.000Z' }],
  });
  assert.ok(new Date(holiday[0].starts_at).getTime() >= Date.parse('2026-09-07T00:00:00.000Z'));
});

test('a piece longer than the working day gets no slot rather than a wrong one', () => {
  const slots = availableSlots(studio, { durationHours: 10, from: Date.UTC(2026, 7, 26, 9) });
  assert.equal(slots.length, 0, '10 h does not fit in an 8 h day');
});

test('malformed opening hours fall back instead of throwing', () => {
  assert.deepEqual(parseWorkingHours('not json'), DEFAULT_WORKING_HOURS);
  assert.deepEqual(parseWorkingHours(null), DEFAULT_WORKING_HOURS);
  assert.deepEqual(parseWorkingHours([{ open: true }]), DEFAULT_WORKING_HOURS, 'a short week is not a week');
  const patched = parseWorkingHours(JSON.stringify(
    Array.from({ length: 7 }, () => ({ open: true, from: '25:00', to: 'nope' })),
  ));
  assert.equal(patched[0].from, '11:00', 'an impossible time falls back to the default');
});

/* ------------------------------------- what the booking page is allowed to say */

test('the public slots endpoint only ever offers open days', async (t) => {
  const { client, shutdown } = await import('./helpers.js');
  after(shutdown); // the helper starts a server on import; give it back at the end
  const { zonedParts } = await import('../src/availability.js');
  const call = client();
  const n = Math.random().toString(36).slice(2, 8);
  await call('POST', '/api/auth/signup', {
    email: `slots-${n}@studio.example`, password: 'motdepasse123', studio_name: `Créneaux ${n}`,
  });
  const shut = { open: false, from: '11:00', to: '19:00' };
  await call('PATCH', '/api/me', {
    timezone: 'Europe/Paris',
    // Tuesday mornings and Saturdays, nothing else.
    working_hours: [shut, shut, { open: true, from: '09:00', to: '12:00' }, shut, shut, shut,
      { open: true, from: '11:00', to: '19:00' }],
  });
  const slug = (await call('GET', '/api/me')).data.artist.slug;

  const { slots, timezone } = (await client()('GET', `/api/public/artists/${slug}/slots?hours=2`)).data;
  assert.equal(timezone, 'Europe/Paris', 'the page is told which clock these are on');
  assert.ok(slots.length, 'an open studio offers something');
  for (const slot of slots) {
    const parts = zonedParts(new Date(slot.starts_at).getTime(), timezone);
    assert.ok([2, 6].includes(parts.weekday),
      `a slot fell on weekday ${parts.weekday}, which the studio is closed`);
    if (parts.weekday === 2) {
      assert.ok(parts.hours >= 9 && parts.hours <= 10, `Tuesday slot at ${parts.hours}h is outside 09:00–12:00`);
    }
  }
});
