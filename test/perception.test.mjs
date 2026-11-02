import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'

import {
  buildObservation,
  classifyBlockName,
  classifyEntity,
  findNearbyBlocks,
  isHostileName,
  posText,
  renderObservation,
} from '../lib/perception.js'

function block(name, x, y, z) {
  return {
    name,
    position: new Vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    light: 15,
    skyLight: 15,
    biome: { name: 'plains' },
  }
}

function fakeBot() {
  const blocks = [
    block('grass_block', 0, 63, 0),
    block('oak_log', 3, 64, 0),
    block('oak_log', 3, 65, 0),
    block('stone', -2, 63, 1),
  ]
  const byPosition = new Map(blocks.map((entry) => [`${entry.position.x},${entry.position.y},${entry.position.z}`, entry]))
  const self = new Vec3(0, 64, 0)
  const owner = {
    id: 99,
    type: 'player',
    username: 'FPS1024',
    position: new Vec3(6, 64, 0),
    height: 1.8,
    health: 20,
    heldItem: { name: 'stone_sword' },
  }
  const item = {
    id: 50,
    type: 'object',
    name: 'item',
    position: new Vec3(1, 64, 0),
    height: 0.25,
  }

  return {
    username: 'Alex',
    entity: {
      id: 1,
      position: self,
      height: 1.62,
      onGround: true,
      yaw: 0,
      pitch: 0,
    },
    entities: { 1: { id: 1, position: self }, 50: item, 99: owner },
    players: { FPS1024: { username: 'FPS1024', entity: owner } },
    inventory: {
      items: () => [{ name: 'oak_log', count: 3, slot: 0 }],
      slots: [],
    },
    heldItem: { name: 'oak_log' },
    health: 20,
    food: 18,
    oxygenLevel: 20,
    isRaining: false,
    thunderState: 0,
    time: { timeOfDay: 6000, day: 1, isDay: true },
    game: { dimension: 'overworld', gameMode: 'survival' },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    blockAt: (position) => byPosition.get(`${position.x},${position.y},${position.z}`) ?? block('air', position.x, position.y, position.z),
    findBlocks: ({ matching }) => blocks
      .filter((entry) => {
        if (typeof matching === 'function') return matching(entry)
        return matching === 17 && entry.name === 'oak_log'
      })
      .map((entry) => entry.position),
    canSeeBlock: () => true,
    world: { raycast: () => null },
  }
}

test('classifies blocks and entities', () => {
  assert.equal(classifyBlockName('oak_log'), 'wood')
  assert.equal(classifyBlockName('iron_ore'), 'ore')
  assert.equal(classifyBlockName('grass_block'), null)
  assert.equal(isHostileName('zombie'), true)
  assert.equal(isHostileName('cow'), false)
  assert.equal(classifyEntity({ type: 'player', username: 'FPS1024' }), 'player')
  assert.equal(classifyEntity({ type: 'mob', name: 'zombie' }), 'hostile')
  assert.equal(classifyEntity({ type: 'mob', name: 'cow' }), 'passive')
  assert.equal(classifyEntity({ name: 'item' }), 'item')
  assert.equal(posText(new Vec3(1.9, 64.2, -2.1)), '1/64/-3')
})

test('finds blocks by kind and exact name', () => {
  const bot = fakeBot()
  const wood = findNearbyBlocks(bot, { kinds: ['wood'], radius: 16, limit: 8 })
  assert.deepEqual(wood.map((entry) => entry.name), ['oak_log', 'oak_log'])

  const logs = findNearbyBlocks(bot, { block: 'oak_log', radius: 16, limit: 8 })
  assert.equal(logs.length, 2)
  assert.equal(logs[0].kind, 'wood')
})

test('builds a rich observation and renders it for the model', () => {
  const bot = fakeBot()
  const observation = buildObservation(bot, { owner: 'FPS1024', radius: 14 })
  assert.equal(observation.online, true)
  assert.equal(observation.self.health, 20)
  assert.equal(observation.self.heldItem, 'oak_log')
  assert.equal(observation.owner.visible, true)
  assert.equal(observation.owner.distance, 6)
  assert.equal(observation.drops.length, 1)
  assert.ok(observation.blockGroups.some((group) => group.name === 'oak_log'))

  const text = renderObservation(observation)
  assert.match(text, /你 Alex/)
  assert.match(text, /主人 FPS1024/)
  assert.match(text, /地上掉落物：1 个/)
  assert.match(text, /树木 oak_log/)
  assert.match(text, /背包：oak_logx3/)
})

test('never invents owner health when the protocol does not expose it', () => {
  const bot = fakeBot()
  delete bot.players.FPS1024.entity.health
  const observation = buildObservation(bot, { owner: 'FPS1024', radius: 14 })

  assert.equal(observation.owner.visible, true)
  assert.equal('health' in observation.owner, false)
  assert.match(renderObservation(observation), /血量 未知/)
  assert.doesNotMatch(renderObservation(observation), /血量 0\/20/)
})
