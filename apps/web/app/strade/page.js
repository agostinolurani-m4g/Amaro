import routes from '../../data/routes.json';

export default function StradePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Le nostre strade</h1>
      <div className="grid md:grid-cols-3 gap-6">
        {routes.map(r => (
          <article key={r.slug} className="card">
            <h3 className="font-semibold">{r.title}</h3>
            <p className="text-sm text-gray-600">{r.distanceKm ? r.distanceKm + ' km' : ''} {r.elevationM ? '• ' + r.elevationM + ' m+' : ''}</p>
            {r.staticImgUrl ? <img src={r.staticImgUrl} alt={r.title} /> : null}
            {r.gpxUrl ? <a href={r.gpxUrl} className="inline-block mt-2">Scarica GPX →</a> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
