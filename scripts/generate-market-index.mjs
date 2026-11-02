/**
 * Generate market/index.json for the DSH plugin market.
 *
 * The index points at the current Git commit. Run it after committing plugin
 * changes, then commit the generated market/ directory and publish it at a
 * static URL (GitHub Pages, raw.githubusercontent.com, any HTTPS host).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const repo = 'https://github.com/FPS1024/dsh-minemate'

const marketDir = resolve(root, 'market')
mkdirSync(marketDir, { recursive: true })
copyFileSync(resolve(root, 'icon.svg'), resolve(marketDir, 'icon.svg'))

const index = {
  format: 1,
  title: { en: 'MineMate', zh: 'MineMate' },
  description: {
    en: 'A real Minecraft player body for DeepSeek Harness.',
    zh: '让 DeepSeek Harness 作为一个真实 Minecraft 玩家生活的身体插件。',
  },
  metadata: {
    categories: { game: { title: { en: 'Games', zh: '游戏' } } },
    labels: {
      minecraft: { title: { en: 'Minecraft', zh: 'Minecraft' } },
      mineflayer: { title: { en: 'Mineflayer', zh: 'Mineflayer' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'MineMate', zh: 'MineMate' },
      description: {
        en: 'Connect a real Minecraft Java player to DSH: perceive, walk, mine, build, pick up, fight, sleep and chat.',
        zh: '把一个真实的 Minecraft Java 玩家接到 DSH：看、走、挖、建、捡、打、睡、聊天。',
      },
      icon: 'icon.svg',
      author: 'FPS1024',
      homepage: pkg.homepage,
      repository: { url: repo },
      metadata: {
        category: 'game',
        labels: ['minecraft', 'mineflayer'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repo, commit },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
}

writeFileSync(resolve(marketDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`[dsh-minemate] wrote market/index.json for ${pkg.name}@${pkg.version} at ${commit}`)
