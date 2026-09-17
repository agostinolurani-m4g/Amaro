# M4G: bar unificato, pagamenti, password, giornata

- **Data**: 2026-09-17
- **Repo**: agostinolurani-m4g/Amaro
- **Workspace**: /Users/agostinolurani/Developer/Amaro
- **Branch**: main
- **Issue**: —
- **Commit**: `85c2a2a` Ship the password-gated Move for Gaza site with bar cart, payments, and Chi siamo.

## Richiesta

Rimuovere donazione pranzo; Satispay/PayPal + Nexi prominente; unire bar/menu con carrello e banner per consumazione; pagina giornata; cucine ospiti; sito protetto con password zipangulo.

## Implementato

- Password su `/m4g/*` (`m4g_auth.py`, `/m4g/access`), router accesso pubblico separato.
- Rimossa iscrizione/donazione menu pranzo; redirect `/m4g/menu` → `/m4g/bar`.
- Bar & cucina: vendor placeholder, carrello, pagamento con partial Nexi/Satispay/PayPal/IBAN.
- Banner per unità: `consumption_tokens_json`, pagina `/m4g/ordine/{ref}/consumi`, redeem per token.
- Pagina `/m4g/giornata` con orari da config.
- Nav e home aggiornate.
- Checkout non dipende più da Nexi (503 fix); PayPal Pool e Satispay Colletta collegati.
- Togliete scansioni menu dal bar; mappa GPX sotto l'header.
- Home: tolta locandina-bandiera, hero più basso, raccolta fondi spiegata (Nexi sul sito).
- Pagina Chi siamo = edizione 2025 + Gaza Sunbirds (alias /beneficiario).

## Note

- Per Satispay serve `M4G_SATISPAY_LINK` (link Paga con Satispay / QR dal business) oppure `M4G_SATISPAY_TAG`.
- PayPal usa `amaro.bici@gmail.com` (`M4G_PAYPAL_BUSINESS`) o `M4G_PAYPAL_ME`. Confermare che il conto PayPal sia quello.
