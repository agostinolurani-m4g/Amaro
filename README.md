# Sito Amaro – FastAPI edition

Questo repository ospita il sito dell'associazione `Amaro Sport e Cultura` (cartella `apps/web`). FastAPI serve le pagine, Jinja2 gestisce i template e SQLite conserva eventi, merchandising e richieste di tesseramento.

## Struttura del progetto

- `apps/web/app/` – pacchetto FastAPI con routing per `home`, `eventi`, `merch`, `galleria`, `tesseramento` e nuova area soci.
- `apps/web/app/templates/` – pagine Jinja2 (home, area soci, pagamenti Nexi/XPay, galleria).
- `apps/web/app/static/` – CSS e asset serviti con `StaticFiles`.
- `apps/web/app/nexi.py` – helper che firma i payload Nexi/XPay e costruisce il redirect protetto usato per merch e tesseramento.
- `apps/web/app/uploads/` – cartella in cui vengono salvati documenti e immagini caricati dal form di tesseramento.
- `apps/web/requirements.txt` – dipendenze in formato `pip`.
- `apps/web/pyproject.toml` – stack Python (FastAPI, SQLAlchemy, Uvicorn) per `poetry install`.
- `apps/web/amaro.db` – database SQLite creato al primo avvio con eventi e catalogo merch di esempio.

La home è centrata sul logo e l'estetica ora è più chiara e solare (banner senza ombre pesanti).

## Ambiente di sviluppo (Poetry)

1. Installa Python 3.11+ e assicurati che `python` (o `py -3.11`) sia nel `PATH`.
2. Installa Poetry: `pip install --user poetry` oppure segui https://python-poetry.org/docs/.
3. Nel repository:

```powershell
cd apps/web
poetry env use python3.11   # opzionale
poetry install
poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

`requirements.txt` resta disponibile per `pip install -r requirements.txt`.

## Configurazione Nexi/XPay

Imposta le variabili d'ambiente (o nel `.env`):

- `NEXI_MERCHANT_ID`
- `NEXI_API_KEY`
- `NEXI_ENDPOINT` (default `https://int-ecommerce.nexi.it/ecomm/api/checkout`)
- `NEXI_SUCCESS_URL` (default `http://localhost:8000/tesseramento?success=1`)
- `NEXI_FAILURE_URL` (default `http://localhost:8000/tesseramento?failed=1`)

Il modulo `app/nexi.py` costruisce il payload firmato; i template `merch_payment.html` e `/tesseramento/pagamento/{id}` mostrano payload e link di redirect Nexi/XPay.

## Galleria collegata a Google Drive

La pagina `/galleria` può pescare foto direttamente da Drive:

$env:GOOGLE_DRIVE_API_KEY = "AIzaSyD6v121efbXA7fq3_jKJBVu2MUpmUsA4-w"
$env:GOOGLE_DRIVE_EVENTS_FOLDER_ID = "1WThTYrDrkhPB_iq0vDFHuTp8qkyUV2kocd"
$env:GOOGLE_DRIVE_GALLERY_FOLDER_ID = "1rL6k_plJngyoD26b2jQe2aUgVJR3Bdqu"

cd apps/web
poetry run uvicorn app.main:app --reload

Metti le foto nelle cartelle Drive indicate (eventi e galleria generale); la pagina renderizza automaticamente le immagini disponibili.

## Tesseramento, area soci e documenti

- Quota annuale: **50 €**, include assicurazione base e accesso alle attività.
- Per tesserarti servono carta d'identità, tessera sanitaria, certificato medico e pagamento via Nexi/XPay.
- Durante l'invio viene generata una password per l'area soci. È necessaria per accedere a `/area-tesserati` e scaricare i documenti caricati.
- I documenti vengono salvati in `apps/web/app/uploads/` e protetti: il download richiede login con l'account del socio.
- Schema del database aggiornato automaticamente all'avvio (`ensure_member_schema`) per includere i nuovi campi del socio (dati anagrafici, password hash, documenti).

## Deploy

Servono un backend Python attivo e le variabili ambiente configurate. Opzioni economiche compatibili con FastAPI:

1. Railway – piano gratuito con HTTPS, SQLite o PostgreSQL.
2. Render – deploy da GitHub, storage persistente per SQLite.
3. Fly.io – leggero e scalabile, adatto a FastAPI.

Ricorda di esportare anche le variabili Drive e Nexi oltre a `DATABASE_URL`.
