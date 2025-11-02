export default function GalleryPage() {
  const items = Array.from({ length: 9 }).map((_, i) => ({ url: `/images/pic${i+1}.jpg`, caption: `Foto ${i+1}` }));
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Gallery</h1>
      <div className="masonry">
        {items.map(it => (
          <figure key={it.url}><img src="/images/sample.jpg" alt={it.caption} /></figure>
        ))}
      </div>
    </div>
  );
}
