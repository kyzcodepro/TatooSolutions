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
npm test         # 29 tests (estimation, parcours API complet, chemin serverless)
```

Compte de démonstration : **demo@inkflow.app** / **demotattoo**
Page publique de démonstration : <http://localhost:3000/b/atelier-noir>

Aucune dépendance à installer : le serveur tourne sur `node:http`, `node:sqlite`
et `node:crypto`. **Node 22.13+ ou 24.x** (`node:sqlite` n'est utilisable sans
drapeau qu'à partir de 22.13). Volontairement, `package.json` ne contient pas de
champ `engines` : un pin de version y entre en conflit avec le sélecteur Node de
Vercel et fait échouer le build — auquel cas la plateforme continue de servir le
déploiement précédent. La version est donc choisie par l'hébergeur, et si elle est
trop ancienne l'application le dit explicitement au démarrage au lieu de planter.

### Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute |
| `INKFLOW_DB` | `data/inkflow.sqlite` | Fichier SQLite (`:memory:` accepté) |
| `INKFLOW_BASE_URL` | `http://localhost:3000` | URL utilisée dans les liens envoyés aux clients |
| `INKFLOW_QUIET` | — | `1` coupe l'affichage des messages sortants dans la console |
| `INKFLOW_DEMO` | `1` en serverless, sinon `0` | Crée le studio de démonstration si la base est vide |
| `INKFLOW_SERVERLESS` | — | Force le mode serverless (base dans `/tmp`, envoi des rappels au fil du trafic) |

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
start.js         point d'entrée serveur : écoute, sans condition
api/index.js     point d'entrée serverless (+ api/ping.js, sonde inerte)
src/
  server.js      routage HTTP et pages statiques (bibliothèque, n'écoute pas)
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

## Déployer

### Vercel (démo)

**Preset « Node » (recommandé).** Vercel exécute `npm start`, votre serveur reçoit
toutes les routes, et le planificateur tourne comme en local. Rien à configurer :
`vercel.json` ne contient que quatre réécritures vers des pages statiques
(`/login`, `/app`, `/b/:slug`, `/q/:token`), sans effet sur ce mode puisqu'elles
servent exactement les mêmes fichiers que le serveur.

**Preset « Other » (mode fonction).** `api/index.js` sert alors de point d'entrée.
Ajoutez dans ce cas la réécriture attrape-tout et l'embarquement des pages :

```json
{
  "functions": { "api/index.js": { "includeFiles": "public/**" } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
}
```

Ne mettez jamais les deux configurations en même temps : avec le preset Node,
l'attrape-tout détourne tout le trafic vers une fonction, et un bloc `functions`
qui ne correspond à aucune fonction construite fait échouer le build.

Aucune dépendance, aucun build : `vercel --prod` suffit, ou un import du dépôt
depuis l'interface Vercel.

Deux réglages à ne pas rater à la création du projet :

- **Production Branch** = la branche importée, sinon les pushs ne produisent que
  des déploiements *preview* et l'URL de production continue de servir le tout
  premier déploiement.
- **`INKFLOW_BASE_URL`** = l'URL publique du projet, pour que les liens envoyés
  aux clients (suivi de demande, devis) pointent au bon endroit.

> **Attention — les données ne survivent pas.** Une fonction serverless n'a qu'un
> `/tmp` accessible en écriture, propre à chaque instance et effacé à chaque cold
> start. Sur Vercel, Inkflow ouvre donc sa base dans `/tmp` et recrée le studio de
> démonstration quand elle est vide : le site est consultable et le parcours complet
> fonctionne, mais **une réservation prise sur ce déploiement peut disparaître**.
> C'est une vitrine, pas un environnement de production.

#### Vérifier un déploiement en trois URL

Commencez toujours par `/deploy-check.txt` : ce fichier statique est servi par le
CDN, sans faire tourner la moindre fonction. **404 = le commit n'est pas déployé**
(build en échec, mauvaise branche de production, ou autre projet) et le problème
est dans les logs de build, pas dans le code. 200 = le code est bien en ligne, et
les deux URL suivantes disent ce qu'il fait.

| URL | Réponse attendue | Ce que dit une autre réponse |
| --- | --- | --- |
| `/deploy-check.txt` | le marqueur de déploiement | 404 : ce commit n'est pas en production |
| `/api/ping` | `{"probe":"function"}` ou `{"probe":"app"}` avec le commit déployé | Ni l'un ni l'autre : Vercel ne construit pas `api/` — vérifier Framework Preset (« Other ») et Root Directory du projet |
| `/api/health` | `status: ok`, version de Node, base utilisée | Rapport d'erreur JSON : l'application démarre mal, le message dit pourquoi |
| `/b/atelier-noir` | La page de réservation du studio de démonstration | 500 : voir `/api/health` |

`/api/ping` répond `"probe":"function"` quand Vercel sert via `api/index.js`, et
`"probe":"app"` quand il exécute l'application comme serveur Node. Les deux modes
fonctionnent ; le champ `commit` indique quel commit est réellement en ligne.

#### Si la fonction renvoie une erreur

`api/index.js` n'importe l'application qu'à l'intérieur du handler. Toute panne au
chargement (built-in manquant, disque non inscriptible, bundle incomplet) renvoie
donc un rapport JSON exploitable — au lieu de la page `FUNCTION_INVOCATION_FAILED`
qui n'explique rien :

```json
{
  "error":   { "name": "...", "message": "...", "code": "...", "stack": ["..."] },
  "runtime": { "node": "v22.x", "region": "arn1", "commit": "44db53e" },
  "checks":  { "node_sqlite": "ok", "tmp_writable": "ok", "cwd_writable": "no: EROFS",
               "public_readable": "ok" },
  "env_set": ["VERCEL"]
}
```

`runtime.commit` indique quel commit est réellement déployé — utile quand le crash
vient d'un déploiement antérieur au correctif. Le rapport ne contient que des noms
de variables d'environnement, jamais leurs valeurs.

Quand le déploiement démarre correctement, `GET /api/health` donne la version de
Node, le fichier de base utilisé, s'il est éphémère, et le nombre de messages en
attente.

Le planificateur ne peut pas tourner en tâche de fond dans une fonction : en mode
serverless, les messages dus sont envoyés à l'occasion du trafic (une passe par
minute et par instance au maximum). Sans visiteurs, les rappels attendent.

### Déploiement durable

Deux chemins, au choix :

1. **Garder SQLite et une vraie machine** — Railway, Fly.io, Render ou un VPS :
   `npm start` avec un disque persistant monté sur `data/`. C'est le mode pour
   lequel l'application est écrite (processus long, planificateur à la minute) et
   c'est le moins de travail.
2. **Rester sur Vercel avec une base gérée** — remplacer `src/db.js` par un client
   Turso/libSQL (dialecte SQLite, le schéma est repris tel quel) ou Neon/Postgres.
   Le reste du code passe par `getDb()`, la bascule est donc contenue dans ce fichier
   et dans les appels `prepare/run/get/all`. Prévoir aussi un Vercel Cron qui appelle
   `/api/messages/dispatch` pour que les rappels partent sans dépendre du trafic.

Variables utiles au déploiement : `INKFLOW_DB` (chemin de la base),
`INKFLOW_BASE_URL` (liens envoyés aux clients), `INKFLOW_DEMO=0` (désactive la
création automatique du studio de démonstration).

## Passer en production

- **Paiements** : remplacer `src/payments.js` par Stripe (PaymentIntent + webhook signé) en gardant
  la même interface ; l'acompte n'est validé qu'après confirmation du webhook.
- **Emails / SMS** : remplacer `defaultTransport` dans `src/messages.js` par Postmark, Brevo ou Twilio.
- **Planificateur** : le tick d'une minute suffit pour un serveur unique ; sur plusieurs instances,
  déplacer `dispatchDue()` dans un worker avec un verrou.
- **Uploads** : les références sont aujourd'hui des URLs ; un stockage objet (S3/R2) permettrait
  l'envoi direct de photos.
