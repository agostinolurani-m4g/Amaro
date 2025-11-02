// apps/web/app/tesserati/page.js
export default function TesseratiPage() {
  const brand = "#672146"; // Pantone 229C
  const accent = "#8a2a63"; // variazione, opzionale

  return (
    <main style={{ background: "#fff", color: brand }}>
      <section style={{ background: brand, color: "#fff", padding: "72px 20px", textAlign: "center" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <h1 style={{ margin: 0, fontSize: 44, lineHeight: 1.1 }}>Tesserati</h1>
          <p style={{ margin: "12px 0 0", fontSize: 18, opacity: 0.95 }}>
            Richiedi o aggiorna i tuoi dati. Niente login: ci pensiamo noi.
          </p>
          <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href="https://forms.gle/INSERISCI_TUO_GOOGLE_FORM"
              target="_blank" rel="noreferrer"
              style={{ background: "#fff", color: brand, borderRadius: 9999, padding: "12px 18px",
                       textDecoration: "none", fontWeight: 700, border: "2px solid #fff" }}
            >
              Richiedi / aggiorna dati
            </a>
            <a
              href="mailto:info@amarobici.it?subject=Richiesta%20dati%20tesserato"
              style={{ background: "transparent", color: "#fff", borderRadius: 9999, padding: "12px 18px",
                       textDecoration: "none", fontWeight: 700, border: "2px solid #ffffff88" }}
            >
              Scrivici via email
            </a>
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 920, margin: "36px auto", padding: "0 20px" }}>
        <article style={{ border: `1px solid ${brand}22`, borderRadius: 16, padding: 20, background: "#fff" }}>
          <h2 style={{ marginTop: 0, fontSize: 22, color: brand }}>Come funziona</h2>
          <ol style={{ margin: "6px 0 0 18px" }}>
            <li>Compila il <b>Google Form</b> con i tuoi dati aggiornati.</li>
            <li>Carica eventuali documenti richiesti (certificato medico, ecc.).</li>
            <li>Ti rispondiamo con conferma o eventuali integrazioni.</li>
          </ol>
        </article>

        <article style={{ border: `1px solid ${brand}22`, borderRadius: 16, padding: 20, background: "#fff", marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 22, color: brand }}>Contatti rapidi</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, lineHeight: 1.8 }}>
            <li>📧 Email: <a href="mailto:info@amarobici.it" style={{ color: brand, fontWeight: 700 }}>info@amarobici.it</a></li>
            <li>💬 WhatsApp: <a href="https://wa.me/390000000000?text=Ciao%20Amaro%20Bici%2C%20vorrei%20aggiornare%20i%20miei%20dati."
               target="_blank" rel="noreferrer" style={{ color: brand, fontWeight: 700 }}>scrivici su WhatsApp</a></li>
            <li>📄 Modulo iscrizione (PDF): <a href="/static/modulo_iscrizione.pdf" style={{ color: brand, fontWeight: 700 }}>scarica</a></li>
          </ul>
        </article>

        <div style={{ textAlign: "center", marginTop: 28 }}>
          <a
            href="https://forms.gle/INSERISCI_TUO_GOOGLE_FORM"
            target="_blank" rel="noreferrer"
            style={{ background: brand, color: "#fff", borderRadius: 9999, padding: "12px 18px",
                     textDecoration: "none", fontWeight: 700, border: `2px solid ${accent}` }}
          >
            Apri il form
          </a>
        </div>
      </section>
    </main>
  );
}
