// The frame around every page: the site header with navigation, the page itself (<Outlet />), and a footer with
// the privacy and not-medical-advice notes.

import * as React from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

export const APP_NAME = 'Aging & Lifestyle Research Explorer';

// Follow the reader's system setting for light or dark.
function useSystemTheme() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = React.useState(() => window.matchMedia(query).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark ? 'dark' : 'light';
}

// "Ask a question" is marked as the current page everywhere except About, since the chat is part of asking.
export default function Layout() {
  const theme = useSystemTheme();
  const { pathname } = useLocation();
  const onAbout = pathname === '/about';
  const onAsk = !onAbout;

  React.useEffect(() => {
    // The design system's colors (design/tokens.css) switch on data-theme.
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Each new page starts at the top.
  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="page">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="site-name">{APP_NAME}</Link>
          <nav aria-label="Main" className="site-nav">
            <Link to="/" className="nav-link" aria-current={onAsk ? 'page' : undefined}>Ask a question</Link>
            <Link to="/about" className="nav-link" aria-current={onAbout ? 'page' : undefined}>About this tool</Link>
          </nav>
        </div>
      </header>
      <main className="site-main">
        <div className="column">
          <Outlet />
        </div>
      </main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <p>No account needed. We do not store your questions with anything that identifies you.</p>
          <p>
            For adults. This tool explains published research. It is not medical advice.{' '}
            <Link to="/about" className="text-link">How this tool works and what it cannot do</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
