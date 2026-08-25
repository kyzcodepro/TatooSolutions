# Inkflow

**La réservation qui protège l'agenda des tatoueurs.**

Un tatoueur perd de l'argent à deux endroits : les créneaux qui sautent la veille au soir,
et les heures passées en DM à qualifier des projets qui n'aboutiront jamais. Inkflow s'attaque
aux deux : chaque artiste a un lien de réservation qui pose les bonnes questions, calcule une
fourchette de prix, et n'inscrit une date à l'agenda qu'une fois l'acompte encaissé.

```
brief structuré → estimation automatique → devis + acompte → date bloquée → rappels → cicatrisation
```

## Le produit en un coup d'œil

| Problème du terrain | Ce que fait Inkflow |
| --- | --- |
| No-show à la veille d'une journée de 6 h | Le créneau n'existe qu'après paiement de l'acompte ; l'acompte reste acquis passé le délai d'annulation |
| « Ça coûte combien ? » sans aucun détail | Formulaire de brief : taille, zone, rendu, niveau de détail, cover-up, références, budget, disponibilités |
| Projets hors budget découverts au 3ᵉ message | L'écart entre le budget annoncé et la fourchette est calculé et affiché des deux côtés |
| Doubles réservations, congés oubliés | Chevauchements refusés côté serveur, périodes bloquables |
| Oublis de rendez-vous | Rappels automatiques J-7, à la limite d'annulation, et J-1 |
| Cicatrisation et retours clients | Suivi automatique J+1, J+7, J+30 avec demande de photo cicatrisée |

## Démarrer

```bash
npm run seed     # crée le studio de démo « Atelier Noir » et son historique
npm start        # http://localhost:3000
npm test         # 20 tests (moteur d'estimation + parcours API complet)
```

Compte de démonstration : **demo@inkflow.app** / **demotattoo**
Page publique de démonstration : <http://localhost:3000/b/atelier-noir>

Aucune dépendance à installer : le serveur tourne sur Node 22 (`node:http`, `node:sqlite`, `node:crypto`).

### Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute |
| `INKFLOW_DB` | `data/inkflow.sqlite` | Fichier SQLite (`:memory:` accepté) |
| `INKFLOW_BASE_URL` | `http://localhost:3000` | URL utilisée dans les liens envoyés aux clients |
| `INKFLOW_QUIET` | — | `1` coupe l'affichage des messages sortants dans la console |

## Parcours

1. **L'artiste** crée son studio, règle son taux horaire, son minimum, son pourcentage d'acompte
   et son délai d'annulation, puis met son lien `/b/<studio>` en bio.
2. **Le client** décrit son projet. La fourchette de prix et l'acompte se mettent à jour en direct
   pendant qu'il remplit le formulaire ; un budget irréaliste est signalé avant l'envoi.
3. **L'artiste** voit le brief complet dans sa boîte (estimation, budget, références, disponibilités)
   et envoie un devis ferme avec créneau et acompte.
4. **Le client** ouvre `/q/<jeton>`, accepte et verse l'acompte. C'est seulement à cet instant que
   le créneau est réservé — et un créneau déjà pris est refusé.
5. **Inkflow** envoie confirmation puis rappels, et bascule sur le suivi de cicatrisation une fois
   la séance marquée terminée. Un no-show est enregistré, l'acompte conservé, et le taux de no-show
   remonte dans les statistiques.

## Moteur d'estimation

`src/pricing.js` traduit un brief en heures puis en fourchette de prix :

- heures de base par palier de taille (0,75 h à 5 cm → 12 h et plus au-delà de 40 cm) ;
- multiplicateurs de niveau de détail (0,8 à 1,7) et de rendu (0,85 à 1,3) ;
- majoration des zones difficiles (côtes, mains, cou, genoux… jusqu'à ×1,3) ;
- +40 % pour un recouvrement ;
- prix = `max(minimum studio, heures × taux horaire)`, fourchette −10 % / +15 % arrondie à 5 € ;
- séances découpées par tranches de 6 h, acompte au pourcentage du studio.

Le but n'est pas d'être exact au centime : c'est de donner une fourchette honnête et de trier
les projets hors budget avant d'y passer une heure.

## Architecture

```
src/
  server.js      routage HTTP, pages statiques, tick du planificateur
  routes/api.js  endpoints JSON (auth, public, boîte artiste, agenda, stats)
  service.js     règles métier : devis, acompte, agenda, no-show, statistiques
  pricing.js     moteur d'estimation (pur, testé isolément)
  messages.js    file d'envoi : confirmations, rappels, cicatrisation
  payments.js    interface de paiement (mock ; Stripe se branche ici)
  auth.js        PBKDF2 + sessions en cookie HttpOnly
  db.js          schéma SQLite et migrations
public/          landing, connexion, tableau de bord, page de réservation, page de devis
test/            tests d'estimation et parcours API de bout en bout
```

Points d'attention côté sécurité et intégrité :

- mots de passe en PBKDF2-SHA512 (120 000 itérations), sessions en cookie `HttpOnly`/`SameSite=Lax` ;
- chaque requête artiste est filtrée par `artist_id` — un studio ne peut pas lire la boîte d'un autre ;
- toutes les entrées passent par `src/validate.js`, montants en centimes entiers ;
- chevauchements de créneaux et périodes bloquées vérifiés côté serveur, pas seulement dans l'UI ;
- les messages sont écrits en base avant envoi : un redémarrage ne perd aucun rappel.

## Passer en production

- **Paiements** : remplacer `src/payments.js` par Stripe (PaymentIntent + webhook signé) en gardant
  la même interface ; l'acompte n'est validé qu'après confirmation du webhook.
- **Emails / SMS** : remplacer `defaultTransport` dans `src/messages.js` par Postmark, Brevo ou Twilio.
- **Planificateur** : le tick d'une minute suffit pour un serveur unique ; sur plusieurs instances,
  déplacer `dispatchDue()` dans un worker avec un verrou.
- **Uploads** : les références sont aujourd'hui des URLs ; un stockage objet (S3/R2) permettrait
  l'envoi direct de photos.
