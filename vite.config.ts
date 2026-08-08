import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { esmShim } from 'vite-plugin-electron/plugin'
import stylexPlugin from '@stylexjs/unplugin/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    stylexPlugin({
      unstable_moduleResolution: {
        type: 'commonJS',
        rootDir: resolve('.'),
      },
    }),
    react(),
    electron({
      main: {
        entry: 'src/main/main.ts',
        vite: {
          plugins: [esmShim()],
          build: {
            rolldownOptions: {
              external: ['better-sqlite3'],
            },
          },
          resolve: {
            alias: {
              '@shared': resolve('src/shared'),
            },
          },
        },
      },
      preload: {
        input: 'src/preload/preload.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': resolve('src/shared'),
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
    },
  },
})
