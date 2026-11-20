# Aging & Lifestyle Research Explorer: React front end

Vite + React, built from the design handoff (mockups and design system), which lives in Google Drive under
`INFO 698 - Capstone Project/Project/design/`. Read its `README.md` and `design-system/README.md` before changing
the interface.

## Run it

```
cd web
npm install        # once
npm run dev        # http://localhost:5173
npm run build      # static files in dist/, for Cloudflare Pages / Workers static assets
```

## Pages

| Route | Page | Mockup (in `design/screens/`) |
|---|---|---|
| `/` | Start: question box, topic chips, example questions, how it works | `start.html` |
| `/chat?q=...` | The chat: the question box on `/` opens it; replies with citations and sources, follow-ups, "More detail", print, copy link | `answer.html`, `no-answer.html` (styles reused in chat bubbles) |
| `/ask?q=...` | Old links: forward to `/chat` with the same query (the one-question page was replaced 2026-11-09) | |
| `/about` | About this tool | `about.html` |

## The API

`src/api.js` calls `POST /api/ask` with `{ "question": "..." }`. The expected response shape is written at the top
of that file. In development, `/api` is proxied to `wrangler dev` on port 8787 (`vite.config.js`).

To work on the front end without the Worker, copy `.env.example` to `.env` and set
`VITE_USE_SAMPLE_API=true`: the app then answers with bracketed placeholder data after 3.5 seconds, and a question that
mentions none of the collection's topics gets "no research found".

## Files

- `src/design/`: copied from the design handoff's `design-system/` (components, `bundle.css`, `tokens.css`, fonts). If the design
  system changes, copy the files again rather than editing them here.
- `src/Layout.jsx`: header, footer, and the light/dark theme (follows the reader's system setting).
- `src/pages/`: `StartPage`, `ChatPage` (the conversation), `AboutPage`; `conversation.js` (chat links and the history sent with each message); `shared.jsx` (menus, notices).
- Hosting: the Worker serves `dist/`; `not_found_handling` in `worker/wrangler.jsonc` sends `/about`, `/chat` and `/ask` to `index.html`.
