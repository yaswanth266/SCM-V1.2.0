import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
            const fileName = path.basename(pathname);
            const filePath = path.join(__dirname, 'public', fileName);
            if (fs.existsSync(filePath)) {
              const stat = fs.statSync(filePath);
              res.writeHead(200, {
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Cache-Control': 'public, no-transform, max-age=2592000'
              });
              const readStream = fs.createReadStream(filePath);
              readStream.pipe(res);
              return;
            }
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
