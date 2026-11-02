/**
 * Perception helpers for the DSH Minecraft body.
 *
 * Everything here is deliberately independent of DSH. `buildObservation`
 * projects a live mineflayer bot into a compact, model-readable object; the
 * renderer turns that object into a short text block. Block scans use
 * mineflayer's loaded-chunk index instead of a hand-rolled cube, so the model
 * can ask for what it needs instead of receiving a fixed snapshot.
 */

import { Vec3 } from 'vec3'

export const HOSTILE_NAMES = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian',
  'enderman', 'endermite', 'evoker', 'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube',
  'phantom', 'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton',
  'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch', 'wither_skeleton',
  'zoglin', 'zombie', 'zombie_villager', 'zombified_piglin',
])

export const BED_NAMES = new Set([
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed',
  'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed', 'bed',
])

export const FOOD_NAMES = new Set([
  'apple', 'baked_potato', 'beef', 'beetroot', 'beetroot_soup', 'bread', 'carrot', 'chicken',
  'cod', 'cooked_beef', 'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
  'cooked_rabbit', 'cooked_salmon', 'cookie', 'dried_kelp', 'enchanted_golden_apple',
  'golden_apple', 'golden_carrot', 'honey_bottle', 'melon_slice', 'mushroom_stew', 'mutton',
  'porkchop', 'potato', 'pufferfish', 'pumpkin_pie', 'rabbit', 'rabbit_stew', 'rotten_flesh',
  'salmon', 'spider_eye', 'suspicious_stew', 'sweet_berries', 'tropical_fish',
])

const BLOCK_KINDS = [
  ['wood', /(_log|_wood|_stem|_hyphae)$/],
  ['ore', /(_ore|ancient_debris)$/],
  ['stone', /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block)$/],
  ['water', /^(water|flowing_water)$/],
  ['lava', /^(lava|flowing_lava)$/],
  ['chest', /^(chest|trapped_chest|barrel|ender_chest)$/],
  ['table', /^crafting_table$/],
  ['flower', /(^dandelion$|^poppy$|^blue_orchid$|^allium$|^azure_bluet$|^oxeye_daisy$|_tulip$|^cornflower$|^lily_of_the_valley$|^sunflower$|^lilac$|^rose_bush$|^peony$)/],
]

const BLOCK_LABELS = {
  wood: '树木',
  ore: '矿石',
  stone: '石头',
  water: '水',
  lava: '岩浆',
  chest: '箱子',
  table: '工作台',
  flower: '花',
}

const RARE_ITEMS = new Set([
  'diamond', 'diamond_ore', 'deepslate_diamond_ore', 'emerald', 'ancient_debris',
  'netherite_scrap', 'gold_ingot', 'iron_ingot', 'lapis_lazuli', 'redstone',
  'amethyst_shard', 'echo_shard', 'enchanted_book',
])

export function classifyBlockName(name) {
  if (!name) return null
  for (const [kind, pattern] of BLOCK_KINDS) {
    if (pattern.test(name)) return kind
  }
  return null
}

export function blockKindLabel(kind) {
  return BLOCK_LABELS[kind] ?? kind ?? '方块'
}

export function isHostileName(name) {
  return HOSTILE_NAMES.has(name) || name === 'wither' || name === 'ender_dragon'
}

export function classifyEntity(entity) {
  if (!entity) return 'other'
  if (entity.type === 'player' || entity.username) return 'player'
  if (entity.name === 'item' || entity.displayName === 'Item') return 'item'
  if (isHostileName(entity.name)) return 'hostile'
  if (entity.type === 'mob') return 'passive'
  return 'other'
}

export function isRareItem(name) {
  return RARE_ITEMS.has(name)
}

export function posText(position) {
  if (!position) return '未知'
  return `${Math.floor(position.x)}/${Math.floor(position.y)}/${Math.floor(position.z)}`
}

export function distance(a, b) {
  if (!a || !b) return null
  return Math.round(a.distanceTo(b) * 10) / 10
}

export function round(value) {
  return Math.round((Number(value) || 0) * 10) / 10
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function timeLabel(timeOfDay, isDay) {
  if (timeOfDay === undefined || timeOfDay === null) return isDay ? '白天' : '夜晚'
  if (timeOfDay < 1000) return '清晨'
  if (timeOfDay < 5000) return '上午'
  if (timeOfDay < 7000) return '中午'
  if (timeOfDay < 11000) return '下午'
  if (timeOfDay < 13000) return '黄昏'
  if (timeOfDay < 18000) return '夜晚'
  return '深夜'
}

export function weatherLabel(bot) {
  if (!bot?.isRaining) return '晴'
  return (bot.thunderState ?? 0) > 0 ? '雷雨' : '下雨'
}

export function playerOf(bot, name) {
  if (!name) return null
  const lower = String(name).toLowerCase()
  return Object.values(bot?.players ?? {}).find(
    (player) => player.username?.toLowerCase() === lower,
  ) ?? null
}

export function countInventory(bot) {
  const counts = new Map()
  for (const item of bot?.inventory?.items?.() ?? []) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }
  return counts
}

export function inventoryDelta(before, after) {
  const gained = []
  for (const [name, count] of after) {
    const diff = count - (before.get(name) ?? 0)
    if (diff > 0) gained.push(`${name} x${diff}`)
  }
  return gained
}

export function summarizeInventory(bot, limit = 24) {
  const counts = [...countInventory(bot).entries()].sort((a, b) => b[1] - a[1])
  if (counts.length === 0) return '空'
  const text = counts.slice(0, limit).map(([name, count]) => `${name}x${count}`).join('，')
  return counts.length > limit ? `${text} …共${counts.length}种` : text
}

/**
 * Raycast from the bot's eye to an entity's body. Returns true when no solid
 * block blocks the line. Conservative: any raycast failure counts as visible.
 */
export function hasLineOfSight(bot, entity) {
  if (!bot?.entity?.position || !entity?.position) return false
  try {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
    const target = entity.position.offset(0, (entity.height ?? 1.8) * 0.6, 0)
    const delta = target.minus(eye)
    const dist = delta.norm()
    if (dist < 0.75) return true
    const hit = bot.world?.raycast?.(eye, delta.scaled(1 / dist), dist)
    if (!hit?.position) return true
    return hit.position.distanceTo(eye) >= dist - 0.6
  } catch {
    return true
  }
}

function toVec(position) {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function byDistance(a, b) {
  return a.distance - b.distance
}

function entityView(bot, entity, self) {
  const kind = classifyEntity(entity)
  return {
    id: entity.id,
    name: entity.username ?? entity.name ?? entity.displayName ?? '未知',
    kind,
    distance: round(entity.position.distanceTo(self)),
    position: toVec(entity.position),
    ...(typeof entity.health === 'number' ? { health: round(entity.health) } : {}),
    ...(kind === 'hostile' || kind === 'player'
      ? { visible: hasLineOfSight(bot, entity) }
      : {}),
  }
}

function groupBlocks(blocks) {
  const groups = new Map()
  for (const block of blocks) {
    const key = `${block.kind ?? 'other'}:${block.name}`
    const entry = groups.get(key) ?? {
      kind: block.kind,
      name: block.name,
      count: 0,
      nearest: Number.POSITIVE_INFINITY,
      position: block.position,
    }
    entry.count += 1
    if (block.distance < entry.nearest) {
      entry.nearest = block.distance
      entry.position = block.position
    }
    groups.set(key, entry)
  }
  return [...groups.values()].sort((a, b) => a.nearest - b.nearest)
}

/**
 * Find blocks in loaded chunks. `block` takes an exact block name; `kinds`
 * accepts either class names (wood/ore/stone/...) or exact block names.
 * `visibleOnly` applies mineflayer's line-of-sight test per block.
 */
export function findNearbyBlocks(bot, options = {}) {
  if (!bot?.findBlocks || !bot?.entity) return []
  const radius = clamp(options.radius ?? 24, 1, 64)
  const limit = clamp(options.limit ?? 32, 1, 128)
  const blockName = options.block ? String(options.block).toLowerCase() : null
  const kinds = new Set((options.kinds ?? []).map((kind) => String(kind).toLowerCase()))
  const exactNames = new Set((options.names ?? []).map((name) => String(name).toLowerCase()))

  let matching
  if (blockName) {
    const definition = bot.registry?.blocksByName?.[blockName]
    if (!definition) return []
    matching = definition.id
  } else if (kinds.size > 0 || exactNames.size > 0 || options.visibleOnly) {
    matching = (block) => {
      if (!block?.name) return false
      if (options.visibleOnly && !bot.canSeeBlock?.(block)) return false
      if (exactNames.has(block.name)) return true
      const kind = classifyBlockName(block.name)
      return Boolean(kind && kinds.has(kind))
    }
  } else {
    matching = (block) => classifyBlockName(block?.name) !== null
  }

  let positions = []
  try {
    positions = bot.findBlocks({
      matching,
      maxDistance: radius,
      count: Math.max(limit * 3, 64),
    })
  } catch {
    return []
  }

  const self = bot.entity.position
  const blocks = []
  for (const position of positions) {
    const block = bot.blockAt(position)
    if (!block?.name) continue
    if (options.visibleOnly && !bot.canSeeBlock?.(block)) continue
    blocks.push({
      name: block.name,
      kind: classifyBlockName(block.name),
      position: toVec(position),
      distance: round(position.distanceTo(self)),
    })
    if (blocks.length >= limit) break
  }
  return blocks.sort(byDistance)
}

/**
 * Build the structured observation the tools render and the companion uses
 * for proactive turns. It is intentionally complete enough to answer "what is
 * around me?" without a second tool call, but small enough to fit in a prompt.
 */
export function buildObservation(bot, options = {}) {
  if (!bot?.entity) return { online: false, timestamp: Date.now() }

  const radius = clamp(options.radius ?? 14, 2, 48)
  const limit = clamp(options.limit ?? 12, 1, 40)
  const selfPosition = bot.entity.position
  const selfId = bot.entity.id
  const ownerName = options.owner
  const ownerPlayer = playerOf(bot, ownerName)
  const ownerEntity = ownerPlayer?.entity

  const nearbyEntities = Object.values(bot.entities ?? {})
    .filter((entity) => entity?.position && entity.id !== selfId)
    .filter((entity) => entity.position.distanceTo(selfPosition) <= radius)
    .map((entity) => entityView(bot, entity, selfPosition))
    .sort(byDistance)

  const players = nearbyEntities.filter((entity) => entity.kind === 'player').slice(0, limit)
  const hostiles = nearbyEntities.filter((entity) => entity.kind === 'hostile').slice(0, limit)
  const passives = nearbyEntities.filter((entity) => entity.kind === 'passive').slice(0, limit)
  const drops = nearbyEntities.filter((entity) => entity.kind === 'item').slice(0, limit)

  const blockRadius = clamp(options.blockRadius ?? Math.min(32, radius + 6), 1, 48)
  const blocks = options.includeBlocks === false
    ? []
    : findNearbyBlocks(bot, { radius: blockRadius, limit: options.blockLimit ?? 64 })
  const blockGroups = groupBlocks(blocks)

  const ground = bot.blockAt?.(selfPosition.offset(0, -1, 0))
  const feet = bot.blockAt?.(selfPosition)
  const head = bot.blockAt?.(selfPosition.offset(0, 1, 0))
  const light = Math.max(
    feet?.light ?? 0,
    feet?.skyLight ?? 0,
    head?.light ?? 0,
    head?.skyLight ?? 0,
  )

  const inventory = (bot.inventory?.items?.() ?? []).map((item) => ({
    name: item.name,
    count: item.count,
    slot: item.slot,
  }))
  const equipment = {
    hand: bot.heldItem?.name ?? null,
    offhand: bot.inventory?.slots?.[45]?.name ?? null,
    head: bot.inventory?.slots?.[5]?.name ?? null,
    torso: bot.inventory?.slots?.[6]?.name ?? null,
    legs: bot.inventory?.slots?.[7]?.name ?? null,
    feet: bot.inventory?.slots?.[8]?.name ?? null,
  }

  return {
    online: true,
    timestamp: Date.now(),
    self: {
      username: bot.username,
      position: toVec(selfPosition),
      health: round(bot.health ?? 20),
      food: round(bot.food ?? 20),
      oxygen: round(bot.oxygenLevel ?? 20),
      gameMode: bot.game?.gameMode ?? 'unknown',
      dimension: bot.game?.dimension ?? 'unknown',
      time: timeLabel(bot.time?.timeOfDay, bot.time?.isDay),
      day: bot.time?.day,
      weather: weatherLabel(bot),
      heldItem: bot.heldItem?.name ?? null,
      ground: ground?.name ?? 'unknown',
      feet: feet?.name ?? 'unknown',
      head: head?.name ?? 'unknown',
      light,
      biome: ground?.biome?.name ?? 'unknown',
      onGround: bot.entity.onGround,
      yaw: round(bot.entity.yaw),
      pitch: round(bot.entity.pitch),
    },
    owner: ownerPlayer
      ? {
          name: ownerName,
          online: true,
          visible: Boolean(ownerEntity),
          ...(ownerEntity
            ? {
                position: toVec(ownerEntity.position),
                distance: round(ownerEntity.position.distanceTo(selfPosition)),
                health: round(ownerEntity.health),
                heldItem: ownerEntity.heldItem?.name ?? null,
                visibleLine: hasLineOfSight(bot, ownerEntity),
              }
            : {}),
        }
      : { name: ownerName, online: false, visible: false },
    players,
    hostiles,
    passives,
    drops,
    blocks,
    blockGroups,
    inventory,
    equipment,
  }
}

export function renderObservation(observation) {
  if (!observation?.online) return '还没进入游戏（当前离线）。'
  const self = observation.self
  const lines = []

  lines.push(
    `你 ${self.username} 在 ${posText(self.position)}（${self.dimension}），${self.time}${self.day ? ` 第${self.day}天` : ''}，${self.weather}。`,
  )
  lines.push(
    `血量 ${self.health}/20，饥饿 ${self.food}/20，氧气 ${self.oxygen}/20；脚下方块 ${self.ground}，手持 ${self.heldItem ?? '空手'}。`,
  )

  if (!observation.owner?.online) {
    lines.push(`主人 ${observation.owner?.name ?? '?'}：不在线。`)
  } else if (observation.owner.visible) {
    lines.push(
      `主人 ${observation.owner.name}：距离 ${observation.owner.distance} 格，位置 ${posText(observation.owner.position)}，血量 ${observation.owner.health}/20，手持 ${observation.owner.heldItem ?? '空手'}${observation.owner.visibleLine === false ? '（视线被挡住）' : ''}。`,
    )
  } else {
    lines.push(`主人 ${observation.owner.name}：在线，但不在视野内。`)
  }

  if (observation.players.length > 0) {
    lines.push(`附近玩家：${observation.players.map((player) => `${player.name}（${player.distance}格）`).join('，')}。`)
  }

  if (observation.hostiles.length > 0) {
    lines.push(
      `⚠ 敌对生物：${observation.hostiles.map((mob) => `${mob.name}（${mob.distance}格${mob.visible === false ? '，被挡住' : ''}）`).join('，')}。`,
    )
  }

  if (observation.passives.length > 0) {
    lines.push(`附近动物：${observation.passives.map((mob) => `${mob.name}（${mob.distance}格）`).join('，')}。`)
  }

  if (observation.drops.length > 0) {
    lines.push(`地上掉落物：${observation.drops.length} 个（最近 ${observation.drops[0].distance} 格）。`)
  } else {
    lines.push('地上没有掉落物。')
  }

  if (observation.blockGroups.length > 0) {
    lines.push(
      `附近资源：${observation.blockGroups
        .slice(0, 10)
        .map((group) => `${blockKindLabel(group.kind)} ${group.name} x${group.count}（最近 ${group.nearest} 格 @ ${posText(group.position)}）`)
        .join('；')}。`,
    )
  } else {
    lines.push('附近没有识别到树木/矿石/水源/箱子/工作台。')
  }

  const inventory = observation.inventory.length > 0
    ? observation.inventory
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 24)
        .map((item) => `${item.name}x${item.count}`)
        .join('，')
    : '空'
  lines.push(`背包：${inventory}。`)

  return lines.join('\n')
}

export function renderScan(blocks, selfPosition) {
  if (!blocks || blocks.length === 0) return '附近没有找到符合条件的方块。'
  return blocks
    .map((block) => {
      const d = selfPosition ? round(new Vec3(block.position.x, block.position.y, block.position.z).distanceTo(selfPosition)) : block.distance
      return `${block.name}${block.kind ? `（${blockKindLabel(block.kind)}）` : ''} @ ${posText(block.position)}（${d} 格）`
    })
    .join('\n')
}
