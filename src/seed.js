// Demo data: one studio with a realistic week — a full inbox, quotes waiting,
// a booked slot, a completed piece and one no-show so the stats mean something.
// Run with `npm run seed`, log in with demo@inkflow.app / demotattoo.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from './db.js';
import { hashPassword } from './auth.js';
import * as service from './service.js';
import { dispatchDue } from './messages.js';

export const DEMO_EMAIL = 'demo@inkflow.app';
export const DEMO_PASSWORD = 'demotattoo';

const at = (days, hour = 10) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

const BRIEFS = [
  {
    client_name: 'Camille Roy', client_email: 'camille.roy@example.com', client_phone: '+33 6 12 34 56 78',
    description: 'Un serpent enroulé autour d\'une pivoine, avant-bras intérieur, style japonais traditionnel sans couleur.',
    style: 'japonais', placement: 'avant-bras', size_cm: 18, color_mode: 'blackgrey', detail_level: 'high',
    budget_cents: 65000, availability: ['samedi', 'mercredi'], reference_urls: ['https://pin.example/serpent-pivoine'],
  },
  {
    client_name: 'Yanis Belkacem', client_email: 'yanis.b@example.com', client_phone: '+33 7 88 12 09 44',
    description: 'Lettrage fin sur la nuque, prénom de ma fille, environ 6 cm.',
    style: 'fine line', placement: 'cou', size_cm: 6, color_mode: 'linework', detail_level: 'simple',
    budget_cents: 15000, availability: ['vendredi', 'soirée'],
  },
  {
    client_name: 'Léa Fontaine', client_email: 'lea.fontaine@example.com',
    description: 'Manchette florale complète, roses et feuillage, du poignet à l\'épaule, en noir et gris.',
    style: 'botanique', placement: 'bras', size_cm: 45, color_mode: 'blackgrey', detail_level: 'high',
    budget_cents: 40000, availability: ['je suis flexible'],
  },
  {
    client_name: 'Marc Delatte', client_email: 'marc.delatte@example.com', client_phone: '+33 6 44 55 66 77',
    description: 'Recouvrement d\'un ancien tribal sur l\'omoplate par un paysage de montagne.',
    style: 'réalisme', placement: 'dos', size_cm: 25, color_mode: 'blackgrey', detail_level: 'hyperrealism',
    cover_up: true, budget_cents: 90000, availability: ['samedi'],
  },
  {
    client_name: 'Inès Moreau', client_email: 'ines.moreau@example.com',
    description: 'Petit papillon sur les côtes, trait fin, 8 cm environ.',
    style: 'fine line', placement: 'côtes', size_cm: 8, color_mode: 'linework', detail_level: 'medium',
    budget_cents: 20000, availability: ['mardi', 'après-midi'],
  },
  {
    client_name: 'Thomas Nguyen', client_email: 'thomas.nguyen@example.com',
    description: 'Vague d\'Hokusai stylisée sur le mollet, avec un peu de bleu.',
    style: 'japonais', placement: 'mollet', size_cm: 22, color_mode: 'color', detail_level: 'medium',
    budget_cents: 55000, availability: ['jeudi', 'vendredi'],
  },
];

async function resetDemo(db) {
  const existing = await db.get('SELECT id FROM artists WHERE email = ?', [DEMO_EMAIL]);
  if (!existing) return;
  // Cascades are not guaranteed on every backend: clear the children explicitly.
  for (const table of ['messages', 'appointments', 'blocks', 'requests']) {
    await db.run(`DELETE FROM ${table} WHERE artist_id = ?`, [existing.id]);
  }
  await db.run('DELETE FROM artists WHERE id = ?', [existing.id]);
}

async function createDemoArtist(db) {
  const { hash, salt } = hashPassword(DEMO_PASSWORD);
  const info = await db.run(`
    INSERT INTO artists (email, password_hash, password_salt, studio_name, slug, city, bio, styles,
                         hourly_rate_cents, minimum_cents, deposit_percent, cancellation_hours, created_at)
    VALUES (?, ?, ?, 'Atelier Noir', 'atelier-noir', 'Lyon', ?, ?, 13000, 9000, 30, 48, ?)
  `, [
    DEMO_EMAIL, hash, salt,
    'Atelier Noir — japonais traditionnel, blackwork et botanique. Grandes pièces sur plusieurs séances, sur rendez-vous uniquement.',
    JSON.stringify(['japonais', 'blackwork', 'botanique', 'fine line']),
    nowIso(),
  ]);
  return db.get('SELECT * FROM artists WHERE id = ?', [info.lastInsertRowid]);
}

export async function seedDemo() {
  const db = await getDb();
  await resetDemo(db);
  const artist = await createDemoArtist(db);

  const created = [];
  for (const brief of BRIEFS) {
    const { request } = await service.createRequest(artist, { ...brief, is_adult: true });
    created.push(request);
  }

  // 1. Camille: quoted, deposit paid, session coming up.
  await service.sendQuote(artist, created[0].id, {
    price_cents: 62000, proposed_start: at(9, 10), duration_hours: 5,
    note: 'On fait la ligne complète en une séance de 5 h, ombrage sur une seconde si besoin.',
  });
  await service.acceptQuote(created[0].public_token);

  // 2. Yanis: quote sent, waiting on the client.
  await service.sendQuote(artist, created[1].id, {
    price_cents: 14000, proposed_start: at(6, 18), duration_hours: 1.5,
    note: 'Prévoir 1 h 30, on cale la typo ensemble sur place.',
  });

  // 3. Léa: sleeve, budget far under — left in the inbox on purpose.
  // 4. Marc: cover-up quoted with a long first session.
  await service.sendQuote(artist, created[3].id, {
    price_cents: 110000, proposed_start: at(16, 9), duration_hours: 6,
    note: 'Première séance de 6 h pour poser le paysage, deux séances au total.',
  });

  // 5. Inès: went through the whole flow last month, session done.
  await service.sendQuote(artist, created[4].id, { price_cents: 18000, proposed_start: at(-24, 14), duration_hours: 1.5 });
  const ines = await service.acceptQuote(created[4].public_token);
  await service.completeAppointment(artist, ines.appointment.id);

  // 6. Thomas: booked, then never showed up — deposit kept.
  await service.sendQuote(artist, created[5].id, { price_cents: 48000, proposed_start: at(-10, 11), duration_hours: 4 });
  const thomas = await service.acceptQuote(created[5].public_token);
  await service.markNoShow(artist, thomas.appointment.id);

  await service.createBlock(artist, at(30, 0), at(37, 23), 'Convention de Berlin');

  // Anything already due (past confirmations, aftercare) is marked as delivered.
  await dispatchDue();

  return { artist, stats: await service.stats(artist.id) };
}

/** Fills an empty database so a fresh deployment is not a blank page. */
export async function seedIfEmpty() {
  const db = await getDb();
  const { count } = await db.get('SELECT COUNT(*) AS count FROM artists');
  if (count > 0) return false;
  await seedDemo();
  console.log('[seed] empty database — demo studio created');
  return true;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { artist, stats } = await seedDemo();
  console.log('Seed terminé.');
  console.log(`  Studio      : ${artist.studio_name} (/b/${artist.slug})`);
  console.log(`  Connexion   : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Demandes    : ${stats.requests.total} · à traiter : ${stats.pending_replies}`);
  console.log(`  À venir     : ${stats.upcoming.count} séance(s), ${stats.upcoming.deposits_held_cents / 100} € d'acomptes`);
  console.log(`  No-shows    : ${stats.no_shows} (${stats.deposits_kept_cents / 100} € conservés)`);
}
