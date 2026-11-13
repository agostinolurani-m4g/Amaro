# Foto, blog e uscite soci — punti aperti

Branch `sito/foto-blog-uscite` (da `main` @ `3d1ec14`). Cosa è stato fatto: vedi il commit
«Sito: foto, blog e uscite soci gestibili dal gestionale» e `apps/web/CLAUDE.md`.

## Da fare prima del merge

- [ ] **Controllo visivo nel browser**: non è stato fatto (estensione Chrome non collegata).
      Verificate solo via HTTP le risposte 200 e il contenuto delle pagine. Da guardare su PC e su telefono:
      - `/` (sezioni «Dal blog» e striscia «Foto»), `/blog`, `/blog/<slug>`, `/foto`, `/foto/<album>`
        (lightbox: frecce, Esc, swipe), `/area-tesserati#uscite`
      - menu in alto con 2 voci in più: controllare che su telefono vada a capo bene
      - gestionale: `/admin/foto` (trascina foto, album), `/admin/blog` (editor, foto nel testo), «Uscite soci»
- [ ] **`APP_PUBLIC_URL` su Render**: serve per l'immagine di anteprima (`og:image`) quando si
      condivide un articolo o un album. Senza, l'URL assoluto può uscire in `http://`.

## Dopo il deploy

- [ ] Caricare una foto in produzione, riavviare il servizio su Render e controllare che ci sia ancora
      (i file stanno su `/data/uploads/media`, il disco persistente).
- [ ] Backup: le foto sono solo sul disco Render, come i documenti soci. Decidere se serve una copia periodica.

## Problemi già esistenti (non introdotti qui)

- **4 test M4G falliscono** anche su `main` pulito: `test_merch_page_no_delivery_notice`,
  `test_bulk_logistics_email`, `test_bar_legal_and_multi_voucher_codes`, `test_bar_manual_payment_flow`
  (`tests/test_m4g_pages.py`). Da sistemare a parte.
- **`poetry lock` non si risolve**: in `pyproject.toml` `fastapi = "^0.111.0"` è incompatibile con
  `sqladmin = "^0.27.0"` (vuole starlette ≥ 0.50). Render e CI usano `requirements.txt`, quindi oggi non
  blocca nulla, ma `poetry.lock` è fermo. Allineare la versione di fastapi in `pyproject.toml`.

## Limiti noti / idee per dopo

- **Foto HEIC** (iPhone): Pillow non le legge. Dal telefono il browser di solito le converte in JPG da solo;
  caricando un `.heic` dal PC esce un errore chiaro («usa JPG, PNG o WEBP»). Se capita spesso: aggiungere
  `pillow-heif`.
- **Immagini tolte da un articolo** mentre lo si modifica restano sul disco (vengono cancellate solo
  eliminando l'articolo). Poco spazio, ma si può aggiungere una pulizia.
- **Upload molto grandi**: fino a 200 foto per invio, 15 MB l'una; con tante foto pesanti la richiesta
  è lenta. Se serve, caricamento a blocchi lato browser.
- **Eventi**: copertina e foto evento sono ancora URL incollati (si può usare «Copia link» dalla pagina Foto).
  Si potrebbe collegare direttamente un album a un evento.
- **Uscite soci**: per scelta in sola lettura. Eventuale «Partecipo» con elenco presenti in futuro.
- **Ordine delle foto** in un album: per data di caricamento; non c'è ancora il trascina-per-riordinare.
