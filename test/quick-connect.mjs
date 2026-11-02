import { MinecraftBot } from '../lib/bot.js'

const mc = new MinecraftBot({
  host: '127.0.0.1', port: 25565, username: 'Alex', auth: 'offline', version: '1.21.6', owner: 'FPS1024',
})
mc.on('online', (info) => console.log('ONLINE', info))
mc.on('chat', (e) => console.log('CHAT', e))
mc.on('botError', (e) => console.error('BOT_ERROR', e.message))
try {
  await mc.connect()
  console.log(await mc.observe(12))
  console.log('say:', await mc.say('联机测试，大家好'))
  console.log(await mc.jump())
  const p = mc.bot.entity.position
  console.log(await mc.goto({ x: p.x + 3, y: p.y, z: p.z }, 1))
  console.log(await mc.observe(8))
} catch (e) {
  console.error('FAIL', e)
} finally {
  await mc.disconnect()
  setTimeout(() => process.exit(0), 300)
}
