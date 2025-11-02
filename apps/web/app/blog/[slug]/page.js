import posts from '../../../data/posts.json';

export async function generateStaticParams() {
  return posts.map(p => ({ slug: p.slug }));
}

export default function BlogPost({ params }) {
  const post = posts.find(p => p.slug === params.slug);
  if (!post) return <div>Articolo non trovato.</div>;
  return (
    <article className="prose max-w-none">
      <h1>{post.title}</h1>
      <p className="text-sm text-gray-600">{post.excerpt}</p>
      <div dangerouslySetInnerHTML={{ __html: post.html || '<p>Contenuto in arrivo…</p>' }} />
    </article>
  );
}
