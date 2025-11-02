import events from '../../../data/events.json';

export async function generateStaticParams() {
  return events.map(e => ({ slug: e.slug }));
}

export default function EventDetail({ params }) {
  const event = events.find(e => e.slug === params.slug);
  if (!event) return <div>Evento non trovato.</div>;
  return (
    <article className="prose max-w-none">
      <h1>{event.title}</h1>
      <p><strong>{new Date(event.date).toLocaleDateString('it-IT')}</strong> – {event.location}</p>
      {event.coverUrl ? <img src={event.coverUrl} alt="cover" /> : null}
      <p>{event.content || 'Descrizione evento...'}</p>
    </article>
  );
}
