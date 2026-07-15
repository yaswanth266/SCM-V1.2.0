import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const IS_UAT = (() => {
  const v = String(process.env.VITE_UAT || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
})();

export default defineConfig({
  base: IS_UAT ? '/uat/' : '/',
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
