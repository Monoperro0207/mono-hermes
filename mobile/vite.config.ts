/**
 * Vite config for the phone build.
 *
 * Mirrors upstream/apps/desktop/vite.config.ts (React + React Compiler preset,
 * Tailwind 4, emojibase assets, chunking, aliases) but roots the project in
 * mobile/ so the entry can install the `window.hermesDesktop` bridge BEFORE the
 * unmodified desktop renderer (upstream/apps/desktop/src/main.tsx) is imported.
 *
 * `scripts/sync-upstream-deps.mjs --check` flags when the upstream config this
 * file mirrors has changed and needs a review.
 */
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { defineConfig, type Plugin } from 'vite'

import { buildConstants } from './build-constants.ts'

const mobileRoot = __dirname
const repoRoot = path.resolve(mobileRoot, '..')
const desktopRoot = path.resolve(repoRoot, 'upstream/apps/desktop')
const sharedSrc = path.resolve(repoRoot, 'upstream/apps/shared/src')
const requireFromMobile = createRequire(path.join(mobileRoot, 'vite.config.ts'))

const posix = (p: string) => p.split(path.sep).join('/')

/** React Compiler only on modules that can contain components/hooks (same filter as upstream). */
function compilerPreset() {
  const preset = reactCompilerPreset()
  if (preset.rolldown.filter) preset.rolldown.filter.code = /\/>|<\/|from\s*['"][^'"]*react/

  return preset
}

const reactDir = path.dirname(requireFromMobile.resolve('react/package.json'))
const reactDomDir = path.dirname(requireFromMobile.resolve('react-dom/package.json'))
const emojibaseDir = path.resolve(mobileRoot, 'node_modules/emojibase-data')
const EMOJIBASE_PATH = /^[a-z-]+\/(data|messages|shortcodes\/emojibase)\.json$/

/** Serve/emit the emoji picker data locally (the desktop does the same; the phone must work offline too). */
const emojibaseAssets = (): Plugin => ({
  generateBundle() {
    if (!fs.existsSync(emojibaseDir)) return

    for (const rel of ['en/data.json', 'en/messages.json', 'en/shortcodes/emojibase.json']) {
      this.emitFile({
        fileName: `emojibase/${rel}`,
        source: fs.readFileSync(path.join(emojibaseDir, rel)),
        type: 'asset'
      })
    }
  },
  configureServer(server) {
    server.middlewares.use('/emojibase', (req, res, next) => {
      const rel = (req.url ?? '').split('?')[0].replace(/^\/+/, '')

      if (!EMOJIBASE_PATH.test(rel)) return next()

      fs.readFile(path.join(emojibaseDir, rel), (err, buf) => {
        if (err) return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(buf)
      })
    })
  },
  name: 'hermes-mobile:emojibase-assets'
})

/**
 * Tailwind 4 detects utility classes by scanning from the Vite root, which is
 * mobile/ here, so the desktop sources would never be scanned. Rewrite (in memory,
 * upstream stays untouched) the desktop stylesheet's `@import 'tailwindcss'` so it
 * scans exactly the desktop renderer sources. Fails loudly if upstream changes
 * that line, instead of silently shipping an unstyled app.
 */
const tailwindScanUpstream = (): Plugin => ({
  enforce: 'pre',
  name: 'hermes-mobile:tailwind-scan-upstream',
  // Hook filter: matched natively, so the ~1500 other modules never call into JS.
  transform: {
    filter: { id: /[\\/]upstream[\\/]apps[\\/]desktop[\\/]src[\\/]styles\.css(\?.*)?$/ },
    handler(code) {
      const importLine = /@import\s+(['"])tailwindcss\1\s*;/

      if (!importLine.test(code)) {
        throw new Error(
          "hermes-mobile: upstream styles.css no longer starts with `@import 'tailwindcss';` - update tailwindScanUpstream() in mobile/vite.config.ts"
        )
      }

      const sources = posix(path.join(desktopRoot, 'src'))

      return {
        code: code.replace(importLine, `@import 'tailwindcss' source(none);\n@source '${sources}';`),
        map: null
      }
    }
  }
})

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 25000,
    emptyOutDir: true,
    // HERMES_MOBILE_DEBUG_BUILD=1: readable stack traces when chasing a renderer problem.
    minify: process.env.HERMES_MOBILE_DEBUG_BUILD === '1' ? false : undefined,
    outDir: 'dist',
    sourcemap: process.env.HERMES_MOBILE_DEBUG_BUILD === '1',
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack[\\/]react-query)[\\/]/
            },
            {
              name: 'vendor-md',
              test: /node_modules[\\/](property-information|hast-util-[^\\/]+|mdast-util-[^\\/]+|micromark[^\\/]*|unist-util-[^\\/]+|vfile[^\\/]*|unified|stringify-entities|space-separated-tokens|comma-separated-tokens|zwitch|html-void-elements|devlop|style-to-js|style-to-object|clsx)[\\/]/
            },
            {
              name: 'vendor-util',
              test: /node_modules[\\/](lodash-es|es-toolkit|uuid|dayjs|d3-array|d3-color|d3-force|d3-interpolate|d3-time[^\\/]*|dompurify|stylis)[\\/]/
            },
            {
              name: 'mermaid',
              test: /node_modules[\\/](mermaid|cytoscape|dagre|khroma|elkjs|d3|d3-[^\\/]+|@mermaid-js)[\\/]/
            },
            {
              name: 'shiki',
              test: /node_modules[\\/](shiki|@shikijs|react-shiki|@streamdown[\\/]code|oniguruma-to-es|oniguruma-parser|regex(-[^\\/]+)?)[\\/]/
            },
            { name: 'katex', test: /node_modules[\\/]katex[\\/]/ }
          ]
        }
      }
    }
  },
  css: { postcss: { plugins: [] } },
  define: buildConstants(),
  optimizeDeps: {
    exclude: [
      'driver.js',
      'driver.js/dist/driver.js.iife.js',
      'driver.js/dist/driver.js.iife.js?raw',
      'driver.js/dist/driver.css?raw'
    ]
  },
  plugins: [
    tailwindScanUpstream(),
    react(),
    babel({ presets: [compilerPreset()] }),
    tailwindcss(),
    emojibaseAssets()
  ],
  preview: { host: '127.0.0.1', port: 4175 },
  publicDir: path.join(desktopRoot, 'public'),
  resolve: {
    alias: {
      // Perf probes are a desktop dev tool; ship the no-op module.
      '@/debug/dev-only': path.join(desktopRoot, 'src/debug/dev-only.noop.ts'),
      '@': path.join(desktopRoot, 'src'),
      '@hermes/plugin-sdk': path.join(desktopRoot, 'src/sdk/index.ts'),
      '@hermes/shared/billing': path.join(sharedSrc, 'billing-types.ts'),
      '@hermes/shared/color': path.join(sharedSrc, 'color.ts'),
      '@hermes/shared/translucency': path.join(sharedSrc, 'translucency.ts'),
      '@hermes/shared': sharedSrc,
      'driver.js/dist/driver.js.iife.js?raw': `${path.join(path.dirname(requireFromMobile.resolve('driver.js')), 'driver.js.iife.js')}?raw`,
      'driver.js/dist/driver.js.iife.js': path.join(path.dirname(requireFromMobile.resolve('driver.js')), 'driver.js.iife.js'),
      react: reactDir,
      'react-dom': reactDomDir,
      'react/jsx-dev-runtime': path.join(reactDir, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': path.join(reactDir, 'jsx-runtime.js')
    },
    dedupe: ['react', 'react-dom', 'react-router', '@tanstack/react-query']
  },
  root: mobileRoot,
  server: {
    fs: { allow: [repoRoot] },
    host: '127.0.0.1',
    port: 5175,
    strictPort: true
  }
})
