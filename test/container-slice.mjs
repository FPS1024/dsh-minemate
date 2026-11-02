/**
 * Live check for mc_container. If no chest is nearby, craft one at a crafting
 * table, place it, then list/deposit/withdraw a torch.
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

function findBlocks(name, radius, count = 1) {
  const definition = bot.bot.registry?.blocksByName?.[name]
  if (!definition) return []
  return bot.bot.findBlocks({ matching: definition.id, maxDistance: radius, count })
    .map((position) => bot.bot.blockAt(position))
    .filter(Boolean)
}

function placementSpot() {
  const feet = bot.bot.entity.position
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
    const target = new Vec3(Math.floor(feet.x) + dx, Math.floor(feet.y) + dy, Math.floor(feet.z) + dz)
    const block = bot.bot.blockAt(target)
    if (!block || block.name !== 'air') continue
    const supported = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      .some(([ax, ay, az]) => bot.bot.blockAt(target.offset(ax, ay, az))?.boundingBox === 'block')
    if (supported) return target
  }
  return null
}

function torchCount() {
  return bot.bot.inventory.items()
    .filter((item) => item.name === 'torch')
    .reduce((sum, item) => sum + item.count, 0)
}

try {
  await bot.connect()
  await new Promise((resolve) => setTimeout(resolve, 600))

  let chest = findBlocks('chest', 24, 1)[0] ?? findBlocks('barrel', 24, 1)[0]
  if (!chest) {
    const table = findBlocks('crafting_table', 16, 1)[0]
    if (!table) throw new Error('no chest and no crafting table nearby')
    console.log(`walking to crafting table at ${table.position}`)
    await bot.goto({ x: table.position.x, y: table.position.y, z: table.position.z }, 2)
    console.log('craft:', await bot.craft('chest', 1))
    const spot = placementSpot()
    if (!spot) throw new Error('no supported air block to place the chest')
    console.log('place:', await bot.place('chest', spot.x, spot.y, spot.z))
    chest = findBlocks('chest', 8, 1)[0]
    if (!chest) throw new Error('crafted chest did not appear')
  }

  console.log('list:', await bot.container({ action: 'list' }))

  const before = torchCount()
  if (before === 0) {
    console.log('SKIP deposit/withdraw: no torch')
  } else {
    console.log('deposit:', await bot.container({ action: 'deposit', item: 'torch', count: 1 }))
    console.log('list after deposit:', await bot.container({ action: 'list' }))
    console.log('withdraw:', await bot.container({ action: 'withdraw', item: 'torch', count: 1 }))
    const after = torchCount()
    console.log(`torch count: ${before} -> ${after}`)
    if (Math.abs(after - before) > 1) {
      console.error('CONTAINER CHECK FAILED: inventory did not round-trip')
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error('CONTAINER SLICE FAILED:', error)
  process.exitCode = 1
} finally {
  await bot.disconnect('container slice done')
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}
