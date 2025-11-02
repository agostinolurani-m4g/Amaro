import Link from 'next/link';
import events from '../data/events.json';
import routes from '../data/routes.json';
import posts from '../data/posts.json';
import Hero from '../components/Hero';
import { readdir } from 'fs/promises';
import path from 'path';

function CardEvent({ e }) {
  return (
    <article className="card">
      <div className="text-xs text-gray-500">{new Date(e.date).toLocaleDateString('it-IT')} • {e.location}</div>
      <h3 className="font-semibold mt-1">{e.title}</h3>
      <Link className="inline-block mt-2" href={`/event/${e.slug}`}>Dettagli →</Link>
    </article>
  );
}
function CardRoute({ r }) {
  return (
    <article className="card">
      <h3 className="font-semibold">{r.title}</h3>
      <div className="text-xs text-gray-500">{r.distanceKm ? r.distanceKm + ' km' : ''} {r.elevationM ? '• ' + r.elevationM + ' m+' : ''}</div>
      {r.gpxUrl ? <a className="inline-block mt-2" href={r.gpxUrl}>Scarica GPX →</a> : null}
    </article>
  );
}

export default async function HomePage() {
  const upcoming = events.slice(0, 3);
  const featuredRoutes = routes.slice(0, 3);
  const latestPosts = posts.slice(0, 3);
  // read images from public/images (server-side) and map to URLs
  let galleryImages = [];
  try {
    const imagesDir = path.join(process.cwd(), 'apps', 'web', 'public', 'images');
    const files = await readdir(imagesDir);
    galleryImages = files
      .filter((f) => /\.(jpeg|png|webp|heic|gif|svg)$/i.test(f))
      .sort()
      .map((name) => `/images/${name}`);
    if (galleryImages.length === 0) galleryImages = ['/images/sample.jpg'];
  } catch (err) {
    // fallback to sample image if directory not found / read fails
    console.error('Could not read images directory:', err.message || err);
    galleryImages = ['/images/Amaro_SecondoGiro_Benedetta-568.jpeg'];
  }
  return (
    <div className="space-y-12">
      <Hero />

      <section className="section">
        <div className="max-w-6xl mx-auto px-4">
          <div className="kicker">prossimi appuntamenti</div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold">Eventi in arrivo</h2>
            <Link className="text-sm" href="/event">Tutti gli eventi →</Link>
          </div>
          <div className="grid-3 mt-4">
            {upcoming.map(e => <CardEvent key={e.slug} e={e} />)}
          </div>
        </div>
      </section>

      <section className="section bg-gray-50">
        <div className="max-w-6xl mx-auto px-4">
          <div className="kicker">percorsi</div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold">Le nostre strade</h2>
            <Link className="text-sm" href="/strade">Vedi tutte →</Link>
          </div>
          <div className="grid-3 mt-4">
            {featuredRoutes.map(r => <CardRoute key={r.slug} r={r} />)}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="max-w-6xl mx-auto px-4">
          <div className="kicker">dal blog</div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold">Ultime storie</h2>
            <Link className="text-sm" href="/blog">Tutti i post →</Link>
          </div>
          <div className="grid-3 mt-4">
            {latestPosts.map(p => (
              <article key={p.slug} className="card">
                <h3 className="font-semibold">{p.title}</h3>
                <p className="text-gray-600 text-sm">{p.excerpt}</p>
                <Link className="inline-block mt-2" href={`/blog/${p.slug}`}>Leggi →</Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section bg-gray-50">
        <div className="max-w-6xl mx-auto px-4">
          <div className="kicker">gallery</div>
          <h2 className="text-2xl font-semibold">Scatti dalla bici</h2>
          <div className="masonry mt-4">
            {galleryImages.map((src, i) => (
              <figure key={i}><img src={src} alt={`Foto ${i+1}`} /></figure>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <h2 className="text-2xl font-semibold">Vuoi pedalare con noi?</h2>
          <p className="text-gray-600 mt-2">Tesserati e accedi al portale per certificati, tessera e uscite.</p>
          <a className="btn btn-primary mt-4" href="https://script.google.com/home/projects/1QGotzhmD1458LwYJqOVd4OjSG49xjOpVlefTgm32ef5cPWdfFMJHyNrX/edit" target="_blank">Vai al Portale tesserati</a>
        </div>
      </section>
    </div>
  );
}
