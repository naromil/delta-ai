import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      // The CSP has no `data:` in font-src, so an inlined KaTeX font would be blocked.
      assetsInlineLimit: (filePath) => (/\.(woff2?|ttf)$/.test(filePath) ? false : undefined)
    }
  }
})
