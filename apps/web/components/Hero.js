export default function Hero() {
  return (
    // Tira su tutta la sezione per eliminare il gap sotto la navbar
    <section className="hero -mt-8 md:-mt-12 lg:-mt-16">
      <div className="max-w-6xl mx-auto px-2">

        {/* FOTO GRANDE SOPRA AL TITOLO */}
        {/* -mt-px elimina l’eventuale hairline (es. border-bottom della navbar) */}
        <figure className="mb-1 -mt-px">
          <img
            src="/images/Hero.png"
            alt="Amaro Bici"
            className="w-full aspect-[16/9] md:aspect-[21/9] object-cover object-top rounded-2xl shadow-lg border border-white/40"
          />
        </figure>

        <div className="kicker">associazione ciclistica</div>
        <h1 className="text-4xl md:text-6xl font-bold leading-tight mt-2 on-brand">
          Pedalare bene, insieme.
        </h1>
        <p className="mt-3 text-white/90 max-w-2xl">
          Eventi, avventure e strade da condividere. Tesserati per accedere al portale,
          caricare i certificati e partecipare alle nostre uscite.
        </p>

        <div className="mt-6 flex gap-3">
          <a className="btn btn-primary" href="/event">Calendario eventi</a>
          <a className="btn btn-ghost" href="https://script.google.com/home/projects/1QGotzhmD1458LwYJqOVd4OjSG49xjOpVlefTgm32ef5cPWdfFMJHyNrX/edit" target="_blank" rel="noreferrer">
            Portale tesserati
          </a>
        </div>

      </div>
    </section>
  );
}
