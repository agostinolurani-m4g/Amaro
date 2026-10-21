# Amaro — mappa del repo

Monorepo dell'associazione **Amaro Sport e Cultura** (amarobici.it). Lingua di UI, commenti e commit: **italiano**.
Ambiente dev: Windows + PowerShell (usare `;` non `&&` in PowerShell 5).

## Cosa c'è

| Path | Cosa | Stack |
|---|---|---|
| `apps/web/` | Sito amarobici.it + sito Move for Gaza (`/m4g`) + API tesserati per Lupo Ammaro | FastAPI, Jinja2, SQLAlchemy, SQLite |
| `apps/lupo-ammaro/` | App allenamento "Lupo Ammaro" (desktop Tauri + web mobile `/lupo/`) + server Node dev con coach AI | React 19, Vite, Tauri 2 (Rust), Express |
| `scripts/` | `copy-wattlab-release.mjs` (installer → `apps/web/releases/wattlab/`), ottimizzazione immagini M4G | Node / Python / sh |
| `docs/M4G-DOMAIN.md` | DNS/redirect `move-4-gaza.com` → `/m4g/` | — |
| `render.yaml` | Deploy Render: solo `apps/web`, runtime Python, disco `/data` | — |
| `.github/workflows/ci.yml` | CI: solo unittest di `apps/web` | — |

Ogni app ha il suo `CLAUDE.md` con la mappa dettagliata.

## Come si collegano

- **Produzione = solo `apps/web`** su Render. Il build Render NON compila il frontend.
- Lupo Ammaro web: `cd apps/lupo-ammaro; npm run build:web` scrive in `apps/web/app/static/lupo/` → **va committato** (servito su `/lupo/`).
- Lupo Ammaro desktop: `npm run tauri:build` poi `node scripts/copy-wattlab-release.mjs`; scaricato dai tesserati da `/area-tesserati#wattlab`.
- API usate dall'app: `/api/wattlab/*` (nome storico "WattLab", NON rinominare: gli installer distribuiti le chiamano).
  - In prod (Python): login/me/logout, download, `sync` (GET/PUT), Strava.
  - Coach AI `/api/wattlab/coach/*`: esiste **solo** nel server Node `apps/lupo-ammaro/server/`, non in `apps/web`.

## Comandi rapidi

```powershell
# Sito
cd apps/web; poetry run uvicorn app.main:app --reload --port 8000
cd apps/web; python -m unittest discover -s tests -p "test_*.py" -v

# Lupo Ammaro
cd apps/lupo-ammaro; npm run dev          # vite :1420, proxy /api → :8000
cd apps/lupo-ammaro; npm run server:dev   # server Node :8000 (coach)
cd apps/lupo-ammaro; npm run dev:all      # server Node + Tauri dev
```

⚠️ Server Node e FastAPI usano entrambi la porta **8000**: avviarne uno solo (o cambiare `PORT`).

## Regole

- Non committare: `node_modules/`, `dist/`, `.env`, `*.db`, `uploads/`, `src-tauri/target/`, token Strava (già in `.gitignore`).
- Segreti solo da env (`.env.example` in `apps/web/`, `apps/lupo-ammaro/`, `apps/lupo-ammaro/server/`).
- Storico sessioni precedenti (Cursor): `.cursor/session-log/`.
