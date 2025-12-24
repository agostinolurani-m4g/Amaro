"""
Mini script di test per il flusso
\"Pagamento semplice - Avvio pagamento\" di Nexi/XPay.

Usa i dati di integrazione che hai fornito
e genera l'HTML di un form <POST> verso DispatcherServlet.
"""

from __future__ import annotations

import datetime
import hashlib
from urllib.parse import urlencode


# Dati di integrazione forniti da Nexi
HTTP_HOST = "localhost:8000"  # cambia se vuoi simulare un dominio diverso
REQUEST_URL = "https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet"
MERCHANT_SERVER_URL = f"https://{HTTP_HOST}/xpay/pagamento_semplice_python/codice_base/"

ALIAS = "ALIAS_WEB_00095990"
CHIAVESEGRETA = "RKFX6HIYS9D1T003OD2LYCEJ5VRN9N86"


def genera_parametri_pagamento(importo_cent: int = 5000) -> dict[str, str]:
    """
    Prepara i parametri per il pagamento semplice.

    importo_cent: importo in centesimi (5000 = 50,00).
    """
    cod_trans = "PS" + datetime.datetime.today().strftime("%Y%m%d%H%M%S")
    divisa = "EUR"
    importo = importo_cent

    mac_str = (
        f"codTrans={cod_trans}"
        f"divisa={divisa}"
        f"importo={importo}{CHIAVESEGRETA}"
    )
    mac = hashlib.sha1(mac_str.encode("utf-8")).hexdigest()

    obbligatori: dict[str, str | int] = {
        "alias": ALIAS,
        "importo": importo,
        "divisa": divisa,
        "codTrans": cod_trans,
        "url": MERCHANT_SERVER_URL + "esito.py",
        "url_back": MERCHANT_SERVER_URL + "annullo.py",
        "mac": mac,
    }

    return {k: str(v) for k, v in obbligatori.items()}


def genera_form_html(importo_cent: int = 5000) -> str:
    """
    Genera una pagina HTML con un form POST
    precompilato verso DispatcherServlet.
    """
    params = genera_parametri_pagamento(importo_cent)

    inputs = "\n".join(
        f'    <input type="hidden" name="{k}" value="{v}" />'
        for k, v in params.items()
    )

    html = f"""<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <title>Test pagamento semplice Nexi</title>
  </head>
  <body onload="document.forms[0].submit()">
    <p>Reindirizzamento a Nexi in corso...</p>
    <form method="post" action="{REQUEST_URL}">
{inputs}
      <noscript>
        <button type="submit">Procedi al pagamento</button>
      </noscript>
    </form>
  </body>
</html>
"""
    return html


if __name__ == "__main__":
    pagina = genera_form_html(5000)
    # Scrive il file nella root del repo per aprirlo da browser
    output_path = "form_pagamento_semplice.html"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(pagina)
    print(f"Creato {output_path}. Aprilo nel browser per testare il pagamento semplice.")

