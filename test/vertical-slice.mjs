/**
 * Live P1 vertical slice against the local Paper server:
 *   connect -> observe -> scan -> walk -> dig -> pick up -> say -> status.
 *
 * Uses a separate username so it never kicks the real Alex. Flat worlds have
 * no trees, so it falls back to digging a grass/dirt block when no wood exists.
 */
import { MinecraftBot } from '../lib/bot.js'

const bot = new MinecraftBot({
  host: process.env.MINEMATE_MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MINEMATE_MC_PORT ?? 25565),
  username: process.env.MINEMATE_TEST_USER ?? 'AlexTest',
  auth: 'offline',
  version: process.env.MINEMATE_MC_VERSION ?? '1.21.6',
  owner: process.env.MINEMATE_AGENT_OWNER ?? 'FPS1024',
  reflex: false,
})

bot.on('intent:done', (event) => console.log('[intent done]', event.name, event.result))
bot.on('intent:failed', (event) => console.log('[intent failed]', event.name, event.error))
bot.on('botError', (error) => console.error('[bot error]', error.message))

function log(title, value) {
  console.log(`\n--- ${title}\n${value}`)
}

try {
  await bot.connect()
  await new Promise((resolve) => setTimeout(resolve, 800))

  log('observe', bot.observe(12))

  const wood = bot.scanBlocks(['wood'], 32, 8)
  log('scan wood', wood)

  let targetBlock = null
  if (!wood.startsWith('附近 32 格内没有找到')) {
    const match = wood.match(/^(\S+?)(?:（[^）]*）)? @ (-?\d+)\/(-?\d+)\/(-?\d+)/m)
    if (match) targetBlock = match[1]
  }

  if (!targetBlock) {
    const grass = bot.scanBlocks([], 16, 1, 'grass_block')
    log('scan grass', grass)
    targetBlock = 'grass_block'
  }

  const before = bot.statusLine()
  log('before', before)

  if (targetBlock) {
    log('dig', await bot.dig({ block: targetBlock, count: 1 }))
    log('pickup', await bot.pickup(8))
  }

  await bot.say('P1 身体自检完成')
  log('status', bot.statusLine())
  log('observe after', bot.observe(8))
} catch (error) {
  console.error('\nVERTICAL SLICE FAILED:', error)
  process.exitCode = 1
} finally {
  await bot.disconnect('vertical slice done')
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
