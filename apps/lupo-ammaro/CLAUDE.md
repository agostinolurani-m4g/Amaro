# apps/lupo-ammaro — Lupo Ammaro (ex WattLab)

App di allenamento ciclismo per i tesserati: rulli smart via BLE (FTMS), workout ERG, calendario/piano, coach AI, bike fit da video, classifica.
Nome pubblico **Lupo Ammaro**; nel codice restano `wattlab` (package, API `/api/wattlab/*`, installer `WattLab_*.exe`) — non rinominare.

Un unico frontend React gira in due modi (`src/lib/runtime.ts → isTauri()`):
- **Desktop Tauri**: BLE, registrazione sessione, FIT, storage locale via `invoke(...)` Rust.
- **Web mobile** (`/lupo/` su amarobici.it): niente BLE; storage browser (`browserStorage.ts`) + sync server.

## Struttura

| Path | Ruolo |
|---|---|
| `src/App.tsx` | Shell, auth, navigazione a stato `screen` (tipo `Screen` in `src/types.ts`: connect, live, summary, profile, workouts, calendar, today, leaderboard, coach, history, lab, fit) |
| `src/pages/` | Una pagina per screen (`LiveRidePage`, `CalendarPage`/`MobileCalendarPage`, `CoachPage`, `FitPage`, `LabPage`…) + `LoginPage`, `MembershipBlockedPage` |
| `src/components/` | Grafici (uPlot: `PowerChart`, `SessionSeriesChart`, `WorkoutProfileChart`, `ClimbProfileChart`, `CoachChart`; tema in `lib/chartTheme.ts`), `AppNav` + `NavIcon`, card coach, `FitVideoReview` |
| `src/hooks/` | `useBle` (Tauri BLE), `useCoach`, `useStrava`, `useStorage`, `useLeaderboard`, `useMobileShell` |
| `src/lib/` | Logica client: `amaroAuth` (login/fetch API), `syncClient`/`syncMerge` (sync bundle server), `*Store.ts` (persistenza), `coach*` (briefing, proposte, piano), `workoutEngine`, `trainingZones`, `sessionStats/Evaluation`, `climb*` (modello salite, dati in `src/data/climbs/*.json`) |
| `src/lib/fit/` | Bike fit: MediaPipe pose → angoli → cicli pedalata → QC → regole (`analyzeVideo.ts` orchestra) |
| `src/styles/` | `global.css`, `training.css`, `fit.css`, `login.css` (CSS puro, niente framework) |
| `shared/engine/*.mjs` | Motore condiviso client+server: carico/PMC (`load`), fisiologia, planner, predictor, generatore workout, sport, date |
| `shared/knowledge/*.md` + `index.mjs` | Base di conoscenza allenamento (italiano) usata dal coach |
| `server/` | Express dev/backend locale: `index.mjs` (rotte `/api/wattlab/*` + `/health`), `auth.mjs` (JWT), `coach.mjs` (agente con tool), `coachTools.mjs`, `llm.mjs` (Ollama / Anthropic / OpenAI-compatibile), `strava*.mjs`, `syncStore.mjs`, `webSearch.mjs` |
| `src-tauri/src/` | Rust: `ble/` (scan, FTMS, controllo potenza), `session/` (recorder, `fit_writer`), `storage/` + `storage_commands.rs`, `strava/`, `commands.rs`; comandi registrati in `lib.rs` |
| `scripts/` | `build-web.mjs` (build → `../web/app/static/lupo`, base `/lupo/`), `run-tauri.mjs`, `dev-all.mjs`, `free-vite-port.mjs` (libera :1420 su Windows), `check-text.mjs`, `fetch-climb-profiles.mjs`, `copy-release.mjs` |

## Comandi

```powershell
npm run dev          # libera :1420 e avvia vite (proxy /api → 127.0.0.1:8000)
npm run server:dev   # server Node su :8000 (coach AI)
npm run dev:all      # server Node + Tauri dev
npm run build        # tsc + vite build (dist/)
npm run build:web    # tsc --noEmit + build in apps/web/app/static/lupo  → COMMITTARE l'output
npm run tauri:build  # installer Windows
npm run check:text   # controlla testi/encoding
```
Nessun test automatico: verificare con `npx tsc --noEmit` e prova manuale.

## Note / gotcha

- Il coach AI (`/api/wattlab/coach/*`) esiste solo nel server Node; il backend Python di produzione ha login, sync e Strava ma **non** il coach.
- LLM configurato da `server/.env` (`LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`…); default Ollama locale.
- Env frontend: `VITE_AMARO_API_URL`, `VITE_AMARO_DOWNLOAD_URL` (`.env.example`).
- Testi UI in italiano; attenzione a mojibake (UTF-8) — usare `lib/textFix.ts` / `check:text`.
- Nuovo comando Rust: implementarlo e aggiungerlo a `generate_handler!` in `src-tauri/src/lib.rs`, più permessi in `src-tauri/capabilities/default.json` se serve.
