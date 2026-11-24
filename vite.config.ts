import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// Use Node's HTTP/TLS implementation:
// the Workers emulator fails to reach api.festo.com on this computer.
export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    open: process.env.FESTO_OPEN_BROWSER === '1',
    ...(process.env.CODEX_SANDBOX === 'seatbelt'
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [vinext()],
});
