/**
 * Live check for the placement success detector. Places one torch next to a
 * solid block and expects a real "放了 torch" result, not the old false
 * negative caused by `boundingBox === "empty"`.
 */
import { Vec3 } from 'vec3'
import { MinecraftBot } from '../lib/bot.js'

const bot = new MinecraftBot({
  host: process.env.MINEMATE_MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MINEMATE_MC_PORT ?? 25565),
  username: process.env.MINEMATE_TEST_USER ?? 'Alex',
  auth: 'offline',
  version: process.env.MINEMATE_MC_VERSION ?? '1.21.6',
  owner: process.env.MINEMATE_AGENT_OWNER ?? 'FPS1024',
  reflex: false,
})

try {
  await bot.connect()
  const torch = bot.bot.inventory.items().find((item) => item.name === 'torch')
  if (!torch) {
    console.log('SKIP: no torch in inventory')
  } else {
    const feet = bot.bot.entity.position
    const candidates = []
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
      const target = new Vec3(Math.floor(feet.x) + dx, Math.floor(feet.y) + dy, Math.floor(feet.z) + dz)
      const block = bot.bot.blockAt(target)
      if (!block || block.name !== 'air') continue
      const supported = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
        .some(([ax, ay, az]) => bot.bot.blockAt(target.offset(ax, ay, az))?.boundingBox === 'block')
      if (supported) candidates.push(target)
    }

    if (candidates.length === 0) {
      console.log('SKIP: no supported air block next to the bot')
    } else {
      const target = candidates[0]
      console.log(`placing torch at ${target.x}/${target.y}/${target.z}`)
      const result = await bot.place('torch', target.x, target.y, target.z)
      console.log(result)
      if (!/放了 torch/.test(result)) {
        console.error('PLACE CHECK FAILED: expected a successful placement')
        process.exitCode = 1
      }
    }
  }
} catch (error) {
  console.error('PLACE SLICE FAILED:', error)
  process.exitCode = 1
} finally {
  await bot.disconnect('place slice done')
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
