/**
 * Live check for mc_sleep/mc_wake. Start the server at night (or run with the
 * comments below) and make sure Alex can find the bed, lie down and get up.
 */
import { MinecraftBot } from '../lib/bot.js'

const bot = new MinecraftBot({
  host: process.env.MINEMATE_MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MINEMATE_MC_PORT ?? 25565),
  username: process.env.MINEMATE_TEST_USER ?? 'Alex',
  auth: 'offline',
  version: process.env.MINEMATE_MC_VERSION ?? '1.21.6',
  owner: process.env.MINEMATE_AGENT_OWNER ?? 'FPS1024',
  reflex: false,
  autoSleep: false,
})

try {
  await bot.connect()
  await new Promise((resolve) => setTimeout(resolve, 600))
  const bed = bot._findBed(16)
  if (!bed) {
    console.log('SKIP: no bed within 16 blocks')
  } else {
    console.log(`bed at ${bed.position.x}/${bed.position.y}/${bed.position.z}, time=${bot.bot.time?.timeOfDay}`)
    console.log('sleep:', await bot.sleep())
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    console.log('isSleeping:', bot.bot.isSleeping)
    console.log('wake:', await bot.wake())
    console.log('isSleeping after wake:', bot.bot.isSleeping)
  }
} catch (error) {
  console.error('SLEEP SLICE FAILED:', error)
  process.exitCode = 1
} finally {
  await bot.disconnect('sleep slice done')
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
