# Server Amaro WattLab

Backend locale/pronto per produzione che gestisce:

- autenticazione tesserati (`/api/wattlab/*`)
- download installer riservato (`/api/wattlab/download/*`)
- classifica sessioni WattLab (`/api/wattlab/leaderboard`, `POST /api/wattlab/sessions`)
- coach AI (`POST /api/wattlab/coach/chat`, default **Ollama** locale; opzionale API OpenAI-compatible)
- portale web tesserati (`/tesserati/wattlab/`)

## Avvio

```bash
npm run server:dev
```

Variabili opzionali: copia `server/.env.example` in `server/.env`.

## Integrazione produzione

1. Sostituisci `server/members.json` con query al database tesserati Amaro (email, password hash, stato tessera).
2. Imposta `WATTLAB_JWT_SECRET` con un segreto forte.
3. Pubblica il server dietro HTTPS (es. `https://api.amaro.it`).
4. Aggiorna `.env` dell'app desktop:
   - `VITE_AMARO_API_URL=https://api.amaro.it`
   - `VITE_AMARO_DOWNLOAD_URL=https://www.amaro.it/tesserati/wattlab`
5. Dopo ogni release: `npm run release:build` e carica l'installer in `server/releases/`.

Il link al portale va inserito nell'area tesserati del sito Amaro (menu riservato post-login).
