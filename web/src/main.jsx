// Entry point of the React front end: loads the design system's styles and sets up the pages (routes).
// Every page shares Layout (header and footer). /chat is where questions are asked and answered, /about explains
// the tool, and any other path shows the start page. /ask was the one-question answer page until 2026-11-09; its links
// (bookmarks, slides) now forward to the chat with the same question and menus.

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './design/tokens.css';
import './design/bundle.css';
import './app.css';
import Layout from './Layout.jsx';
import StartPage from './pages/StartPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import ChatPage from './pages/ChatPage.jsx';

// /ask?q=...&model=...&level=...&exact=1 becomes /chat with the same query, which the chat page understands.
function AskRedirect() {
  const { search } = useLocation();
  return <Navigate to={'/chat' + search} replace />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<StartPage />} />
          <Route path="ask" element={<AskRedirect />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="*" element={<StartPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
