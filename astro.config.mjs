// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

// Todas as chamadas AWS acontecem no backend, por isso `output: 'server'`.
// O bind é sempre em loopback: esta ferramenta serve valores de parâmetro
// decriptados e nunca deve escutar em 0.0.0.0.
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  server: {
    host: HOST,
    port: PORT,
  },
  vite: {
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
      },
    },
  },
});
