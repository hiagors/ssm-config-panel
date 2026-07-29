import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // O store local escreve em diretórios temporários; sem isolamento por
    // arquivo os testes de permissão disputariam o mesmo tmpdir.
    isolate: true,
  },
});
