import Link from 'next/link';
import posts from '../../data/posts.json';

export default function BlogIndex() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Blog</h1>
      <ul className="space-y-2">
        {posts.map(p => (
          <li key={p.slug}>
            <Link href={`/blog/${p.slug}`}>{p.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
