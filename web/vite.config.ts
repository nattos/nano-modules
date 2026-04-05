import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: { port: 5173 },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
