# Lupo Ammaro

App desktop (Tauri) e web coach/calendario per i tesserati Amaro. Il nome visibile è **Lupo Ammaro**; le API restano su `/api/wattlab/*` per compatibilità con gli installer già distribuiti.

## Sviluppo locale

```bash
cd apps/lupo-ammaro
npm install
npm run dev:all
```

Imposta `VITE_AMARO_API_URL` verso il backend Amaro (locale o produzione).

## Build installer Windows

```bash
npm run tauri:build
node ../../scripts/copy-wattlab-release.mjs
```

Vedi anche il README principale del repo Amaro, sezione Lupo Ammaro.
