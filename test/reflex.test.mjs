import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'

import { MinecraftBot } from '../lib/bot.js'
import { GaitController, GazeController, angleDelta } from '../lib/humanizer.js'

function fakeBody() {
  const body = new MinecraftBot({ reflex: false, humanize: false })
  const self = new Vec3(0, 64, 0)
  body.bot = {
    entity: { position: self, yaw: 0, pitch: 0, eyeHeight: 1.62 },
    players: {},
    entities: {},
    world: { raycast: () => null },
    setControlState: () => {},
    isSleeping: false,
    time: { timeOfDay: 6000 },
    isRaining: false,
    thunderState: 0,
    blockAt: (position) => {
      const x = Math.floor(position.x)
      const y = Math.floor(position.y)
      const z = Math.floor(position.z)
      if (x === 1 && y === 63 && z === 0) return { name: 'lava', position: new Vec3(x, y, z) }
      return { name: 'stone', position: new Vec3(x, y, z) }
    },
  }
  return body
}

test('nearbyLava finds lava only within the requested radius', () => {
  const body = fakeBody()
  const lava = body.nearbyLava(2)
  assert.ok(lava)
  assert.equal(lava.name, 'lava')
  assert.equal(body.nearbyLava(1), null)
})

test('sleep refuses during the day', async () => {
  const body = fakeBody()
  await assert.rejects(() => body.sleep(), /不是夜晚/)
})

test('gait sprints on a safe route and sneaks near lava', () => {
  const body = fakeBody()
  const record = {}
  body.status = 'online'
  body.currentIntent = { name: 'goto', meta: {} }
  body.bot.setControlState = (control, value) => { record[control] = value }
  body.nearbyHostiles = () => []
  body.nearbyLava = () => null

  const gait = new GaitController(body)
  gait.tick()
  assert.equal(record.sprint, true)
  assert.equal(record.sneak, false)

  body.nearbyLava = () => ({ name: 'lava', position: new Vec3(2, 64, 0) })
  gait.tick()
  assert.equal(record.sneak, true)
  assert.equal(record.sprint, false)
})

test('gaze turns toward the owner who just spoke', async () => {
  const body = fakeBody()
  const ownerPosition = new Vec3(5, 64, 0)
  const owner = { type: 'player', username: 'FPS1024', position: ownerPosition, height: 1.8 }
  body.status = 'online'
  body.bot.players = { FPS1024: { username: 'FPS1024', entity: owner } }
  body.bot.entities = { 2: { id: 2, ...owner } }
  body.ownerSpokeAt = Date.now()
  body.currentIntent = null
  body.busy = 0
  body.digging = false
  body.following = false

  let looked = null
  body.bot.look = async (yaw, pitch) => {
    body.bot.entity.yaw = yaw
    body.bot.entity.pitch = pitch
    looked = { yaw, pitch }
  }

  const gaze = new GazeController(body)
  for (let i = 0; i < 15; i += 1) await gaze.tick()

  assert.ok(looked)
  assert.ok(Math.abs(angleDelta(looked.yaw, -Math.PI / 2)) < 0.1)
})

test('a body with no connection reports itself as not idle when busy', () => {
  const body = fakeBody()
  assert.equal(body.idle, true)
  body.busy = 1
  assert.equal(body.idle, false)
  body.busy = 0
  assert.equal(body.idle, true)
})
