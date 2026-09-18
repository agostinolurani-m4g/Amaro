# M4G: immagini responsive e Chi siamo

- **Data**: 2026-09-17
- **Repo**: agostinolurani-m4g/Amaro
- **Workspace**: /Users/agostinolurani/Developer/Amaro
- **Branch**: main
- **Issue**: —
- **Commit**: — (nessun commit in sessione)

## Richiesta

Tirare su il sito M4G in locale e migliorare layout immagini (mobile e desktop), in particolare la pagina Chi siamo con banner e grafica curata.

## Implementato

- Script `scripts/m4g-images.sh` + `m4g_optimize_images.py` (Pillow): varianti WebP 640/1280 in `static/m4g/opt/` e logo Sunbirds 512px.
- `m4g_responsive()` in `m4g_config.py`; immagini beneficiario, merch, menu e sede con srcset.
- CSS `.m4g-figure` (aspect-ratio, focus, banner/product/logo), layout Chi siamo (hero, feature alternate, griglia 4 card).
- 2026-09-18: hero verde più basso; Chi siamo senza blocco Arci Olmi; foto «dove vanno i fondi» allineata alle altre; Dona con testo Gaza Sunbirds; Giornata: chi cucina + link menu.

## Note

- Rigenerare asset: `./scripts/m4g-images.sh` (richiede Pillow nel venv `apps/web`).
- Tutto `/m4g/*` è protetto da password (`M4G_SITE_PASSWORD` o default `zipangulo`). Chi siamo: `/m4g/chi-siamo` (alias `/m4g/beneficiario`).
