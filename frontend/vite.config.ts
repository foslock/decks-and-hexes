/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Set long-lived Cache-Control headers for card art images. */
function cardImageCachePlugin(): Plugin {
  return {
    name: 'card-image-cache',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/cards/') && req.url.endsWith('.png')) {
          // Cache for 7 days, allow revalidation
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
        }
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/cards/') && req.url.endsWith('.png')) {
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), cardImageCachePlugin()],
  server: {
    proxy: {
      '/api/lobby/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
