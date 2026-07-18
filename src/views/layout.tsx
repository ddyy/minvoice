import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';

type LayoutProps = {
  title: string;
  /** BCP-47 tag for the html lang attribute — public pages pass the customer locale */
  lang?: string;
  children: Child;
  /** 'admin' shows the nav bar; 'public' is the bare pay-page shell */
  variant?: 'admin' | 'public';
  currentPath?: string;
};

const NAV_LINKS = [
  { href: '/admin', label: 'Invoices' },
  { href: '/admin/clients', label: 'Clients' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/settings', label: 'Settings' },
];

export function Layout({ title, children, variant = 'admin', currentPath = '', lang = 'en' }: LayoutProps) {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="preload" href="/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link
          rel="preload"
          href="/fonts/instrument-sans.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="stylesheet" href="/styles.css" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body>
        {variant === 'admin' ? (
          <header class="site-header">
            <div class="container">
              <a href="/admin" class="site-brand">
                Minvoice
              </a>
              <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false">
                <span></span>
                <span></span>
                <span></span>
              </button>
              <nav class="site-nav" id="site-nav">
                {NAV_LINKS.map((l) => (
                  <a href={l.href} class={currentPath === l.href ? 'active' : ''}>
                    {l.label}
                  </a>
                ))}
                {/* Ends the password session, or hands off to Access's edge logout */}
                <a href="/admin/logout" class="logout">
                  Log out
                </a>
              </nav>
            </div>
          </header>
        ) : null}
        <main class={variant === 'public' ? 'pay-wrap' : 'container'}>{children}</main>
        {variant === 'admin' ? (
          <footer class="site-footer">
            Minvoice — open source on{' '}
            <a href="https://github.com/ddyy/minvoice" target="_blank" rel="noopener">
              GitHub
            </a>
          </footer>
        ) : null}
        {variant === 'admin' ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `
(function () {
  var btn = document.getElementById('nav-toggle');
  var nav = document.getElementById('site-nav');
  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  });
})();
`,
            }}
          ></script>
        ) : null}
      </body>
      </html>
    </>
  );
}
