# Encre & Papier

Sources des planches publiées sur le canevas **Encre et Papier** — trois
directions artistiques proposées après la première série (`design/`), avec une
contrainte de plus : que ça ne sente pas la machine.

Le point de départ est le contraire du produit actuel (fond `#0c0d10`, accent
`#ff5c39`, sans-serif système) et ce à quoi ressemble un tatoueur au travail :
il vit dans du papier — planches de flash, calques, carnets.

| Fichier | Surface | Rôle |
| --- | --- | --- |
| `Main.dc.html` | Client | La piste proposée, sur l'écran de réservation. **Vivante** : la taille, le détail et le rendu recalculent le prix, la fourchette, les heures et l'acompte avec les formules réelles de `src/pricing.js` et `src/duration.js`. |
| `Atelier.dc.html` | Artiste | La même direction sur le tableau de bord. Un beau formulaire ne dit rien de la densité que demande un outil ouvert dix fois par jour. |
| `BleuDeTravail.dc.html` | Piste B | Cyanotype : bleu de Prusse, ocre, grille de tracé visible, libellés en chasse fixe. |
| `Carnation.dc.html` | Piste C | Terre cuite et sauge sur blanc chaud, aucune bordure — l'espace fait la structure. |
| `canvas.json` | — | Disposition et pastilles : chacune porte la motivation d'une piste **et** ce qu'elle coûte. |

## Le système retenu (piste A)

| Rôle | Valeur |
| --- | --- |
| Papier | `#F7F2E8`, surface `#FDFBF6` |
| Encre | `#221E18`, atténuée `#5E5649`, discrète `#8A7F6A` |
| Filet | `#DCD1B9` |
| Oxblood | `#8E3B2F` — ce qui demande une action |
| Bleu de Prusse | `#1F6570` — ce qui va bien |
| Titres | Bodoni Moda (repli Didot, Times) |
| Texte | Archivo (repli system-ui) |

Règles qui font la différence entre « artistique » et « généré » : des filets
d'un cheveu au lieu de cartes, des numéros de planche et des marques de
repérage d'imprimeur, des chiffres tabulaires en serif. Aucun dégradé, aucun
emoji, aucun coin arrondi, aucune police par défaut de framework.

## Régénérer

La page assemblée (`encre-et-papier.html`, ~2,5 Mo) n'est pas versionnée : elle
se régénère depuis ces fichiers. Elle reste à la racine du dépôt parce que
l'adresse de l'artefact publié est liée à ce chemin — la republier depuis un
autre chemin créerait un second canevas au lieu de mettre celui-ci à jour.
