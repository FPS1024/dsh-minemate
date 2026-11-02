/**
 * Bundle the host half into one ESM file.
 *
 * DSH's installed-profile resolver mishandles a few bare requests with a
 * trailing slash (`process/`, `string_decoder/`) emitted by readable-stream,
 * a dependency of mineflayer: `createRequire(parent).resolve.paths(name)`
 * returns null for the builtin names and the loader's for-of throws. Bundling
 * resolves those packages at build time, so the installed plugin no longer
 * asks the profile resolver for them.
 *
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` stay external: they are
 * host singletons provided by DSH. Everything else (mineflayer and friends)
 * is inlined.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

rmSync('bundle', { recursive: true, force: true })
mkdirSync('bundle', { recursive: true })

await build({
  entryPoints: ['index.js'],
  outfile: 'bundle/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  mainFields: ['module', 'main'],
  conditions: ['node', 'import'],
  external: [
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    // Large data/auth packages stay as runtime dependencies; they are not
    // involved in the trailing-slash resolution bug.
    'minecraft-data',
    'minecraft-data/*',
    '@azure/msal-node',
    '@azure/msal-common',
    'rxjs',
    'rxjs/*',
    'typescript',
  ],
  legalComments: 'none',
  sourcemap: false,
  // esbuild's ESM output needs a real require for CJS dependencies that use
  // dynamic require (minecraft-protocol requires "events" that way).
  banner: {
    js: "import { createRequire as __minemateCreateRequire } from 'node:module';\nconst require = __minemateCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})
