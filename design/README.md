# Directions de design

Sources des planches publiées sur le canevas Inkflow — Directions animées.

| Fichier | Direction | Parti pris |
| --- | --- | --- |
| `Main.dc.html` | A — Encre vivante | Prolonge les tokens de `public/assets/app.css` (`#0c0d10`, accent `#ff5c39`, rayons 14/9 px). Le motif se trace en boucle, l'aiguille suit la ligne. |
| `Flash.dc.html` | B — Planche de flash | Papier, Bodoni, encre oxblood. La planche de flash tient lieu de page, chaque pièce porte son prix ferme. |
| `Neon.dc.html` | C — Néon nocturne | Enseigne au néon, glitch chromatique, sol en perspective. Le plus animé des trois. |
| `canvas.json` | — | Disposition des planches et notes de comparaison. |

Chaque planche expose un réglage `motion` (`ample` / `calme`) et respecte
`prefers-reduced-motion` : l'ambiance s'arrête, le dessin reste visible.

La page assemblée (`inkflow-directions-animees.html`, ~2,5 Mo) n'est pas versionnée :
elle se régénère à partir de ces fichiers.
