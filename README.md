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
| Un studio à plusieurs | Page publique commune, agenda partagé, invitations — chaque artiste garde ses demandes, ses tarifs et ses horaires |
| Dates proposées à l'aveugle | Horaires d'ouverture par jour, fuseau du studio, délai minimum : le devis se remplit en cliquant un créneau réellement libre |
| Oublis de rendez-vous | Rappels automatiques J-7, à la limite d'annulation, et J-1 |
| Demandes vues trop tard | L'artiste est prévenu par email à chaque brief et à chaque acompte, avec de quoi trancher sans ouvrir l'app |
| Devis oubliés | Balayage automatique : un devis dépassé libère le créneau, le client et l'artiste sont prévenus |
| Cicatrisation et retours clients | Suivi automatique J+1, J+7, J+30 avec demande de photo cicatrisée |

## Démarrer

```bash
npm run seed     # crée le studio de démo « Atelier Noir » et son historique
npm start        # http://localhost:3000
npm test         # 108 tests (estimation, API, serverless, libSQL, envoi, paiement)
```

Compte de démonstration : **demo@inkflow.app** / **demotattoo**
Page publique de démonstration : <http://localhost:3000/b/atelier-noir>

Le serveur tourne sur `node:http`, `node:sqlite` et `node:crypto`. Une seule
dépendance, `@libsql/client`, et uniquement si vous branchez une base Turso —
sans `INKFLOW_DATABASE_URL`, elle n'est jamais chargée. **Node 22.13+ ou 24.x** (`node:sqlite` n'est utilisable sans
drapeau qu'à partir de 22.13). Volontairement, `package.json` ne contient pas de
champ `engines` : un pin de version y entre en conflit avec le sélecteur Node de
Vercel et fait échouer le build — auquel cas la plateforme continue de servir le
déploiement précédent. La version est donc choisie par l'hébergeur, et si elle est
trop ancienne l'application le dit explicitement au démarrage au lieu de planter.

### Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute |
| `INKFLOW_DB` | `data/inkflow.sqlite` | Fichier SQLite local (`:memory:` accepté) |
| `INKFLOW_DATABASE_URL` | — | URL libSQL/Turso (`libsql://…`). Dès qu'elle est définie, elle remplace le fichier local |
| `INKFLOW_DATABASE_TOKEN` | — | Jeton d'authentification Turso, obligatoire avec une URL `libsql://` |
| `INKFLOW_BASE_URL` | `http://localhost:3000` | URL utilisée dans les liens envoyés aux clients |
| `INKFLOW_QUIET` | — | `1` coupe l'affichage des messages sortants dans la console |
| `INKFLOW_DEMO` | `1` en serverless, sinon `0` | Crée le studio de démonstration si la base est vide |
| `INKFLOW_SERVERLESS` | — | Force le mode serverless (base dans `/tmp`, envoi des rappels au fil du trafic) |
| `INKFLOW_SECRET` | — | Clé de signature des sessions. **Indispensable en serverless** : sans elle chaque instance signe avec sa propre clé et les utilisateurs sont déconnectés au hasard |
| `INKFLOW_MAIL_PROVIDER` | `console` | `resend`, `postmark`, `brevo`, ou `console` (les messages restent dans les logs) |
| `INKFLOW_MAIL_KEY` | — | Clé d'API du fournisseur |
| `INKFLOW_MAIL_FROM` | — | Expéditeur vérifié chez le fournisseur (`no-reply@votre-domaine.fr`) |
| `INKFLOW_MAIL_STREAM` | `outbound` | Postmark uniquement : le stream à utiliser |
| `CRON_SECRET` | — | Protège `/api/cron/dispatch` ; Vercel l'envoie en `Authorization: Bearer` |
| `INKFLOW_PAYMENTS` | `mock` | `stripe` pour encaisser réellement ; `mock` confirme sans rien prélever |
| `STRIPE_SECRET_KEY` | — | Clé secrète Stripe (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | — | Secret de signature du webhook (`whsec_…`) |

## Parcours

1. **L'artiste** crée son studio, règle son prix de référence, son minimum, son pourcentage
   d'acompte, ses horaires d'ouverture et son délai d'annulation, puis met son lien
   `/b/<studio>` en bio.
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

Un tatoueur ne facture pas une horloge : il facture une pièce — sa taille, son
niveau de détail, la couleur, la zone, s'il faut recouvrir quelque chose. Le prix
part donc du **prix de référence** que le studio fixe pour une pièce type
(10 cm, noir, détail moyen) et l'ajuste par les propriétés du projet :

| Propriété | Effet |
| --- | --- |
| Taille | courbe lisse, ×1 à 10 cm, ×2,3 à 18 cm, ×6,1 à 40 cm |
| Niveau de détail | ×0,7 (simple) à ×2 (hyperréalisme) — le facteur le plus lourd |
| Rendu | ×0,85 (ligne seule) à ×1,35 (couleur) |
| Zone | jusqu'à ×1,3 (côtes, mains, cou, visage…) |
| Recouvrement | ×1,4 |

`prix = max(minimum studio, référence × facteurs)`, jamais en dessous du minimum.
La fourchette s'élargit avec le travail (±12 % sur une petite pièce, ±23 % sur
une grosse) : une fourchette étroite sur un long projet est une promesse
intenable. La durée reste calculée, mais elle ne sert plus qu'à découper les
séances et à situer le rendez-vous — elle ne fait pas le prix.

Le client voit le détail du calcul sur sa page de réservation : la pièce de
référence, puis chaque propriété avec son effet en pourcentage. Un chiffre sans
explication ne se discute pas, et ne se croit pas non plus. Les facteurs sont
arrondis **avant** d'être multipliés, pas après : un client qui refait le calcul
avec les nombres affichés doit retomber sur le prix affiché, sinon le détail
n'explique rien, il décore.

### La courbe de taille

Deux versions précédentes se sont trompées, chacune à sa manière.

Des **paliers** d'abord : à une frontière, un centimètre changeait le prix de
moitié, et à l'intérieur d'un palier quatre centimètres ne changeaient rien.

Puis une **table d'ancrages reliés par des segments**, ce qui rendait le prix
continu mais pas sa pente. Le coût d'un centimètre supplémentaire sautait à
chaque ancrage franchi — 12,5 % à 5 cm, 20 % à 6 cm, 8,7 % à 15 cm, 12 % à
16 cm. Le client qui déplaçait le curseur sentait le prix s'emballer puis caler
sans rien voir qui l'explique. Pire : les ancrages, choisis à la main, impliquaient
un exposant qui oscillait entre 0,44 et 1,63 d'un segment à l'autre.

La forme retenue est celle que la chose a vraiment :

```
poids = 0,4 + taux × taille^1,5
```

un terme fixe — l'installation, le stencil, la séance elle-même, ce qui fait
qu'une toute petite pièce n'est jamais presque gratuite — plus un travail qui
croît plus vite que la longueur (il remplit une surface) et moins vite que la
surface (une grande pièce comporte proportionnellement plus de vide). Le taux est
**dérivé**, pas saisi, pour que la courbe passe exactement par la pièce de
référence : un arrondi à cet endroit reparamétrerait silencieusement tous les
studios déjà configurés. Les tests interdisent toute réaccélération de la pente.

Les studios configurés avant ce changement gardent exactement leurs prix : leur
pièce de référence vaut ce que leur taux horaire facturait pour elle.

## Cycle de vie d'une demande

Un projet se termine de cinq façons, et ce ne sont pas les mêmes :

```
nouvelle → devis envoyé → réservée → terminée
                │            │
                │            ├─ annulée   (acompte versé, séance décommandée)
                │            └─ no-show   (acompte versé, client absent)
                ├─ refusée   (l'artiste ne prend pas le projet)
                └─ expirée   (le devis a dépassé sa validité)
```

Les trois derniers états ont chacun le leur. Confondre « annulée » et « refusée »
— ce que le produit faisait — fait mentir la boîte de réception et fausse le taux
de conversion, puisqu'un client qui a payé son acompte y était compté comme un
projet décliné. Un no-show laissé en « réservée » rendait la liste des séances à
venir impossible à vider.

La conversion compte **toute demande arrivée jusqu'à l'acompte**, quoi qu'il se
soit passé ensuite : l'argent a bougé.

## L'heure affichée est celle du studio

Une séance a lieu quelque part, à l'heure de cet endroit. C'est donc la seule
horloge qui compte, et elle vaut pour toutes les surfaces : les emails, le
tableau de bord, la page de suivi du client, et jusqu'aux champs `datetime-local`
— sinon un artiste en déplacement bloque les mauvaises heures.

Quand le lecteur est dans un autre fuseau, on le lui dit plutôt que de le laisser
deviner. Le décalage annoncé est celui **en vigueur le jour concerné**, pas le
jour de l'envoi : une séance réservée en août pour fin décembre à Montréal est en
UTC-5, pas en UTC-4. Le bandeau du tableau de bord, lui, couvre un agenda entier
— donc il nomme le lieu et tait le décalage, puisqu'une liste à cheval sur un
changement d'heure en a deux.

## Studios à plusieurs

Un compte confondait autrefois l'artiste, le studio et la page de réservation.
Les trois sont séparés : chaque compte possède un studio — un studio d'une seule
personne pour un artiste solo — et le propriétaire peut y inviter jusqu'à
**six artistes**, ce que vend la page de tarifs.

Ce qui se partage et ce qui ne se partage pas est le cœur du modèle :

| Partagé | Propre à chaque artiste |
| --- | --- |
| La page publique `/s/<studio>` | Les demandes et les échanges avec les clients |
| L'agenda du studio (qui tatoue quoi, quand) | Les tarifs, les horaires, le fuseau |
| L'abonnement | La page de réservation `/b/<artiste>` et son lien |

Un collègue qui lirait votre négociation avec un client serait une fonction que
personne n'a demandée.

Les invitations partent par email, sont à usage unique et expirent au bout de
quatorze jours ; une invitation en attente occupe une place, sinon six invitations
rempliraient un studio de six. Retirer un artiste ne supprime rien : il repart
avec ses réservations, ses clients et son historique, à la tête d'un studio à lui.

### Statistiques par artiste

Le tableau du studio suit la même ligne que le reste. Le **volume** se partage —
demandes reçues, conversion, taux de no-show, heures déjà réservées — parce que
l'agenda se partage déjà, et qu'un studio incapable de lire sa propre charge ne
peut pas organiser sa semaine. L'**argent** par artiste ne s'affiche que pour le
propriétaire, plus sa propre ligne pour chacun : le propriétaire paie la facture,
et personne d'autre n'a besoin de lire les recettes d'un collègue.

## Disponibilités

Le studio déclare sa semaine (sept jours, ouvert/fermé et une plage horaire), son
fuseau et un délai minimum avant le premier créneau proposé. De là, `/api/slots`
sort les créneaux où une séance de la durée voulue tient réellement : jour
ouvert, dans la plage, libre de toute séance et de tout congé.

Le composeur de devis les affiche : l'artiste clique une date au lieu d'en taper
une et de découvrir le conflit après. Proposer un créneau hors horaires reste
possible, mais devient un acte délibéré — le serveur refuse tant que l'exception
n'est pas confirmée.

Le client les voit aussi. Le brief demandait « quand êtes-vous disponible ? » sur
une liste de jours écrite en dur, si bien qu'un studio fermé le lundi recevait des
demandes proposant le lundi. Les choix sont maintenant construits à partir de la
semaine publiée du studio, et découpés en demi-journées seulement là où la plage
horaire les couvre vraiment : ouvert le mardi de 9 h à 12 h, on propose le mardi
matin et pas le mardi après-midi. Les prochains créneaux réels sont affichés en
dessous — ceux de la première séance, pas du projet entier, puisqu'une pièce de
neuf heures n'a aucun créneau de neuf heures.

Les horaires sont des heures locales, le stockage est en UTC, et les deux ne
coïncident pas deux fois par an : la conversion demande au fuseau quel était son
décalage **à cet instant précis** plutôt que d'en supposer un. Le dernier
dimanche de mars, 11 h à Paris n'est pas l'instant qu'il était la veille, et les
tests le vérifient dans les deux sens.

## Vérifier ce que les tests ne voient pas

`npm test` tient les données honnêtes et ne dit rien de ce qu'une personne
regarde. `npm run verify:browser` ouvre les vraies pages dans un vrai navigateur,
sur un serveur qui tourne, et vérifie trois choses qu'un test côté serveur ne
peut structurellement pas voir : qu'aucune page ne déborde d'un téléphone, que
rien ne lève d'exception dans la console, et que les heures à l'écran sont celles
du studio et non celles du lecteur.

```sh
npm start &
npm run verify:browser          # INKFLOW_VERIFY_URL pour viser ailleurs
```

Il se crée son propre studio de test, à Montréal, et lit les pages depuis un
navigateur réglé sur Paris. C'est lui qui a trouvé le tableau de bord qui
débordait de 58 px sur chacun de ses onglets, et une séance de décembre étiquetée
avec le décalage d'août. Ni l'un ni l'autre ne faisait échouer un test.

## Architecture

```
start.js         point d'entrée serveur : écoute, sans condition
api/index.js     point d'entrée serverless (+ api/ping.js, sonde inerte)
src/
  server.js      routage HTTP et pages statiques (bibliothèque, n'écoute pas)
  db.js          interface de données asynchrone : node:sqlite ou libSQL/Turso
  routes/api.js  endpoints JSON (auth, public, boîte artiste, agenda, stats)
  service.js     règles métier : devis, acompte, agenda, no-show, statistiques
  pricing.js     moteur d'estimation (pur, testé isolément)
  availability.js horaires d'ouverture, fuseau, créneaux et rendu des dates
  studio.js      studios à plusieurs : membres, invitations, agenda, statistiques
  messages.js    file d'envoi : confirmations, rappels, cicatrisation
  payments.js    acomptes : Stripe Checkout + vérification de signature, ou mock
  mailer.js      envoi réel : Resend, Postmark, Brevo, ou console
  auth.js        PBKDF2 + sessions en cookie HttpOnly
public/          landing, connexion, tableau de bord, réservation, devis, studio, invitation
test/            tests d'estimation et parcours API de bout en bout
verify/          contrôle navigateur : débordement mobile, console, heures affichées
```

Points d'attention côté sécurité et intégrité :

- mots de passe en PBKDF2-SHA512 (120 000 itérations) ;
- sessions en cookie `HttpOnly`/`SameSite=Lax` signées en HMAC-SHA256 : elles ne
  dépendent d'aucun état serveur, donc une requête servie par une autre instance
  reste authentifiée. La clé vient de `INKFLOW_SECRET` — jamais d'une valeur
  publique comme le SHA du commit, qui permettrait de forger une session ;
- chaque requête artiste est filtrée par `artist_id` — un studio ne peut pas lire la boîte d'un autre ;
- toutes les entrées passent par `src/validate.js`, montants en centimes entiers ;
- chevauchements de créneaux et périodes bloquées vérifiés côté serveur, pas seulement dans l'UI ;
- les messages sont écrits en base avant envoi : un redémarrage ne perd aucun rappel.

## Déployer

### Vercel (démo)

**Preset recommandé : « Other ».** Les pages sont servies par le CDN depuis
`public/`, et `api/index.js` traite `/api/*` comme fonction serverless. C'est la
configuration que `vercel.json` décrit et que les tests couvrent.

Le preset « Node » (Vercel lance `npm start` et proxifie vers votre serveur) n'a
pas fonctionné sur ce projet : le serveur n'était jamais démarré et toute route
dynamique renvoyait `FUNCTION_INVOCATION_FAILED`, y compris une fonction inerte.
Les réécritures de `vercel.json` envoient donc les pages vers les fichiers
statiques, ce qui garde l'interface debout quel que soit le preset ; seul
`/api/*` dépend du mode choisi.

**Contrat d'entrée de la plateforme.** Vercel choisit son point d'entrée par le
nom de fichier — `src/server.js` l'emporte sur le champ `main` — puis **importe**
le module et exige un **export par défaut** qui soit un handler ou un serveur.
Sans lui : `Invalid export found in module … The default export must be a function
or server`, sortie en statut 1 à chaque requête, et une page de crash vide pendant
que le CDN continue de servir les fichiers statiques. `src/server.js` et `start.js`
exportent donc `handleRequest` par défaut — c'est structurel, pas cosmétique.

Une réécriture peut transmettre à la fonction sa destination plutôt que le chemin
demandé par le visiteur. `vercel.json` passe donc le chemin d'origine
explicitement (`?__path=…`) et le routeur le rétablit, sinon toutes les routes
ressembleraient à `/api/index`.

Aucune dépendance, aucun build : `vercel --prod` suffit, ou un import du dépôt
depuis l'interface Vercel.

Deux réglages à ne pas rater à la création du projet :

- **Production Branch** = la branche importée, sinon les pushs ne produisent que
  des déploiements *preview* et l'URL de production continue de servir le tout
  premier déploiement.
- **`INKFLOW_BASE_URL`** = l'URL publique du projet, pour que les liens envoyés
  aux clients (suivi de demande, devis) pointent au bon endroit.
- **`INKFLOW_SECRET`** = une longue chaîne aléatoire. Sans elle, chaque instance
  signe les sessions avec sa propre clé et le tableau de bord renvoie
  « Authentication required » dès qu'une requête change d'instance.

Rappel sur la « Deployment Protection » : sur une URL de *preview*, Vercel affiche
sa propre page **Authentication Required** (redirection vers `vercel.com/sso-api`).
Ce n'est pas l'application — utilisez l'URL de production, ou désactivez la
protection dans les réglages du projet.

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
| `/build.json` | le commit construit, la branche, l'heure du build | 404 : le build n'a pas tourné — regardez les Build Logs |
| `/deploy-check.txt` | le marqueur de déploiement | 404 : ce commit n'est pas en production |
| `/api/ping` | `{"probe":"function"}` ou `{"probe":"app"}` avec le commit déployé | Ni l'un ni l'autre : Vercel ne construit pas `api/` — vérifier Framework Preset (« Other ») et Root Directory du projet |
| `/api/health` | `status: ok`, version de Node, base utilisée | Rapport d'erreur JSON : l'application démarre mal, le message dit pourquoi |
| `/b/atelier-noir` | La page de réservation du studio de démonstration | 500 : voir `/api/health` |

`/api/ping` répond `"probe":"function"` quand Vercel sert via `api/index.js`, et
`"probe":"app"` quand il exécute l'application comme serveur Node. Les deux modes
fonctionnent ; le champ `commit` indique quel commit est réellement en ligne.

#### Si la fonction renvoie une erreur

Rien n'est ouvert pendant le démarrage : le serveur écoute d'abord, la base est
créée à la première requête. Un processus qui meurt au boot ne peut rien dire —
la plateforme affiche une page de crash vide — alors qu'un serveur qui écoute peut
répondre la raison. Toute panne (built-in manquant, disque non inscriptible,
bundle incomplet) renvoie donc un rapport JSON exploitable, sur chaque requête et
dans les deux modes de déploiement, au lieu de `FUNCTION_INVOCATION_FAILED` :

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

### Base durable : Turso

`src/db.js` expose une interface asynchrone unique avec deux implémentations :
`node:sqlite` sur un fichier local, et libSQL/Turso par le réseau. Aucune autre
partie du code ne sait laquelle répond.

```bash
turso db create inkflow                 # une fois
turso db show inkflow --url             # → libsql://inkflow-<vous>.turso.io
turso db tokens create inkflow          # → le jeton
```

Puis, en variables d'environnement (Vercel → Settings → Environment Variables) :

```
INKFLOW_DATABASE_URL   = libsql://inkflow-<vous>.turso.io
INKFLOW_DATABASE_TOKEN = <le jeton>
INKFLOW_SECRET         = <une longue chaîne aléatoire>
INKFLOW_BASE_URL       = https://<votre-domaine>
```

Le schéma est créé au premier démarrage. Pour peupler la base de démonstration :

```bash
INKFLOW_DATABASE_URL=… INKFLOW_DATABASE_TOKEN=… npm run seed
```

`GET /api/health` indique alors `"backend": "turso"` et `"ephemeral": false`.
Prévoir aussi un Vercel Cron qui appelle `/api/messages/dispatch` pour que les
rappels partent sans dépendre du trafic.

**Ce qui est vérifié et ce qui ne l'est pas.** `test/turso.test.js` fait tourner
tout le parcours sur le client libSQL (même client, URL `file:`) : liaison des
paramètres, forme des lignes, identifiants renvoyés par une écriture, et
relecture après fermeture puis réouverture de la connexion. Le trajet réseau vers
Turso, lui, n'est pas testé ici — il n'y a pas de credentials dans ce dépôt, et
un test qui passerait sans les avoir ne prouverait rien.

### Envoi des emails

Sans `INKFLOW_MAIL_PROVIDER`, rien ne quitte la machine : les messages sont
écrits dans les logs. Pour envoyer réellement, trois variables suffisent :

```
INKFLOW_MAIL_PROVIDER = resend          # ou postmark, ou brevo
INKFLOW_MAIL_KEY      = <clé d'API>
INKFLOW_MAIL_FROM     = no-reply@votre-domaine.fr
```

L'expéditeur doit être **vérifié chez le fournisseur** (domaine authentifié) —
sinon l'envoi est refusé et l'erreur remonte telle quelle dans le tableau de bord.
Le client voit le nom du studio comme expéditeur et peut répondre directement à
l'artiste : le `reply-to` porte son adresse.

Les adresses en domaine réservé (`example.com`, `.test`, `.invalid` — RFC 2606 et
6761) ne sont jamais envoyées dès qu'un fournisseur réel est configuré : aucun
serveur ne les accepte, et les rebonds durs coûtent cher à un domaine d'envoi
neuf. Elles sont retirées de la file avec un motif lisible. En mode `console`,
elles restent affichées dans les logs — c'est ce qu'on veut en développement.

Un message n'est marqué comme envoyé que si le fournisseur l'a accepté. En cas
d'échec, la raison est conservée, la tentative comptée, et le message repasse au
tour suivant — jusqu'à cinq fois, après quoi il est abandonné plutôt que réessayé
indéfiniment. L'onglet **Messages** affiche ces trois états (envoyé, nouvel essai,
abandonné) : un rappel qui n'est pas parti se voit.

**Déclenchement.** En serverless, la file est vidée à l'occasion du trafic (une
passe par minute et par instance) et par un cron quotidien déclaré dans
`vercel.json` (`/api/cron/dispatch`, 8 h UTC). Les offres Hobby de Vercel ne
descendent pas sous une exécution par jour ; sur un plan supérieur, passez la
planification à `0 * * * *`. Définissez `CRON_SECRET` pour que l'endpoint
n'accepte que l'appel du planificateur.

### Encaissement des acomptes (Stripe)

Par défaut `INKFLOW_PAYMENTS=mock` : l'acompte est confirmé sans qu'un centime
ne bouge. C'est ce que veulent le développement local, les tests et la démo.

Pour encaisser réellement :

```
INKFLOW_PAYMENTS      = stripe
STRIPE_SECRET_KEY     = sk_live_…
STRIPE_WEBHOOK_SECRET = whsec_…
```

Dans Stripe → Developers → Webhooks, ajoutez un endpoint sur
`https://votre-domaine/api/webhooks/stripe` abonné à `checkout.session.completed`,
puis copiez son secret de signature.

**Le point de conception qui compte.** Accepter un devis n'ouvre qu'une page de
paiement hébergée par Stripe : le créneau reste libre. C'est **le webhook signé
qui bloque la date**, jamais l'URL de retour du navigateur — sinon n'importe qui
réserverait un créneau en forgeant `?paid=1`. Les coordonnées bancaires ne
transitent donc jamais par ce serveur.

Trois conséquences prises en charge explicitement :

- **Rejeu** — Stripe rejoue un webhook non acquitté ; une seconde livraison ne
  crée pas un second rendez-vous.
- **Montant** — un montant qui ne correspond pas au devis est refusé.
- **Créneau pris entre-temps** — l'argent est arrivé, la date ne peut plus être
  donnée : rien n'est réservé en double, l'artiste et le client sont prévenus,
  et l'artiste tranche entre nouvelle date et remboursement.

Les échecs de webhook répondent `200` avec la raison : un `4xx` ferait rejouer
Stripe indéfiniment sur un problème qu'un rejeu ne corrige pas.

### Autre chemin : une machine avec un disque

Railway, Fly.io, Render ou un VPS : `npm start` avec un disque persistant monté
sur `data/`. Le processus est long, le planificateur tourne à la minute, et il
n'y a rien à configurer de plus.

Variables utiles au déploiement : `INKFLOW_DB` (chemin de la base),
`INKFLOW_BASE_URL` (liens envoyés aux clients), `INKFLOW_DEMO=0` (désactive la
création automatique du studio de démonstration).

## Passer en production

- **SMS** : `src/mailer.js` ne fait que l'email ; un transport Twilio suivrait le même contrat
  (une fonction qui envoie ou qui lève).
- **Planificateur** : le tick d'une minute suffit pour un serveur unique ; sur plusieurs instances,
  déplacer `dispatchDue()` dans un worker avec un verrou.
- **Uploads** : les références sont aujourd'hui des URLs ; un stockage objet (S3/R2) permettrait
  l'envoi direct de photos.
