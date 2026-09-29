# Dominio www.move-4-gaza.com su Render

Il sito Move for Gaza vive su `https://www.amarobici.it/m4g/` (iscrizioni, Nexi, bar, merch, donazioni). `www.move-4-gaza.com` e `move-4-gaza.com` rispondono con un redirect 301 verso quella stessa app (`/` → `/m4g/`, `/bici` → `/m4g/bici`).

## Render

1. Apri il service **amaro-web** su [Render](https://dashboard.render.com).
2. **Settings → Custom Domains** → aggiungi `www.move-4-gaza.com`.
3. (Opzionale) Aggiungi `move-4-gaza.com` e abilita redirect verso `www`.
4. Attendi verifica SSL (Let's Encrypt).

## DNS (registrar del dominio)

Rimuovi il record CNAME verso `agostinolurani-m4g.github.io` (GitHub Pages).

| Host | Tipo | Valore |
|------|------|--------|
| `www` | CNAME | `amaro-mkil.onrender.com` (o il hostname indicato da Render) |
| `@` | A/ALIAS | come da istruzioni Render per apex |

Propagazione DNS: fino a 24–48 ore.

## GitHub Pages (repo Move4Gaza)

Dopo il cutover DNS, disattiva Pages sul repo `Move4Gaza` (workflow rimossi / CNAME rimosso) per evitare conflitti.

## Verifica

```bash
curl -sI -H "Host: www.move-4-gaza.com" https://www.amarobici.it/ | head -5
# In locale:
curl -s -H "Host: www.move-4-gaza.com" http://127.0.0.1:8000/ | head -20
```

Controlla che asset GPX rispondano: `/static/m4g/routes/rideforgaza112.gpx`.
