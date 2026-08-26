// How long a piece actually takes, which is not the same question as what it costs.
//
// Duration used to be the price weight rounded to a quarter of an hour. That is
// convenient and wrong: it asserts that anything costing 35 % more takes 35 %
// longer. Colour does cost more and does take longer, but not by the same amount;
// a difficult placement costs more mostly because it is unpleasant, and takes
// longer for a different reason again; and heavy black fill is cheap per hour and
// slow per square centimetre. One number cannot answer both questions.
//
// The figures below are fitted to what studios publish about their own work,
// listed at the bottom of this file. They are a starting point a studio should
// correct with its own numbers, not a law.

/**
 * Needle hours for the reference piece: 10 cm, medium detail, black & grey.
 * Published ranges put a piece that size at one to three hours in the chair,
 * which is this plus the setup below.
 */
const BASE_HOURS = 1.25;
const REFERENCE_SIZE_CM = 10;

/**
 * Time grows with size more slowly than area does.
 *
 * Doubling the longest dimension quadruples the surface but nowhere near
 * quadruples the hours: a large piece is read from further away, uses broader
 * strokes, and carries open skin between its elements. Fitting the published
 * anchors — a 25 cm forearm panel at 2–5 h, a 55 cm back piece at 12–20 h, a
 * 75 cm leg sleeve at 16–30 h — lands on an exponent of about 1.5, which is also
 * the shape the price curve takes, for the same underlying reason.
 */
const SIZE_EXPONENT = 1.5;

/**
 * Stencil, placement, prep and breaks — per session, and not per project.
 *
 * Studios put stencil placement alone at 20–30 minutes and setup at 15–45, and
 * say plainly that an appointment runs at least an hour longer than the needle
 * time. A four-session back piece pays this four times. Leaving it out is why a
 * 90-minute booking used to run past two hours.
 *
 * It scales a little with the piece, because stencilling a 5 cm design is not
 * stencilling a back: 30 minutes at the small end, an hour at the large.
 */
export function setupHours(sizeCm) {
  const size = Math.max(1, Number(sizeCm) || 1);
  return Math.min(1, Math.max(0.5, 0.4 + 0.02 * size));
}

/** What actually gets booked, setup included. Studios cap the chair at 6–8 h. */
export const MAX_SESSION_HOURS = 6;

/**
 * Detail is the heaviest factor by far, and heavier for time than for price.
 * A palm-sized piece that takes two hours in a traditional style is quoted at
 * six to eight as photorealism — three to four times over, which is what the
 * span from "medium" to "hyperréalisme" reproduces here.
 */
const DETAIL_TIME = { simple: 0.55, medium: 1, high: 1.7, hyperrealism: 3.2 };

/**
 * Rendering, relative to black & grey.
 *
 * Colour is repeatedly put at 20–40 % more time than the same design in black
 * and grey: packing solid colour and keeping saturation even takes more passes.
 * Bold black work moves faster than tonal grey shading, which needs several
 * passes to build depth. Line work lays the least ink of all — it is slower per
 * square centimetre of ink than bold work, but there is far less of it.
 */
const COLOR_TIME = { linework: 0.7, blackwork: 0.85, blackgrey: 1, color: 1.3 };

/**
 * Placement, for time rather than for price.
 *
 * These two rankings are not the same list. Ribs cost more mostly because they
 * hurt; hands cost a little more and take twice as long, because the skin moves,
 * heals badly and needs reworking as you go — a piece that runs 90 minutes on an
 * upper arm is quoted at three hours on the hand.
 */
const PLACEMENT_TIME = [
  ['finger', 2], ['doigt', 2], ['hand', 2], ['main', 2],
  ['armpit', 1.7], ['aisselle', 1.7], ['foot', 1.7], ['pied', 1.7],
  ['throat', 1.5], ['gorge', 1.5], ['neck', 1.5], ['cou', 1.5],
  ['face', 1.5], ['visage', 1.5], ['head', 1.5], ['tête', 1.5],
  ['elbow', 1.4], ['coude', 1.4], ['knee', 1.4], ['genou', 1.4],
  // Ribs, sternum and stomach cost more because they hurt, not because they are
  // slow: published sternum pieces sit at 2–4 h, the same as anywhere else that
  // size. Only a light premium here, for the breaks the client will need.
  ['rib', 1.3], ['côte', 1.3], ['sternum', 1.15],
  ['stomach', 1.15], ['ventre', 1.15], ['spine', 1.15], ['colonne', 1.15],
  ['ankle', 1.15], ['cheville', 1.15],
];

/** A cover-up is put at 25–50 % more work: reading the old ink, then burying it. */
const COVER_UP_TIME = 1.35;

const round2 = (n) => Math.round(n * 100) / 100;
const roundQuarter = (h) => Math.max(0.25, Math.round(h * 4) / 4);

export function placementTimeFactor(placement = '') {
  const text = String(placement).toLowerCase();
  let worst = 1;
  for (const [needle, factor] of PLACEMENT_TIME) {
    if (text.includes(needle) && factor > worst) worst = factor;
  }
  return worst;
}

/** How the size alone stretches the work, 1 at the reference piece. */
export function sizeTimeFactor(sizeCm) {
  const size = Math.max(1, Number(sizeCm) || 1);
  return (size / REFERENCE_SIZE_CM) ** SIZE_EXPONENT;
}

/**
 * @param {object} brief  size_cm, detail_level, color_mode, placement, cover_up
 * @returns {{needle_hours, chair_hours, session_hours, sessions, setup_hours, factors}}
 *   needle_hours   time the machine is running, across the whole project
 *   chair_hours    what the client is actually in the studio for, setup included
 *   session_hours  length of the first appointment — what goes in the diary
 */
export function duration(brief = {}) {
  const factors = [
    { key: 'size', label: `Taille ${Math.round(Number(brief.size_cm) || 0)} cm`, factor: sizeTimeFactor(brief.size_cm) },
    { key: 'detail', label: 'Niveau de détail', factor: DETAIL_TIME[brief.detail_level] ?? 1 },
    { key: 'color', label: 'Rendu', factor: COLOR_TIME[brief.color_mode] ?? 1 },
    { key: 'placement', label: 'Zone', factor: placementTimeFactor(brief.placement) },
    { key: 'cover_up', label: 'Recouvrement', factor: brief.cover_up ? COVER_UP_TIME : 1 },
  ].map((item) => ({ ...item, factor: round2(item.factor) }));

  const needle = roundQuarter(
    factors.reduce((total, item) => total * item.factor, BASE_HOURS),
  );

  // Sessions are counted on needle time, then each one is charged its own setup.
  const setup = setupHours(brief.size_cm);
  const sessions = Math.max(1, Math.ceil(needle / Math.max(0.5, MAX_SESSION_HOURS - setup)));
  const chair = roundQuarter(needle + sessions * setup);
  const sessionHours = roundQuarter(Math.min(chair / sessions, MAX_SESSION_HOURS));

  return {
    needle_hours: needle,
    chair_hours: chair,
    session_hours: sessionHours,
    sessions,
    setup_hours: round2(setup),
    // Only what actually moved the number: "Zone ×1" explains nothing.
    factors: factors.filter((item) => item.factor !== 1 || item.key === 'size'),
  };
}

/*
 * Where the numbers come from — replace them with the studio's own as soon as it
 * has any. Every anchor below is chair time, setup included.
 *
 *   up to 5 cm, simple ................  15–45 min
 *   5–15 cm, some detail ..............  1–3 h
 *   forearm panel (~25 cm), blackwork .  2–5 h+
 *   sternum (~20 cm) ..................  2–4 h
 *   chest (~35 cm) ....................  4–6 h+
 *   thigh, one side (~30 cm) ..........  3–5 h+
 *   full sleeve (~55 cm) ..............  12–16 h+
 *   full back (~55 cm) ................  12–20 h+
 *   full leg sleeve (~75 cm) ..........  16–30 h+
 *   palm-sized photorealistic portrait   6–8 h (2 h in a traditional style)
 *   hand vs upper arm, same piece .....  3 h vs 1.5 h
 *   colour vs black & grey ............  +20–40 %
 *   cover-up vs fresh .................  +25–50 %
 *   stencil and setup, per session ....  20–45 min
 *   one sitting, comfortable / ceiling .  4–6 h / 8–9 h
 */
