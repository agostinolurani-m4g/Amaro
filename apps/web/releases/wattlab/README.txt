# Installer Windows di Lupo Ammaro (nome file storico WattLab_*), versionato in git e pubblicato col deploy.
# Dopo `npm run tauri:build` in apps/lupo-ammaro, dalla root esegui:
#   node scripts/copy-wattlab-release.mjs
# poi committa il nuovo WattLab_<versione>_x64-setup.exe. Il sito serve la versione più alta
# tra questa cartella e WATTLAB_RELEASES_DIR (/data/releases/wattlab su Render).
