/**
 * Live reflex check: place one lava block two blocks away and verify the body
 * notices and moves away. Cleans the lava up with a filtered `/fill`.
 */
import { execFileSync } from 'node:child_process'
import { MinecraftBot } from '../lib/bot.js'

const ROOT = process.env.MINEMATE_SERVER_ROOT ?? '/home/ceaser/MineMate'
const rcon = (command) => execFileSync(
  'docker',
  ['compose', 'exec', '-T', 'minecraft', 'rcon-cli', command],
  { cwd: ROOT, encoding: 'utf8' },
)

const bot = new MinecraftBot({
  host: process.env.MINEMATE_MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MINEMATE_MC_PORT ?? 25565),
  username: process.env.MINEMATE_TEST_USER ?? 'AlexTest',
  auth: 'offline',
  version: process.env.MINEMATE_MC_VERSION ?? '1.21.6',
  owner: process.env.MINEMATE_AGENT_OWNER ?? 'FPS1024',
  reflex: true,
  autoSleep: false,
  humanize: false,
})

const events = []
bot.on('reflex', (event) => {
  events.push(event)
  console.log('reflex:', JSON.stringify(event))
})
bot.on('botError', (error) => console.error('bot error:', error.message))

let x = 0
let y = 0
let z = 0
let dirty = false
try {
  await bot.connect()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const position = bot.bot.entity.position
  x = Math.floor(position.x)
  y = Math.floor(position.y)
  z = Math.floor(position.z)

  rcon('gamerule doFireTick false')
  rcon(`setblock ${x + 2} ${y} ${z} minecraft:lava`)
  dirty = true
  console.log(`placed lava at ${x + 2}/${y}/${z}`)

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === 'lava')) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  console.log('status:', bot.statusLine())
  if (!events.some((event) => event.type === 'lava')) {
    console.error('LAVA CHECK FAILED: no lava reflex within 10s')
    process.exitCode = 1
  }
} catch (error) {
  console.error('LAVA SLICE FAILED:', error)
  process.exitCode = 1
} finally {
  if (dirty) {
    try {
      rcon(`fill ${x - 4} ${y - 2} ${z - 4} ${x + 4} ${y + 2} ${z + 4} minecraft:air replace minecraft:lava`)
    } catch { /* best effort */ }
  }
  try { rcon('gamerule doFireTick true') } catch { /* best effort */ }
  await bot.disconnect('lava slice done')
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
