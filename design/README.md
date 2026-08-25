# Directions de design

Sources des planches publiées sur le canevas Inkflow — Directions animées.

Un seul système retenu — professionnel, orienté outil — décliné sur les trois
surfaces qui comptent pour un SaaS B2C.

| Fichier | Surface | Rôle |
| --- | --- | --- |
| `Main.dc.html` | Vitrine | Prolonge les tokens de `public/assets/app.css` (`#0c0d10`, accent `#ff5c39`, rayons 14/9 px). Le motif qui se trace est le seul moment décoratif ; la barre du bas rassure au lieu de défiler. |
| `Reservation.dc.html` | Client | La surface B2C : brief, fourchette visible en permanence, acompte annoncé avant d'être demandé, conditions affichées avant paiement. Zones cliquables ≥ 46 px. |
| `Dashboard.dc.html` | Artiste | L'outil payé au mois : chiffres, file de demandes avec l'écart de budget signalé, agenda de la semaine. |
| `canvas.json` | — | Deux pages : « Le produit » et « Pistes écartées ». |

Écartées, gardées comme trace sur la seconde page :

| Fichier | Direction | Pourquoi écartée |
| --- | --- | --- |
| `Flash.dc.html` | B — Planche de flash | Le mode clair oblige à refaire tout le tableau de bord, et des prix fixes ne couvrent pas le sur-mesure. |
| `Neon.dc.html` | C — Néon nocturne | Glitch et grésillement décrédibilisent l'écran où l'on verse 300 € d'acompte. |

Chaque planche expose un réglage `motion` (`ample` / `calme`) et respecte
`prefers-reduced-motion` : l'ambiance s'arrête, le dessin reste visible.

Règle d'animation du système retenu : le mouvement explique un état (une étape
qui se remplit, un montant qui se recalcule, une case qui se coche). Pas de
grain qui scintille, pas de glitch, pas de bandeau défilant — une interface de
paiement n'a pas le droit d'avoir l'air instable.

La page assemblée (`inkflow-directions-animees.html`, ~2,5 Mo) n'est pas versionnée :
elle se régénère à partir de ces fichiers.
