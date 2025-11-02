import Link from 'next/link';
export default function EventCard({ e }) {
  return (
    <article className="card">
      <div className="text-xs text-gray-500">{new Date(e.date).toLocaleDateString('it-IT')} • {e.location}</div>
      <h3 className="font-semibold mt-1">{e.title}</h3>
      <Link className="inline-block mt-2" href={`/event/${e.slug}`}>Dettagli →</Link>
    </article>
  );
}
