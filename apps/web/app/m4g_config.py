"""Configurazione evento Move for Gaza (separata dal sito Amaro)."""

from __future__ import annotations

import os

M4G_PUBLIC_HOSTS = frozenset(
    {
        "www.move-4-gaza.com",
        "move-4-gaza.com",
    }
)


def static_m4g(path: str) -> str:
    return f"/static/m4g/{path.lstrip('/')}"


def m4g_responsive(
    slug: str,
    fallback: str,
    width: int,
    height: int,
    *,
    sizes: str = "(max-width: 768px) 100vw, 36rem",
) -> dict[str, str | int]:
    """Paths for src/srcset; fallback is the original asset under static/m4g/."""
    return {
        "src": static_m4g(fallback),
        "w640": static_m4g(f"opt/{slug}-640.webp"),
        "w1280": static_m4g(f"opt/{slug}-1280.webp"),
        "width": width,
        "height": height,
        "sizes": sizes,
    }


M4G_EVENT = {
    "title": "Move for Gaza",
    "tagline": "Pedala, gioca, corri — insieme per Gaza",
    "date": "17 ottobre 2026",
    "location": "Arci Olmi, via degli Ulivi 2, Milano",
    "contact_email": "amaro.bici@gmail.com",
    "public_site": "https://www.move-4-gaza.com",
    "logo_url": static_m4g("M4G-mix.svg"),
    "poster_url": static_m4g("locandina.png"),
    "arci_olmi_url": static_m4g("arci_olmi.jpeg"),
    "venue_image": m4g_responsive(
        "arci_olmi",
        "arci_olmi.jpeg",
        1500,
        1500,
        sizes="(max-width: 768px) 100vw, 20rem",
    ),
    "beneficiary_name": "Gaza Sunbirds",
    "beneficiary_url": "https://gazasunbirds.org/",
    "donate_url": os.environ.get("M4G_DONATE_URL", "/m4g/donazione"),
    "intro": (
        "Move4Gaza è un evento sportivo non competitivo per raccogliere fondi a sostegno "
        "degli aiuti umanitari a Gaza. Una giornata di sport, comunità e solidarietà attiva: "
        "si pedala, si corre, si gioca a calcio, si mangia e si beve insieme, si ascolta. "
        "Chi non partecipa alle attività sportive può comunque essere presente — o sostenerci "
        "a distanza con una donazione."
    ),
    "beneficiary_story": (
        "Nati nel 2020 per mettere la bicicletta nelle mani di persone con disabilità, Gaza Sunbirds "
        "è una rete di atleti, professionisti e volontari che apre un percorso di riabilitazione "
        "attraverso lo sport per palestinesi amputati o con altre disabilità — che si allenano, "
        "competono e portano avanti la causa collettiva. Quando il genocidio israeliano è esploso "
        "nell'ottobre 2023, i loro atleti hanno trasformato le biciclette da corsa in strumenti di "
        "soccorso, raggiungendo i quartieri devastati dalle bombe con cibo, medicine e speranza."
    ),
    "registration_note": (
        "Anche chi non partecipa alle attività sportive dovrà iscriversi, tramite una donazione "
        "di 15 €, che è possibile effettuare all'ingresso."
    ),
    "photos_2025": [
        static_m4g(f"2025/m4g-edizione-2025-{n:02d}.jpeg") for n in range(1, 30)
    ],
    "program": [
        {
            "label": "LA MATTINA",
            "title": "SPORT",
            "detail": (
                "Torneo di calcio a 5, corsa non competitiva o giro in bici. "
                "Aperto a tuttə, nessuna competizione."
            ),
        },
        {
            "label": "A SEGUIRE",
            "title": "PRANZO SOLIDALE",
            "detail": "A cura di Cucina Franca e… (da confermare).",
        },
        {
            "label": "IL POMERIGGIO",
            "title": "TALK & INTERVENTI",
            "detail": "Approfondimenti sulla situazione palestinese, con ospiti TBA.",
        },
        {
            "label": "TUTTO IL GIORNO",
            "title": "BAR & MERCH",
            "detail": "Cibo, bevande e merch solidale al banco.",
        },
    ],
    "day_timeline": [
        {
            "time": "09:00 – 14:00",
            "title": "SPORT",
            "detail": (
                "Torneo di calcio a 5, corsa non competitiva e giro in bici. "
                "Attività non competitive, aperte a tuttə."
            ),
        },
        {
            "time": "Ore 13:00 circa",
            "title": "PRANZO SOCIALE",
            "detail": (
                "Pranzo aperto anche a chi non partecipa alle attività sportive. "
                "Scopri di più su bar e cucina."
            ),
            "link": "/m4g/bar",
            "link_text": "bar e cucina",
        },
        {
            "time": "Dopo pranzo",
            "title": "TALK & TESTIMONIANZE",
            "detail": (
                "Momenti di approfondimento e confronto, con ospiti e testimonianze "
                "dirette dalla Palestina."
            ),
        },
    ],
    "limits": {
        "soccer_teams_max": 12,
        "run_max": 100,
    },
    "pricing": {
        "person_cents": 1500,
        "soccer_team_cents": 7500,
        "merch_unit_cents": 1500,
        "min_donation_cents": 1500,
    },
    "payments": {
        "paypal_business": os.environ.get("M4G_PAYPAL_BUSINESS", "amaro.bici@gmail.com"),
        "paypal_me": os.environ.get("M4G_PAYPAL_ME", ""),
        "paypal_link": os.environ.get(
            "M4G_PAYPAL_LINK",
            "https://www.paypal.com/pool/9iq3YyxOcH?sr=wccr",
        ),
        "paypal_link_merch": os.environ.get(
            "M4G_PAYPAL_LINK_MERCH",
            "https://www.paypal.com/pool/9iq3YyxOcH?sr=wccr",
        ),
        "satispay_link": os.environ.get(
            "M4G_SATISPAY_LINK",
            "https://web.satispay.com/download/qrcode/S6Y-SVN--2272D1CA-C3EC-4F11-A43F-BB71071263F3?locale=it_IT",
        ),
        "satispay_tag": os.environ.get("M4G_SATISPAY_TAG", ""),
        "iban": "IT36X0623001621000040418795",
        "iban_owner": "Amaro ASD",
        "iban_bank": "",
    },
    "descrizione_evento": (
        "L'evento si divide in due momenti principali, la mattina viene dedicata a manifestazioni "
        "sportive non competitive: torneo di calcio a 5 (squadre miste), corsa non competitiva "
        "(7 km) con possibilità di fare staffetta (7 + 7) aperta a tuttə e giro ciclistico a sud "
        "di Milano (115 km) presso il campo sportivo dell'Arci Olmi. Dopo un pranzo sociale "
        "(verso le 14:00) aperto anche a chi non partecipa agli eventi sportivi, il pomeriggio "
        "è dedicato a momenti di approfondimento e confronto con ospiti e testimonianze dirette "
        "dalla Palestina."
    ),
    "descrizione_evento_perche": (
        "La Move4Gaza è un evento sportivo non competitivo per raccogliere fondi a sostegno degli "
        "aiuti umanitari, nasce dall'esigenza di fare qualcosa di concreto per la popolazione di "
        "Gaza, in questo momento drammatico, con l'obiettivo e la speranza non solo di contribuire "
        "in maniera concreta, ma di dare la possibilità a tuttə le persone che in questo momento "
        "come noi vogliono cambiare le cose di poterlo fare, ma soprattutto di poter costruire in "
        "futuro qualcosa di molto più grande ed importante. La sensazione di impotenza che proviamo "
        "non deve fermarci, possiamo fare molte cose, speriamo che oggi nasca una nuova "
        "consapevolezza di ciò che possiamo fare."
    ),
    "descrizione_bici": (
        "Il percorso lungo circa 115 km ricalca la lunghezza del perimetro della striscia di Gaza "
        "con partenza ed arrivo all'Arci Olmi di Milano dove si svolgerà l'evento. Il percorso si "
        "snoda su strade secondarie e piste ciclabili, con alcuni tratti sterrati. Il dislivello è "
        "di circa 300 m. Non è una gara, ma un evento sociale e solidale, si raccomanda di pedalare "
        "in sicurezza. Dopo Pavia segnaliamo scarsità di punti di ristoro da tenere in considerazione. "
        "Percorso cittadino di 24 km a partire dall'Arci Olmi per i campi del Parco Agricolo Sud."
    ),
    "descrizione_calcio": (
        "Il torneo di calcio non competitivo a 5 si svolge presso il campo sportivo dell'Arci Olmi "
        "a Milano. Le squadre sono miste e aperte a tuttə, ogni squadra gioca 3 partite da 20 minuti, "
        "tra una partita ci saranno momenti per mangiare o bere qualcosa. La donazione minima è di "
        "75 € a squadra (15 € a persona), chi vuole può donare di più. Il torneo inizia alle 9:30 e "
        "finisce verso le 13:00, dopo il torneo c'è la possibilità di partecipare al pranzo sociale "
        "(non incluso nella donazione). Il quadro delle squadre verrà comunicato qualche giorno prima "
        "dell'evento, se avete necessità particolari (orari, composizione squadra ecc) scriveteci pure."
    ),
    "descrizione_corsa": (
        "La corsa non competitiva di circa 7 km si svolge su un percorso cittadino che parte e arriva "
        "all'Arci Olmi di Milano. Il percorso è adatto a tuttə, con la possibilità di fare una staffetta "
        "in due persone (7 + 7) e per i più carichi 14 in solitaria. La donazione minima è di 15 € a "
        "persona, chi vuole può donare di più. La corsa inizia alle 11:00, seguita dal pranzo sociale "
        "(non incluso nella donazione). Durante la corsa non sono previsti punti di ristoro e assistenza "
        "medica, il tracciato gps è scaricabile e il tracciato sarà segnato."
    ),
    "descrizione_ingresso": (
        "L'ingresso all'evento è aperto a tuttə, la donazione minima è di 15 €, chi vuole può donare di più. "
        "L'ingresso dà accesso alle attività della giornata (sport e momenti di confronto). "
        "Cibo e bevande si ordinano e pagano separatamente dal bar/cucina. "
        "Durante la giornata sono previsti momenti di approfondimento e confronto con "
        "ospiti e testimonianze dirette dalla Palestina."
    ),
    "schedule": [
        {
            "time": "08:30",
            "title": "Accoglienza",
            "detail": "Apertura campo Arci Olmi, info desk e ritiro numeri per le attività.",
        },
        {
            "time": "09:30",
            "title": "Play4Gaza — calcio",
            "detail": "Torneo 5vs5 non competitivo; partite da 20 minuti fino a circa le 13:00.",
        },
        {
            "time": "10:00",
            "title": "Ride4Gaza — partenza bici",
            "detail": "Percorsi da 25 km (cittadino) e 112 km (perimetro Gaza in scala). Ritrovo all'Arci Olmi.",
        },
        {
            "time": "11:00",
            "title": "Run4Gaza — corsa",
            "detail": "Corsa/staffetta ~7 km, partenza e arrivo all'Arci Olmi.",
        },
        {
            "time": "13:00",
            "title": "Pranzo sociale",
            "detail": "Cucine ospiti e bar: ordina dal sito, paga e mostra i banner al banco.",
        },
        {
            "time": "14:30",
            "title": "Pomeriggio — incontri",
            "detail": "Testimonianze e confronto; aperto anche a chi non ha partecipato allo sport.",
        },
    ],
    "cause": (
        "Raccogliamo fondi a sostegno di Gaza Sunbirds — ONG e team di atleti paralimpici che ogni "
        "giorno porta cibo, medicine e sostegno alla popolazione civile. Move4Gaza nasce dal bisogno "
        "di fare qualcosa di concreto in un momento drammatico, e dalla volontà di dare a chi, come "
        "noi, vuole cambiare le cose la possibilità di farlo — oggi, e sempre di più in futuro. "
        "Il 100% del ricavato va a loro."
    ),
    "bike_distances": [
        {"key": "112", "label": "112 km — Perimetro di Gaza in scala reale"},
        {"key": "20", "label": "25 km — percorso cittadino"},
    ],
    "gpx": {
        "bike_112": static_m4g("routes/rideforgaza112.gpx"),
        "bike_20": static_m4g("routes/amgaz_bici_short.gpx"),
        "run": static_m4g("routes/amgaz_corsa.gpx"),
    },
    "beneficiary": {
        "name": "Gaza Sunbirds",
        "url": "https://gazasunbirds.org/",
        "logo_url": static_m4g("opt/sunbirds-logo-512.png"),
        "cf": "",
        "address": "Gaza / London (team & fiscal hosts)",
        "blurb": (
            "I Gaza Sunbirds sono la squadra paraciclistica della Palestina e, negli ultimi 22 mesi, "
            "hanno ottenuto riconoscimento a livello globale per le loro coraggiose missioni di soccorso "
            "e per i risultati sportivi internazionali."
        ),
        "images": {
            "chi": m4g_responsive("bene_chi", "bene_chi.JPG", 1067, 1600),
            "mission": m4g_responsive("bene_mission", "bene_mission.jpg", 1600, 900),
            "dist": m4g_responsive("bene_dist", "bene_dist.png", 456, 768),
            "aid": m4g_responsive(
                "bene_aid",
                "bene_aid.jpg",
                1600,
                1200,
                sizes="100vw",
            ),
        },
        "links": {
            "mission_url": "https://gazasunbirds.org/about-us/mission/",
            "about_url": "https://gazasunbirds.org/about-us/",
            "aid_url": "https://gazasunbirds.org/",
            "a4p_url": "https://gazasunbirds.org/campaigns/a4p/",
            "great_ride_url": "https://gazasunbirds.org/campaigns/great-ride/",
            "pizza_party_url": "https://gazasunbirds.org/aid/pizza-party/",
            "shop_url": "https://gazasunbirds.org/shop/",
            "contact_url": "https://gazasunbirds.org/campaigns/contact-us/",
        },
    },
    "menu_images": {
        "cibo": m4g_responsive("m4g_cibo", "M4G_cibo.png", 665, 940, sizes="(max-width: 768px) 50vw, 18rem"),
        "bere": m4g_responsive("m4g_bere", "M4G_bere.png", 666, 940, sizes="(max-width: 768px) 50vw, 18rem"),
    },
    "merch_images": {
        "socks": m4g_responsive("calze_m4g", "calze_m4g.jpeg", 1600, 1200, sizes="(max-width: 768px) 100vw, 22rem"),
        "tshirt": m4g_responsive("magliette_m4g", "magliette_m4g.png", 2068, 1210, sizes="(max-width: 768px) 100vw, 22rem"),
    },
}

FOOD_VENDORS = [
    {
        "id": "cucina-franca",
        "name": "Cucina Franca",
        "blurb": "Primi piatti e cucina di quartiere — menu del giorno solidale.",
        "placeholder": True,
    },
    {
        "id": "tondo-forno",
        "name": "Tondo Forno Radicale",
        "blurb": "Pane, pizze al taglio e focacce — da confermare con il forno.",
        "placeholder": True,
    },
]

REALTA_ADERENTI = [
    "Alfabeti ODV",
    "Amaro",
    "Ape_milano",
    "Arci Olmi",
    "Ciclochard",
    "Ciclofficina Bincio",
    "Circonvalley",
    "Ciclo Club Scappati di Casa",
    "Cucina Franca",
    "Eleganza Cycling",
    "Errantes",
    "Famole Strane",
    "Fulgenzio Tacconi",
    "GGGG Bicis",
    "Giovani Palestinesi Milano",
    "Maledette Biciclette Milanesi",
    "Maloha Trail",
    "Maradonne",
    "Milano Bicycle Coalition",
    "Patatrack.cc",
    "Pink Wave Cycling Team",
    "Prima Traccia",
    "Popolare Ciclistica",
    "Recup",
    "Rimaflow",
    "St. Ambroeus FC",
    "StellaRossa.cc",
    "Tondo Forno Radicale",
    "Trace.cc",
    "Turbolento",
    "Upcycle Cafè",
    "Wizard Cycling Crew",
]

ACTIVITIES = [
    {
        "key": "bike",
        "title": "Ride4Gaza",
        "subtitle": "Giro ciclistico solidale",
        "path": "/m4g/bici",
        "price_label": "15 €",
    },
    {
        "key": "soccer",
        "title": "Play4Gaza",
        "subtitle": "Torneo calcio a 5",
        "path": "/m4g/calcio",
        "price_label": "75 € / squadra",
    },
    {
        "key": "run",
        "title": "Run4Gaza",
        "subtitle": "Corsa o staffetta",
        "path": "/m4g/corsa",
        "price_label": "15 €",
    },
    {
        "key": "entrance",
        "title": "Support4Gaza",
        "subtitle": "Ingresso senza sport",
        "path": "/m4g/ingresso",
        "price_label": "15 €",
    },
]


# Edizione 2025: numeri dichiarati + stime km/minuti.
# Bici: 1/3 lungo (112 km), 2/3 cittadino (25 km) → 50×112 + 100×25 = 8.100 km.
# Corsa: 50×7 km + 10×14 km → 490 km.
# Calcio: 12 squadre × 3 partite / 2 = 18 incontri × 20 min = 360 minuti di gioco.
LAST_EDITION = {
    "year": 2025,
    "raised_eur": 26000,
    "participants": 500,
    "cyclists": 150,
    "runners": 60,
    "soccer_teams": 12,
    "soccer_players": 100,
    "bike_km": 8100,
    "run_km": 490,
    "soccer_matches": 18,
    "soccer_minutes": 360,
    "meeting_title": "Il pomeriggio dopo lo sport",
    "meeting_text": (
        "Dopo il pranzo, il campo dell'Arci Olmi si è trasformato in un'assemblea aperta. "
        "Abbiamo ascoltato testimonianze dirette dalla Palestina, il racconto delle missioni "
        "di mutual aid dei Gaza Sunbirds e un confronto su cosa significa, da Milano, non "
        "fermarsi alla donazione: costruire reti, ripetere l'appuntamento, tenere viva "
        "l'attenzione quando le telecamere si spengono. Non era un talk da palco: era un "
        "cerchio di persone stanche, sudate e ancora presenti. Da lì è nata l'idea di "
        "rifare Move for Gaza, più chiara e più grande."
    ),
}
