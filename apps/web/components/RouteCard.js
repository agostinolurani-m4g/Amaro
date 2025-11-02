export default function RouteCard({ r }) {
  return (
    <article className="card">
      <h3 className="font-semibold">{r.title}</h3>
      <div className="text-xs text-gray-500">{r.distanceKm ? r.distanceKm + ' km' : ''} {r.elevationM ? '• ' + r.elevationM + ' m+' : ''}</div>
      {r.gpxUrl ? <a className="inline-block mt-2" href={r.gpxUrl}>Scarica GPX →</a> : null}
    </article>
  );
}
