import './styles.css';
import '../styles/globals.css';
import '../styles/theme.css';
import Link from 'next/link';

export const metadata = {
  title: 'Amaro Bici',
  description: 'Associazione ciclistica: eventi, strade, filosofia, tesseramento.',
}

function Nav() {
  const nav = [
    { href: '/', label: 'Home' },
    { href: '/event', label: 'Eventi' },
    { href: '/calendar', label: 'Calendario' },
    { href: '/gallery', label: 'Gallery' },
    { href: '/team', label: 'Team' },
    { href: '/blog', label: 'Blog' },
    { href: '/strade', label: 'Le nostre strade' },
    { href: '/principi', label: 'I nostri principi' },
    { href: '/tesserati', label: 'Tesserati' }
  ];
  return (
    
    <header className="brand-bar sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between on-brand">
        <Link href="/" className="flex items-center gap-2 no-underline">
          {/* SOLO LOGO */}
          <img src="/brand/logoamaro.svg.png" alt="Amaro Bici" className="h-7 w-auto" />
        </Link>
        <nav className="hidden md:flex gap-4">
          {nav.map(i => i.external ? (
            <a key={i.href} href={i.href} className="text-sm" target="_blank" rel="noreferrer">{i.label}</a>
          ) : (
            <Link key={i.href} href={i.href} className="text-sm">{i.label}</Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

export default function RootLayout({ children }) {
  return (
    <html lang="it">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{fontFamily:'Poppins, ui-sans-serif, system-ui, sans-serif'}}>
        <Nav />
        <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
        <footer className="py-10 text-sm text-center" style={{color:'var(--ink-209)'}}>
          <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-6 px-4 text-left">
            <div>
              <div className="font-semibold mb-2" style={{color:'var(--bar)'}}>AMARO BICI</div>
              <p>Pedaliamo insieme, nel rispetto delle persone e del territorio.</p>
            </div>
            <div>
              <div className="font-semibold mb-2" style={{color:'var(--bar)'}}>Contatti</div>
              <p>Email: amaro.bici@gmail.com</p>
              <p>Instagram / Strava</p>
            </div>
            <div>
              <div className="font-semibold mb-2" style={{color:'var(--bar)'}}>Link rapidi</div>
              <ul className="space-y-1">
                <li><a href="/event">Eventi</a></li>
                <li><a href="/strade">Le nostre strade</a></li>
                <li><a href="/principi">I nostri principi</a></li>
                <li><a href="/blog">Blog</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-6">© {new Date().getFullYear()} Amaro Bici</div>
        </footer>
      </body>
    </html>
  );
}
