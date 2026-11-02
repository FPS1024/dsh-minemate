import { MinecraftBot } from '../lib/bot.js'

const mc = new MinecraftBot({ host: '127.0.0.1', port: 25565, username: 'Alex', auth: 'offline', version: '1.21.6', owner: 'FPS1024' })
mc.on('botError', (e) => console.error('BOT_ERROR', e.message))
const step = async (name, fn) => { try { console.log(`--- ${name}\n` + await fn()) } catch (e) { console.log(`--- ${name} FAILED: ${e.message}`) } }
try {
  await mc.connect()
  await new Promise(r => setTimeout(r, 1000))
  await step('scan wood', () => mc.scanBlocks(['wood'], 40, 12))
  await step('craft planks', () => mc.craft('oak_planks', 4))
  await step('craft sticks', () => mc.craft('stick', 4))
  const p = mc.bot.entity.position
  await step('place block', () => mc.place('oak_planks', Math.floor(p.x) + 1, Math.floor(p.y), Math.floor(p.z)))
  await step('dig placed', () => mc.dig({ x: Math.floor(p.x) + 1, y: Math.floor(p.y), z: Math.floor(p.z) }))
  await step('dig nearest grass', () => mc.dig({ block: 'grass_block', count: 1 }))
  await step('eat', () => mc.eat())
} catch (e) { console.error('FAIL', e) } finally { await mc.disconnect(); setTimeout(() => process.exit(0), 300) }
