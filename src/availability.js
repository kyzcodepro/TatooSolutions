// Opening hours, and the slots that follow from them.
//
// A studio's hours are wall-clock local ("mardi 11h–19h"); everything stored is
// UTC. Converting between the two is where this kind of feature quietly breaks:
// on the last Sunday of March, 11:00 in Paris is not the same instant it was the
// day before. So the conversion asks the platform's timezone database what the
// offset actually was at that moment, rather than assuming one.

export const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

/** Closed Sunday and Monday, 11–19 otherwise: a common studio week, and only a default. */
export const DEFAULT_WORKING_HOURS = [
  { open: false, from: '11:00', to: '19:00' },
  { open: false, from: '11:00', to: '19:00' },
  { open: true, from: '11:00', to: '19:00' },
  { open: true, from: '11:00', to: '19:00' },
  { open: true, from: '11:00', to: '19:00' },
  { open: true, from: '11:00', to: '19:00' },
  { open: true, from: '11:00', to: '19:00' },
];

export const DEFAULT_TIMEZONE = 'Europe/Paris';
const SLOT_STEP_MINUTES = 30;

export function parseWorkingHours(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return DEFAULT_WORKING_HOURS;
  }
  if (!Array.isArray(parsed) || parsed.length !== 7) return DEFAULT_WORKING_HOURS;
  return parsed.map((day, index) => ({
    open: Boolean(day?.open),
    from: isTime(day?.from) ? day.from : DEFAULT_WORKING_HOURS[index].from,
    to: isTime(day?.to) ? day.to : DEFAULT_WORKING_HOURS[index].to,
  }));
}

export const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** What the zone's offset from UTC actually was at that instant, in milliseconds. */
export function offsetAt(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asIfUtc - utcMs;
}

/**
 * A wall-clock time in a zone to the instant it names.
 * Two passes: the first guess uses the offset at the wrong moment, which matters
 * exactly on the days a clock change makes this worth doing at all.
 */
export function zonedToUtc({ year, month, day, hours = 0, minutes = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hours, minutes);
  const firstPass = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(firstPass, timeZone);
}

/** The calendar date, in the studio's zone, of a given instant. */
export function zonedParts(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  );
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
    weekday: weekdayIndex,
  };
}

/** Is this instant inside the studio's opening hours for that day? */
export function withinWorkingHours(startsAt, endsAt, { workingHours, timeZone }) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const startParts = zonedParts(start, timeZone);
  const day = workingHours[startParts.weekday];
  if (!day?.open) return false;

  const windowStart = zonedToUtc({ ...startParts, hours: Number(day.from.slice(0, 2)), minutes: Number(day.from.slice(3, 5)) }, timeZone);
  const windowEnd = zonedToUtc({ ...startParts, hours: Number(day.to.slice(0, 2)), minutes: Number(day.to.slice(3, 5)) }, timeZone);
  return start >= windowStart && end <= windowEnd;
}

/**
 * The next slots a piece of this length actually fits into.
 *
 * @param {object} studio        workingHours, timeZone, leadHours
 * @param {object} options       durationHours, from, days, busy[], limit, perDay
 */
export function availableSlots({ workingHours, timeZone = DEFAULT_TIMEZONE, leadHours = 48 }, {
  durationHours, from = Date.now(), days = 28, busy = [], limit = 12, perDay = 2,
} = {}) {
  const durationMs = Math.max(0.5, Number(durationHours) || 1) * 3600000;
  // Nobody wants a proposal for tomorrow morning that the client cannot organise.
  const earliest = new Date(from).getTime() + leadHours * 3600000;
  const periods = busy
    .map((item) => [new Date(item.starts_at).getTime(), new Date(item.ends_at).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));

  const slots = [];
  const cursorDate = zonedParts(earliest, timeZone);
  let dayOffset = 0;

  while (slots.length < limit && dayOffset < days) {
    // Midday avoids landing on a clock-change hour while walking days forward.
    const dayAnchor = zonedToUtc({ ...cursorDate, hours: 12, minutes: 0 }, timeZone) + dayOffset * 86400000;
    const anchorParts = zonedParts(dayAnchor, timeZone);
    const day = workingHours[anchorParts.weekday];
    dayOffset += 1;
    if (!day?.open) continue;

    const openMinutes = minutesOf(day.from);
    const closeMinutes = minutesOf(day.to);
    if (closeMinutes - openMinutes < durationMs / 60000) continue;

    const windowStart = zonedToUtc({ ...anchorParts, hours: Math.floor(openMinutes / 60), minutes: openMinutes % 60 }, timeZone);
    const windowEnd = zonedToUtc({ ...anchorParts, hours: Math.floor(closeMinutes / 60), minutes: closeMinutes % 60 }, timeZone);

    let found = 0;
    for (let start = windowStart; start + durationMs <= windowEnd; start += SLOT_STEP_MINUTES * 60000) {
      if (found >= perDay || slots.length >= limit) break;
      if (start < earliest) continue;
      const end = start + durationMs;
      const taken = periods.some(([busyStart, busyEnd]) => start < busyEnd && end > busyStart);
      if (taken) continue;
      slots.push({ starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() });
      found += 1;
      // Spread the offers across the day instead of proposing 11:00 and 11:30.
      start += (durationMs / 60000 - SLOT_STEP_MINUTES) * 60000;
    }
  }
  return slots;
}
