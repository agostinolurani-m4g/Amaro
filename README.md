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
- `NEXI_ENDPOINT` (default `https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet`)
- `NEXI_SUCCESS_URL` (default `http://localhost:8000/tesseramento?success=1`)
- `NEXI_FAILURE_URL` (default `http://localhost:8000/tesseramento?failed=1`)

Il modulo `app/nexi.py` costruisce i parametri per il pagamento semplice Nexi/XPay; i template `merch_payment.html` e `/tesseramento/pagamento/{id}` mostrano i parametri usati e il form per il redirect verso Nexi/XPay.

## Galleria collegata a Google Drive

La pagina `/galleria` può pescare foto direttamente da Drive:

cd apps/web
poetry run uvicorn app.main:app --reload

Metti le foto nelle cartelle Drive indicate (eventi e galleria generale); la pagina renderizza automaticamente le immagini disponibili.

## Tesseramento, area soci e documenti

- Quota annuale: **50 €**, include assicurazione base e accesso alle attività.
- Per tesserarti servono carta d'identità, tessera sanitaria, certificato medico e pagamento via Nexi/XPay.
- Durante l'invio viene generata una password per l'area soci. È necessaria per accedere a `/area-tesserati` e scaricare i documenti caricati.
- I documenti vengono salvati in `apps/web/app/uploads/` e protetti: il download richiede login con l'account del socio.
- Schema del database aggiornato automaticamente all'avvio (`ensure_member_schema`) per includere i nuovi campi del socio (dati anagrafici, password hash, documenti).

## Gestione database (admin UI)

Per gestire dati e tabelle da un'interfaccia web:

1. Imposta le credenziali in `apps/web/.env`:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=cambia-questa-password
```

2. Avvia l'app e visita `http://127.0.0.1:8000/admin` per accedere al pannello.

## OCR documenti (Google Cloud Vision)

L'OCR usa **Google Cloud Vision** via API REST: funziona sul **runtime Python nativo** di Render, senza Docker né Tesseract.

Circa **1000 immagini/mese gratuite** (per ~200 tesseramenti/anno sei ampiamente dentro il free tier).

### Configurazione Google Cloud

1. Crea un progetto su [Google Cloud Console](https://console.cloud.google.com/).
2. Abilita **Cloud Vision API**.
3. Crea una **API key** (APIs & Services → Credentials → Create API key).
4. Aggiungi in `apps/web/.env` (e su Render → Environment):

```
GOOGLE_VISION_API_KEY=la-tua-chiave-api
```

Opzionale: limita la chiave solo a Cloud Vision API e al dominio/IP del sito.

## Deploy su Render

L'app può girare con **runtime Python** (consigliato): niente Docker obbligatorio.

### Configurazione servizio

1. **Root Directory:** `apps/web`
2. **Build Command:** `pip install -r requirements.txt`
3. **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. **Persistent Disk** montato su `/data` (1 GB)
5. Variabili d'ambiente:

```
DATABASE_URL=sqlite:////data/amaro.db
UPLOAD_PATH=/data/uploads
GOOGLE_VISION_API_KEY=...
SESSION_SECRET=<stringa-lunga-random>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password-sicura>
NEXI_MERCHANT_ID=...
NEXI_API_KEY=...
NEXI_ENDPOINT=https://ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet
NEXI_SUCCESS_URL=https://<tuo-dominio>/tesseramento?success=1
NEXI_FAILURE_URL=https://<tuo-dominio>/tesseramento?failed=1
```

6. **Manual Deploy** dopo il push su GitHub.

Il file [`render.yaml`](render.yaml) e il [`Dockerfile`](apps/web/Dockerfile) restano disponibili come alternativa, ma non sono necessari per l'OCR.

### Validazione live

Dopo la configurazione di `GOOGLE_VISION_API_KEY`, la verifica documenti funziona in tempo reale sui form di tesseramento e area soci.

### Invio automatico ad ACSI

Quando un socio ha **pagamento ok**, documenti verificati (CI e tessera validi; certificato medico almeno non rifiutato) e i tre allegati richiesti, il sistema invia automaticamente ad ACSI una email con:

- Excel `acsi_tesseramento.xlsx` compilato (anagrafica, discipline, consensi)
- Cartella documenti del socio (CI, tessera sanitaria, certificato medico)

Variabili Render:

```
ACSI_NOTIFY_EMAIL=email@acsi.it
SMTP_HOST=...
SMTP_FROM=...
```

Template Excel: `apps/web/app/static/files/Modello_tesseramento_ACSI_NUOVO.xlsx`

Dopo l'invio, il campo `acsi_submitted_at` sul socio evita invii duplicati.
