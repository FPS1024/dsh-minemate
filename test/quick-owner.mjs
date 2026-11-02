import mineflayer from 'mineflayer'
import { MinecraftBot } from '../lib/bot.js'

const mc = new MinecraftBot({ host: '127.0.0.1', port: 25565, username: 'Alex', auth: 'offline', version: '1.21.6', owner: 'FPS1024' })
mc.on('ownerJoin', (e) => console.log('OWNER_JOIN', e))
mc.on('ownerLeave', (e) => console.log('OWNER_LEAVE', e))
mc.on('chat', (e) => console.log('ALEX_HEARS', e))
mc.on('botError', (e) => console.error('BOT_ERROR', e.message))
const owner = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'FPS1024', auth: 'offline', version: '1.21.6', hideErrors: true })
owner.on('chat', (username, message) => console.log('OWNER_HEARS', { username, message }))
owner.on('error', e => console.log('OWNER_ERROR', e.message))
owner.once('spawn', () => console.log('OWNER_SPAWN', owner.entity.position))
const sleep = ms => new Promise(r => setTimeout(r, ms))
try {
  await mc.connect()
  if (!owner.entity) await new Promise(resolve => owner.once('spawn', resolve))
  await sleep(1500)
  owner.chat('Alex 你好，来我这边')
  await sleep(1000)
  const p = mc.bot.entity.position
  console.log('place:', await mc.place('oak_planks', Math.floor(p.x) + 1, Math.floor(p.y) + 1, Math.floor(p.z)).catch(e => 'FAIL ' + e.message))
  console.log('goto owner:', await mc.goto('owner', 2).catch(e => 'FAIL ' + e.message))
  console.log('follow:', await mc.follow(2).catch(e => 'FAIL ' + e.message))
  await sleep(4000)
  await mc.stop()
  console.log('observe:\n' + await mc.observe(8))
} catch (e) { console.error('FAIL', e) } finally {
  await mc.disconnect()
  owner.quit()
  setTimeout(() => process.exit(0), 500)
}
