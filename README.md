# Sito Amaro – FastAPI edition

Questo repository ospita il sito dell'associazione `Amaro Sport e Cultura` dentro `apps/web`. FastAPI serve le pagine, Jinja2 gestisce i template, e SQLite conserva eventi, merchandising e le richieste di tesseramento.

## Struttura del progetto

- `apps/web/app/` – pacchetto FastAPI con routing per `home`, `eventi`, `merch`, `galleria` e `tesseramento`, plus modelli SQLAlchemy, helper per il database e pagine Jinja2.
- `apps/web/app/nexi.py` – helper che firma i payload Nexi/XPay e costruisce il redirect protetto usato sia per i merch sia per il tesseramento.
- `apps/web/app/uploads/` – cartella in cui vengono salvati documenti e immagini caricati dal form di tesseramento.
- `apps/web/static/` – CSS e asset serviti con `StaticFiles`.
- `apps/web/static/img/logo.svg` – versione vettoriale del logo che domina la home page.
- `apps/web/requirements.txt` – versione “pip only” delle dipendenze, utile fuori da Poetry.
- `apps/web/pyproject.toml` – definisce lo stack Python (FastAPI, SQLAlchemy, Uvicorn) e abilita `poetry install`.
- `apps/web/amaro.db` – database SQLite creato al primo avvio con gli eventi e il catalogo merch di esempio.

La home page è centrata sul logo di Amaro, mentre le altre pagine usano i template presenti in `app/templates`.

## Ambiente di sviluppo (con Poetry)

1. Installa Python 3.11+ e assicurati che il comando `python` (o `py -3.11`) sia nel `PATH`.
2. Installa Poetry: `pip install --user poetry` oppure segui la guida ufficiale su https://python-poetry.org/docs/.
3. Nel repository:

```powershell
cd apps/web
poetry env use python3.11   # opzionale: punta alla versione desiderata
poetry install
poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

L’app gira su `http://localhost:8000`, i template vengono renderizzati da `app/templates` e il CSS da `app/static/css/styles.css`.

> Nota: `requirements.txt` continua a essere disponibile per chi preferisce `pip install -r requirements.txt`.

## Configurazione Nexi/XPay

Imposta le seguenti variabili d’ambiente (o usale nel `.env`):

- `NEXI_MERCHANT_ID`
- `NEXI_API_KEY`
- `NEXI_ENDPOINT` (default `https://int-ecommerce.nexi.it/ecomm/api/checkout`)
- `NEXI_SUCCESS_URL` (default `http://localhost:8000/tesseramento?success=1`)
- `NEXI_FAILURE_URL` (default `http://localhost:8000/tesseramento?failed=1`)

Il modulo `app/nexi.py` costruisce il payload firmato e la firma SHA256 in linea con la sandbox, quindi il template `merch_payment.html` e la nuova pagina `/tesseramento/pagamento/{id}` possono mostrare il payload e il link di redirect verso Nexi/XPay in modo controllato.

## Tesseramento e documenti

Il form di tesseramento chiede nome, cognome, data e luogo di nascita, residenza, codice fiscale, tipo e numero di documento, ID documento, numero della tessera sanitaria, note sul certificato medico e la relativa scadenza. Si possono inoltre caricare documenti e immagini (PDF/JPG/PNG/DOC) che vengono salvati in `apps/web/app/uploads/` e possono essere scaricati in sicurezza dalla pagina di pagamento dedicata (`/tesseramento/pagamento/{id}`).

## Database e persistenza

SQLite (`amaro.db`) viene creato automaticamente alla prima esecuzione (`Base.metadata.create_all`). I modelli `Event`, `MerchItem`, `Member` e `MemberDocument` sono dichiarati in `app/models.py`, e `app/seed.py` popola eventi e merchandising di esempio quando il database è vuoto.

## Deploy

GitHub Pages non può ospitare FastAPI perché serve un backend Python attivo. Le opzioni più economiche e compatibili sono:

1. **Railway** – piano gratuito, HTTPS incluso, puoi usare SQLite o passare a PostgreSQL.
2. **Render (Free Tier)** – deploy automatico da GitHub, storage persistente per SQLite.
3. **Fly.io** – ottimo per app FastAPI leggere, puoi scalare fin da subito.

Ricorda di configurare le variabili ambiente (Nexi, `DATABASE_URL`) e di installare le dipendenze nel tuo ambiente di deploy.
