// Vite settings for the React front end. `npx vite build` writes web/dist, which the Worker serves.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, /api/* goes to the Worker running locally with `wrangler dev` (port 8787).
// Start the Worker first: `cd worker && npx wrangler dev`. For sample data instead, see .env.example.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
