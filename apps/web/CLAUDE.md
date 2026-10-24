# apps/web — sito Amaro + Move for Gaza (FastAPI)

Entry: `app/main.py` (`app = FastAPI`, ~3300 righe: rotte sito principale + mount + router).
Config: `app/config.py` (pydantic settings, tutte da env). DB: `app/database.py` + `app/models.py` (SQLite, schema auto-migrato all'avvio con `ensure_*_schema` in `main.py` e `m4g_common.py`, niente Alembic: nuova colonna → aggiungerla lì).

## Moduli

| File | Ruolo |
|---|---|
| `main.py` | Home, eventi (`/eventi/{slug}`, iscrizione, lista attesa, GPX), merch, calendario, tesseramento (`/tesseramento*`), area soci (`/area-tesserati*`), documenti, mount `/static` e `/lupo` |
| `models.py` | Modelli SQLAlchemy (eventi, merch, soci, documenti, iscrizioni, M4G…) |
| `nexi.py` | Firma payload Nexi/XPay (pagamenti) + verifica MAC esito; `urlpost` opzionale (usato solo dai tesseramenti → `POST /nexi/notifica` in `main.py`) |
| `ocr.py` | Validazione documenti con Google Cloud Vision (REST) |
| `acsi.py` | Excel ACSI + invio email automatico al tesseramento completo |
| `admin.py` + `admin_templates/` | Pannello `/admin` (sqladmin) |
| `seed.py` | Dati di esempio al primo avvio |
| `m4g_site.py` | Router pubblico `/m4g/*`: iscrizioni bici/corsa/calcio/ingresso, donazioni, merch, bar, QR, voucher |
| `m4g_admin.py` | Gestione/cassa/ordini M4G |
| `m4g_auth.py` | Accesso protetto da password al sito M4G (`M4G_SITE_PASSWORD`, `M4G_SITE_PUBLIC`) |
| `m4g_config.py` | Contenuti/costanti M4G, `M4G_PUBLIC_HOSTS` (rewrite host move-4-gaza.com) |
| `m4g_common.py`, `m4g_cms.py`, `m4g_mail.py`, `m4g_menu.py`, `m4g_qr.py`, `m4g_share.py` | Helper M4G (CMS, email, menu bar, QR, share) |
| `wattlab_auth.py` | `/api/wattlab/login|me|logout|download/*` — JWT per Lupo Ammaro, solo soci con pagamento ok |
| `wattlab_sync.py` | `GET/PUT /api/wattlab/sync` — bundle calendario/profilo/chat su disco `UPLOAD_PATH/wattlab-sync` |
| `wattlab_strava.py` | OAuth Strava + upload FIT (`/api/wattlab/strava/*`) |
| `wattlab_download.py` | Risolve installer (`WATTLAB_RELEASES_DIR`, fallback `releases/wattlab/`) |

## Template e static

- `app/templates/`: sito principale (`base.html`, `home.html`, `membership*.html`, `member_area.html`…) e M4G (`m4g_*.html`, partial `m4g_partials_*.html`, `m4g_macros.html`).
- `app/static/`: `css/`, `js/` (`m4g-*.js`), `m4g/routes/*.gpx`, `lupo/` (**build generata** da `apps/lupo-ammaro`, non editare a mano).

## Test

`tests/test_m4g_pages.py`, `tests/test_wattlab_*.py` — unittest + TestClient.
```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```
Env richiesti in CI: `NEXI_ENDPOINT`, `NEXI_SUCCESS_URL`, `NEXI_FAILURE_URL`, `SESSION_SECRET`, `M4G_SITE_PASSWORD`.

## Deploy

Render (`render.yaml` in root): `pip install -r requirements.txt`; `uvicorn app.main:app`. Disco `/data` → `DATABASE_URL=sqlite:////data/amaro.db`, `UPLOAD_PATH=/data/uploads`. Dipendenze: tenere allineati `requirements.txt` (usato da Render/CI) e `pyproject.toml`.
