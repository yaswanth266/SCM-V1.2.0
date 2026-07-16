import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const IS_UAT = (() => {
  const v = String(process.env.VITE_UAT || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
})();

export default defineConfig({
  base: IS_UAT ? '/uat/' : '/',
  plugins: [
    react(),
    {
      name: 'serve-apk-mime',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = req.url ? req.url.split('?')[0] : '';
          if (pathname.endsWith('.apk')) {
            const originalWriteHead = res.writeHead;
            res.writeHead = function (statusCode, headers) {
              res.setHeader('Content-Type', 'application/vnd.android.package-archive');
              return originalWriteHead.apply(this, arguments);
            };
          }
          next();
        });
      }
    }
  ],
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
