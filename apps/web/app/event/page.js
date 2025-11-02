import Link from 'next/link';
import events from '../../data/events.json';

export default function EventsIndex() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Eventi</h1>
      <ul className="space-y-2">
        {events.map(e => (
          <li key={e.slug}>
            <Link href={`/event/${e.slug}`}>{e.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
