/**
 * Minecraft body for the DSH companion.
 *
 * This module deliberately knows nothing about DSH. It wraps mineflayer and
 * exposes:
 *   - a live, event-backed world view (`observe`, `scanBlocks`, `nearbyDrops`)
 *   - low-level player actions (`move`, `look`, `sneak`, `sprint`, `swing`)
 *   - async intents (`goto`, `dig`, `collect`, `pickup`) that can outlive a
 *     model turn and wake the agent when they finish
 *   - a reflex layer that eats, flees and picks up nearby drops without an LLC
 *
 * The DSH plugin in `../index.js` is a thin adapter over this class.
 */

import { EventEmitter } from 'node:events'
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import collectBlockModule from 'mineflayer-collectblock'
import pvpModule from 'mineflayer-pvp'
import { Vec3 } from 'vec3'

import {
  BED_NAMES,
  buildObservation,
  classifyBlockName,
  classifyEntity,
  clamp,
  countInventory,
  distance,
  findNearbyBlocks,
  FOOD_NAMES,
  inventoryDelta,
  isHostileName,
  isRareItem,
  playerOf,
  posText,
  renderObservation,
  renderScan,
  round,
  summarizeInventory,
  timeLabel,
  weatherLabel,
} from './perception.js'
import { GaitController, GazeController, isNight } from './humanizer.js'

const { pathfinder, Movements } = pathfinderModule
const { goals } = pathfinderModule.default ?? pathfinderModule
const { plugin: collectBlockPlugin } = collectBlockModule
const { plugin: pvpPlugin } = pvpModule

export { classifyBlockName, isHostileName, goals, Vec3 }

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* best effort */ }
      reject(new Error(`${label}（${Math.round(ms / 1000)} 秒）`))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function intentId(prefix, seq) {
  return `${prefix}-${seq}`
}

export class MinecraftBot extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = {
      host: '127.0.0.1',
      port: 25565,
      username: 'Alex',
      auth: 'offline',
      version: '1.21.6',
      owner: 'FPS1024',
      connectTimeoutMs: 25_000,
      reconnect: true,
      reflex: true,
      humanize: true,
      humanizeChat: true,
      reactionDelayMs: 150,
      gaze: true,
      gait: true,
      autoDefend: true,
      avoidLava: true,
      autoSleep: true,
      logger: console,
      random: Math.random,
      ...options,
    }

    this.bot = null
    this.status = 'idle'
    this.desired = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.generation = 0

    this.lastHealth = 20
    this.lastDamageAt = 0
    this.lastEatAt = 0
    this.lastPickupAt = 0
    this.lastHostileAt = 0
    this.lastDefendAt = 0
    this.lastLavaAt = 0
    this.lastSleepAt = 0
    this.ownerSpokeAt = 0
    this.reflexTimer = null
    this.reflexBusy = false
    this.digging = false
    this.explicitSneak = false
    this.explicitSprint = false

    this.busy = 0
    this.intentSeq = 0
    this.currentIntent = null
    this.intents = new Map()
    this.activity = null
    this.following = false
    this.recentChat = []
    this.knownDrops = new Map()

    this.gaze = new GazeController(this, {
      enabled: this.options.gaze !== false,
      random: this.options.random,
    })
    this.gait = new GaitController(this, { enabled: this.options.gait !== false })
  }

  get online() {
    return this.status === 'online' && Boolean(this.bot?.entity)
  }

  get username() {
    return this.bot?.username ?? this.options.username
  }

  get idle() {
    return this.busy === 0 && !this.currentIntent && !this.following
  }

  _log(level, ...args) {
    const logger = this.options.logger
    try {
      const method = logger?.[level]
      if (typeof method === 'function') method.call(logger, ...args)
    } catch { /* logging must never break the body */ }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async connect() {
    if (this.online) return this
    if (this._connecting) return this._connecting
    this.desired = true
    this._connecting = this._open()
    try {
      return await this._connecting
    } catch (error) {
      if (this.desired && this.options.reconnect) this._scheduleReconnect()
      throw error
    } finally {
      this._connecting = null
    }
  }

  async disconnect(reason = 'companion going offline') {
    this.desired = false
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.generation += 1
    this._stopReflex()
    this._stopHumanizers()
    this.cancelCurrentIntent('disconnect')

    const bot = this.bot
    this.bot = null
    this.status = 'idle'
    this.activity = null
    this.following = false
    this.knownDrops.clear()
    if (bot) {
      try { bot.quit(reason) } catch { /* socket already gone */ }
    }
    this.emit('offline', reason)
  }

  requireBot() {
    if (!this.bot || !this.bot.entity) throw new Error('还没连上 Minecraft 服务器')
    return this.bot
  }

  async _open() {
    this.status = 'connecting'
    this._log('info', `[minemate] connecting to ${this.options.host}:${this.options.port} as ${this.options.username}`)

    const bot = mineflayer.createBot({
      host: this.options.host,
      port: Number(this.options.port),
      username: this.options.username,
      auth: this.options.auth,
      version: this.options.version,
      hideErrors: true,
      respawn: true,
      checkTimeoutInterval: 60_000,
    })
    this.bot = bot
    const generation = ++this.generation

    for (const [label, plugin] of [
      ['pathfinder', pathfinder],
      ['collect-block', collectBlockPlugin],
      ['pvp', pvpPlugin],
    ]) {
      try {
        bot.loadPlugin(plugin)
      } catch (error) {
        this.emit('botError', new Error(`加载 ${label} 插件失败：${error.message}`))
      }
    }

    this._attach(bot, generation)

    try {
      await this._waitForSpawn(bot, this.options.connectTimeoutMs, generation)
    } catch (error) {
      if (generation === this.generation) {
        this.status = 'offline'
        try { bot.end('connect failed') } catch { /* already closed */ }
      }
      throw error
    }

    if (generation !== this.generation) throw new Error('连接已取消')
    try {
      await withTimeout(bot.waitForChunksToLoad(), 8_000, '加载区块超时')
    } catch { /* spawn is still usable; chunks stream in */ }

    this.status = 'online'
    this.reconnectAttempt = 0
    this.lastHealth = bot.health ?? 20
    this._configurePathfinder(bot)
    this._startHumanizers()
    this._startReflex()
    this.emit('online', { username: bot.username, version: bot.version })
    this._log('info', `[minemate] online as ${bot.username}`)
    return this
  }

  _configurePathfinder(bot) {
    try {
      if (!bot.pathfinder) return
      const movements = new Movements(bot)
      // A real player does not tunnel through the landscape while walking.
      movements.canDig = false
      movements.allowParkour = true
      movements.allowSprinting = true
      movements.maxDropDown = 4
      // Prefer dry routes; the reflex layer handles lava that is already close.
      movements.liquidCost = 4
      bot.pathfinder.setMovements(movements)
    } catch (error) {
      this._log('debug', '[minemate] pathfinder movement setup failed', error.message)
    }
  }

  _waitForSpawn(bot, timeoutMs, generation) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('end', onEnd)
        bot.removeListener('kicked', onKicked)
        if (error) reject(error)
        else resolve()
      }
      const onSpawn = () => finish()
      const onError = (error) => finish(error instanceof Error ? error : new Error(String(error)))
      const onEnd = (reason) => finish(new Error(`连接被服务器关闭：${reason ?? 'unknown'}`))
      const onKicked = (reason) => finish(new Error(`被服务器踢出：${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
      const timer = setTimeout(() => {
        if (generation === this.generation) {
          try { bot.end('spawn timeout') } catch { /* ignore */ }
        }
        finish(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没进服`))
      }, timeoutMs)
      timer.unref?.()
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
      bot.once('kicked', onKicked)
    })
  }

  _attach(bot, generation) {
    bot.on('chat', (username, message) => {
      if (generation !== this.generation) return
      if (!username || username === bot.username) return
      const event = { username, message: String(message ?? '') }
      this.recentChat.push({ ...event, at: Date.now() })
      if (this.recentChat.length > 40) this.recentChat.shift()
      this.emit('chat', event)
      if (this._isOwner(username)) {
        this.ownerSpokeAt = Date.now()
        this.gaze?.lookAtOwner(3_000)
        this.emit('ownerChat', event)
      } else {
        const speaker = playerOf(bot, username)
        if (speaker?.entity && bot.entity && speaker.entity.position.distanceTo(bot.entity.position) <= 12) {
          this.gaze?.lookAtEntity(speaker.entity, 2_000)
        }
      }
    })

    bot.on('playerJoined', (player) => {
      if (generation !== this.generation) return
      if (this._isOwner(player?.username)) this.emit('ownerJoin', { username: player.username })
    })

    bot.on('playerLeft', (player) => {
      if (generation !== this.generation) return
      if (this._isOwner(player?.username)) this.emit('ownerLeave', { username: player.username })
    })

    bot.on('health', () => {
      if (generation !== this.generation || !bot.entity) return
      const health = bot.health ?? 20
      const now = Date.now()
      if (health < this.lastHealth - 0.5 && now - this.lastDamageAt > 1500) {
        this.lastDamageAt = now
        this.gaze?.lookAtEntity(this.nearbyHostiles(12)[0], 2_500)
        this.emit('damage', { health: round(health), food: round(bot.food ?? 20) })
      }
      this.lastHealth = health
    })

    bot.on('sleep', () => {
      if (generation !== this.generation) return
      this.emit('sleep')
    })

    bot.on('wake', () => {
      if (generation !== this.generation) return
      this.emit('wake')
    })

    bot.on('death', () => {
      if (generation !== this.generation) return
      this.emit('death', { position: bot.entity?.position })
    })

    bot.on('respawn', () => {
      if (generation !== this.generation) return
      this.emit('respawn', { position: bot.entity?.position })
    })

    bot.on('entitySpawn', (entity) => {
      if (generation !== this.generation || !entity?.position || !bot.entity) return
      if (entity.name === 'item') {
        this.knownDrops.set(entity.id, {
          id: entity.id,
          position: entity.position.clone?.(),
          firstSeen: Date.now(),
        })
        this.emit('itemDrop', { id: entity.id, position: entity.position })
        return
      }
      if (!isHostileName(entity.name)) return
      const d = entity.position.distanceTo(bot.entity.position)
      if (d > 12) return
      const now = Date.now()
      if (now - this.lastHostileAt < 10_000) return
      this.lastHostileAt = now
      this.gaze?.lookAtEntity(entity, 2_000)
      this.emit('hostile', {
        name: entity.name,
        distance: Math.round(d),
        position: { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) },
      })
    })

    bot.on('entityGone', (entity) => {
      if (generation !== this.generation) return
      if (entity?.id !== undefined) this.knownDrops.delete(entity.id)
    })

    bot.on('itemDrop', (entity) => {
      if (generation !== this.generation || !entity) return
      this.knownDrops.set(entity.id, {
        id: entity.id,
        position: entity.position?.clone?.(),
        firstSeen: Date.now(),
      })
    })

    bot.on('playerCollect', (collector, collected) => {
      if (generation !== this.generation) return
      if (collector?.id !== bot.entity?.id) return
      const name = collected?.name ?? collected?.displayName ?? '物品'
      this.emit('pickup', { name })
      if (isRareItem(name)) this.emit('rareItem', { name })
    })

    bot.on('entityHurt', (entity) => {
      if (generation !== this.generation) return
      if (entity?.id === bot.entity?.id) {
        this.emit('hurt', { health: round(bot.health ?? 0) })
      }
    })

    bot.on('kicked', (reason) => {
      if (generation !== this.generation) return
      this.emit('kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) })
    })

    bot.on('error', (error) => {
      if (generation !== this.generation) return
      this.emit('botError', error)
    })

    bot.on('end', (reason) => {
      if (generation !== this.generation) return
      this._stopReflex()
      this._stopHumanizers()
      this.cancelCurrentIntent('connection ended')
      this.bot = null
      this.status = 'offline'
      this.activity = null
      this.following = false
      this.knownDrops.clear()
      this.emit('offline', reason)
      if (this.desired && this.options.reconnect) this._scheduleReconnect()
    })
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.desired) return
    const delay = Math.min(15_000, 2_000 * (2 ** Math.min(this.reconnectAttempt, 4)))
    this.reconnectAttempt += 1
    this.status = 'reconnecting'
    this._log('info', `[minemate] reconnecting in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.desired) return
      this._open().catch((error) => {
        this.emit('botError', error)
        if (this.desired) this._scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  _isOwner(name) {
    return this.options.owner && String(name).toLowerCase() === String(this.options.owner).toLowerCase()
  }

  // ---------------------------------------------------------------------------
  // Intents: long-running actions that can outlive a model turn
  // ---------------------------------------------------------------------------

  /**
   * Start one cancellable action. A body does one thing at a time, so starting
   * a new intent cancels the previous one. The returned intent exposes a
   * promise that always resolves to `{ status, result?, error? }`.
   */
  startIntent(name, runner, meta = {}) {
    this.cancelCurrentIntent('replaced by a new action')
    this.following = false
    const id = intentId(name, ++this.intentSeq)
    const controller = new AbortController()
    const intent = {
      id,
      name,
      meta,
      startedAt: Date.now(),
      status: 'running',
      controller,
      promise: null,
    }
    this.currentIntent = intent
    this.intents.set(id, intent)
    this.activity = { id, name, status: 'running', startedAt: intent.startedAt }
    this.emit('intent:started', { id, name })

    intent.promise = (async () => {
      try {
        const result = await runner(controller.signal)
        if (controller.signal.aborted) {
          intent.status = 'cancelled'
          this.emit('intent:cancelled', { id, name })
          return { status: 'cancelled', error: '已取消' }
        }
        intent.status = 'done'
        this.emit('intent:done', { id, name, result })
        return { status: 'done', result }
      } catch (error) {
        const cancelled = controller.signal.aborted
        intent.status = cancelled ? 'cancelled' : 'failed'
        const message = error instanceof Error ? error.message : String(error)
        this.emit(cancelled ? 'intent:cancelled' : 'intent:failed', { id, name, error: message })
        return { status: cancelled ? 'cancelled' : 'failed', error: message }
      } finally {
        if (this.currentIntent === intent) this.currentIntent = null
        this.intents.delete(id)
        if (this.activity?.id === id) this.activity = null
      }
    })()

    return intent
  }

  cancelCurrentIntent(reason = 'cancelled') {
    const intent = this.currentIntent
    if (!intent) return false
    try { intent.controller.abort(reason) } catch { /* ignore */ }
    try { this.bot?.pathfinder?.setGoal?.(null) } catch { /* ignore */ }
    return true
  }

  /** Wait for an intent, but leave it running when the wait budget expires. */
  waitForIntent(intent, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ status: 'pending', intentId: intent.id })
      }, Math.max(1, timeoutMs))
      timer.unref?.()
      intent.promise.then((outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      })
    })
  }

  async runIntent(name, runner, timeoutMs, meta = {}) {
    const intent = this.startIntent(name, runner, meta)
    const outcome = await this.waitForIntent(intent, timeoutMs)
    if (outcome.status === 'pending') {
      return `还在进行（${intent.id}），完成后会通知你。`
    }
    if (outcome.status === 'done') return outcome.result
    if (outcome.status === 'cancelled') return `已取消（${name}）。`
    return `失败（${name}）：${outcome.error ?? '未知错误'}`
  }

  // ---------------------------------------------------------------------------
  // Perception
  // ---------------------------------------------------------------------------

  observeState(radius = 14) {
    return buildObservation(this.bot, {
      owner: this.options.owner,
      radius,
      includeBlocks: true,
    })
  }

  observe(radius = 14) {
    try {
      return renderObservation(this.observeState(radius))
    } catch (error) {
      return `观察失败：${error.message}`
    }
  }

  scanBlocks(kinds = [], radius = 24, limit = 24, block = null) {
    const bot = this.requireBot()
    const blocks = findNearbyBlocks(bot, {
      kinds,
      block,
      radius: clamp(radius, 1, 64),
      limit: clamp(limit, 1, 128),
    })
    if (blocks.length === 0) {
      const wanted = block ?? (kinds.length > 0 ? kinds.join('/') : '可识别资源')
      return `附近 ${radius} 格内没有找到 ${wanted}。`
    }
    return renderScan(blocks, bot.entity.position)
  }

  nearbyDrops(radius = 8) {
    const bot = this.bot
    if (!bot?.entity) return []
    return Object.values(bot.entities ?? {})
      .filter((entity) => entity?.position && entity.name === 'item')
      .filter((entity) => entity.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  }

  nearbyHostiles(radius = 12) {
    const bot = this.bot
    if (!bot?.entity) return []
    return Object.values(bot.entities ?? {})
      .filter((entity) => entity?.position && isHostileName(entity.name))
      .filter((entity) => entity.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  }

  /** Nearest lava block within `radius`, or null. Used by gait and reflex. */
  nearbyLava(radius = 2) {
    const bot = this.bot
    if (!bot?.entity || !bot.blockAt) return null
    const self = bot.entity.position
    const r = Math.min(4, Math.max(1, Math.floor(radius)))
    let nearest = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -2; dy <= 1; dy += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          const block = bot.blockAt(self.offset(dx, dy, dz))
          if (!block?.name || !block.name.includes('lava')) continue
          const d = Math.hypot(dx, dy, dz)
          if (d > radius || d >= nearestDistance) continue
          nearest = { name: block.name, position: block.position }
          nearestDistance = d
        }
      }
    }
    return nearest
  }

  statusLine() {
    if (!this.online) return `Minecraft：${this.status}${this.bot ? `（${this.bot.username}）` : ''}`
    const bot = this.bot
    const owner = playerOf(bot, this.options.owner)
    const activity = this.activity
      ? `，正在 ${this.activity.name}（${Math.round((Date.now() - this.activity.startedAt) / 1000)} 秒）`
      : '，空闲'
    const sleeping = bot.isSleeping ? '，正在睡觉' : ''
    return `Minecraft：在线 ${bot.username}，位置 ${posText(bot.entity.position)}，血量 ${Math.round(bot.health)}/20，饥饿 ${Math.round(bot.food)}/20，主人 ${owner ? (owner.entity ? '在附近' : '在线') : '不在线'}${activity}${sleeping}`
  }

  // ---------------------------------------------------------------------------
  // Movement and body language
  // ---------------------------------------------------------------------------

  async stop() {
    this.cancelCurrentIntent('stop')
    const bot = this.bot
    if (!bot) return
    try { bot.pathfinder?.setGoal?.(null) } catch { /* ignore */ }
    try { bot.clearControlStates?.() } catch { /* ignore */ }
    try { await bot.pvp?.stop?.() } catch { /* ignore */ }
    try { bot.stopDigging?.() } catch { /* ignore */ }
    this.activity = null
    this.following = false
    this.explicitSneak = false
    this.explicitSprint = false
    this.emit('stopped')
  }

  async goto(target, range = 2, options = {}) {
    const timeoutMs = options.timeoutMs ?? 25_000
    const wait = options.wait !== false
    const point = this._resolvePoint(target)
    const intent = this.startIntent(
      'goto',
      (signal) => this._runGoto(point, clamp(range, 0, 8), signal),
      { target: point },
    )
    if (!wait) return `出发去 ${posText(point)}（${intent.id}）。`
    const outcome = await this.waitForIntent(intent, timeoutMs)
    if (outcome.status === 'done') return outcome.result
    if (outcome.status === 'pending') {
      return `还在去 ${posText(point)} 的路上（${intent.id}），到了会告诉你。`
    }
    if (outcome.status === 'cancelled') return `去 ${posText(point)} 的路上被取消了。`
    return `没走到 ${posText(point)}：${outcome.error ?? '未知错误'}`
  }

  async _runGoto(point, range, signal) {
    const bot = this.requireBot()
    if (signal.aborted) throw new Error('已取消')
    const goal = new goals.GoalNear(point.x, point.y, point.z, range)
    const onAbort = () => {
      try { bot.pathfinder.setGoal(null) } catch { /* ignore */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.pathfinder.goto(goal)
      if (signal.aborted) throw new Error('已取消')
      return `到达 ${posText(bot.entity.position)}，距离目标 ${distance(bot.entity.position, point)} 格。`
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async follow(distanceToOwner = 3) {
    const bot = this.requireBot()
    const owner = playerOf(bot, this.options.owner)
    if (!owner?.entity) throw new Error(`看不到主人 ${this.options.owner}，无法跟随`)
    try { bot.pathfinder.setGoal(null) } catch { /* ignore */ }
    bot.pathfinder.setGoal(new goals.GoalFollow(owner.entity, Math.max(1, distanceToOwner)), true)
    this.following = true
    this.activity = { id: 'follow', name: 'follow', status: 'running', startedAt: Date.now() }
    this.emit('follow', { distance: distanceToOwner })
    return `开始跟随主人，保持 ${distanceToOwner} 格左右。`
  }

  async move(direction, seconds = 1, options = {}) {
    const bot = this.requireBot()
    const controls = { forward: 'forward', back: 'back', left: 'left', right: 'right' }
    const control = controls[direction]
    if (!control) throw new Error(`方向只能是 forward/back/left/right，收到 ${direction}`)
    return this._withAction(async () => {
      if (options.sprint) bot.setControlState('sprint', true)
      if (options.sneak) bot.setControlState('sneak', true)
      bot.setControlState(control, true)
      try {
        await sleep(clamp(Number(seconds) || 1, 0.1, 10) * 1000)
      } finally {
        bot.setControlState(control, false)
        if (options.sprint) bot.setControlState('sprint', false)
        if (options.sneak) bot.setControlState('sneak', false)
      }
      return `向 ${direction} 移动了 ${round(clamp(Number(seconds) || 1, 0.1, 10))} 秒。`
    })
  }

  async jump() {
    const bot = this.requireBot()
    return this._withAction(async () => {
      bot.setControlState('jump', true)
      await sleep(220)
      bot.setControlState('jump', false)
      return '跳了一下。'
    })
  }

  async sneak(enabled) {
    const bot = this.requireBot()
    this.explicitSneak = Boolean(enabled)
    bot.setControlState('sneak', this.explicitSneak)
    return enabled ? '开始潜行。' : '停止潜行。'
  }

  async sprint(enabled) {
    const bot = this.requireBot()
    this.explicitSprint = Boolean(enabled)
    bot.setControlState('sprint', this.explicitSprint)
    return enabled ? '开始冲刺。' : '停止冲刺。'
  }

  async swing() {
    const bot = this.requireBot()
    try {
      bot.swingArm('right')
    } catch {
      bot.swingArm?.()
    }
    return '挥了一下手。'
  }

  async look(target) {
    const bot = this.requireBot()
    this.gaze?.suspend(1_500)
    return this._withAction(async () => {
      if (target === 'owner') {
        const owner = playerOf(bot, this.options.owner)
        if (!owner?.entity) throw new Error(`看不到主人 ${this.options.owner}`)
        await bot.lookAt(owner.entity.position.offset(0, 1.6, 0), true)
        return `看向主人 ${this.options.owner}。`
      }
      if (target === 'up') {
        await bot.look(bot.entity.yaw, -Math.PI / 3, true)
        return '抬头看。'
      }
      if (target === 'down') {
        await bot.look(bot.entity.yaw, Math.PI / 3, true)
        return '低头看。'
      }
      if (target === 'around') {
        await bot.look(bot.entity.yaw + Math.PI / 2, 0, true)
        return '环顾四周。'
      }
      if (target === 'nearest_hostile') {
        const hostile = this.nearbyHostiles(16)[0]
        if (!hostile) throw new Error('附近没有敌对生物')
        await bot.lookAt(hostile.position.offset(0, 1, 0), true)
        return `看向 ${hostile.name}。`
      }
      const point = this._resolvePoint(target)
      await bot.lookAt(point.offset(0.5, 0.5, 0.5), true)
      return `看向 ${posText(point)}。`
    })
  }

  // ---------------------------------------------------------------------------
  // World interaction
  // ---------------------------------------------------------------------------

  async dig(options = {}) {
    const bot = this.requireBot()
    const count = clamp(Number(options.count) || 1, 1, 16)
    const radius = clamp(Number(options.radius) || 32, 1, 64)
    const targets = this._resolveDigTargets(options, count, radius)
    if (targets.length === 0) throw new Error('没有找到可挖的目标方块')
    return this.runIntent('dig', async (signal) => {
      const before = countInventory(bot)
      const done = []
      for (const block of targets) {
        if (signal.aborted) throw new Error('已取消')
        const result = await this._digOne(block, signal)
        if (result) done.push(result)
      }
      if (done.length === 0) throw new Error('没能挖掉目标方块（可能距离太远、工具不对或被挡住）')
      await sleep(250)
      await this._collectNearbyDrops(4)
      const gained = inventoryDelta(before, countInventory(bot))
      return `挖掉了 ${done.length} 个方块（${done.slice(0, 8).join(', ')}${done.length > 8 ? '…' : ''}）${gained.length ? `，获得：${gained.join('，')}` : '，但没捡到掉落物'}。`
    }, options.timeoutMs ?? 35_000)
  }

  _resolveDigTargets(options, count, radius) {
    const bot = this.requireBot()
    if (Number.isFinite(options.x) && Number.isFinite(options.y) && Number.isFinite(options.z)) {
      const block = bot.blockAt(new Vec3(Math.floor(options.x), Math.floor(options.y), Math.floor(options.z)))
      return block && block.boundingBox !== 'empty' ? [block] : []
    }
    if (options.block) {
      const blocks = findNearbyBlocks(bot, { block: options.block, radius, limit: count })
      if (blocks.length === 0) throw new Error(`附近 ${radius} 格没有 ${options.block}`)
      return blocks.map((entry) => bot.blockAt(new Vec3(entry.position.x, entry.position.y, entry.position.z))).filter(Boolean)
    }
    const found = bot.findBlocks({
      matching: (block) => block?.boundingBox === 'block' && block.name !== 'bedrock',
      maxDistance: Math.min(radius, 5),
      count,
    })
    return found.map((position) => bot.blockAt(position)).filter(Boolean)
  }

  async _digOne(block, signal) {
    const bot = this.requireBot()
    if (!block || block.boundingBox === 'empty') return null
    if (signal?.aborted) throw new Error('已取消')
    const position = block.position
    this.digging = true
    try {
      if (bot.entity.position.distanceTo(position) > 4.5) {
        try {
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 2)),
            15_000,
            '走近方块超时',
            () => { try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } },
          )
        } catch {
          return null
        }
      }
      this._checkTool(block)
      this.gaze?.suspend(2_000)
      await bot.lookAt(position.offset(0.5, 0.5, 0.5), true).catch(() => {})
      await this.humanDelay(120, 280)
      await withTimeout(
        bot.dig(block, true),
        20_000,
        '挖掘超时',
        () => { try { bot.stopDigging() } catch { /* ignore */ } },
      )
      return block.name
    } catch {
      return null
    } finally {
      this.digging = false
    }
  }

  async collect(blockName, count = 1, radius = 32) {
    const bot = this.requireBot()
    const wanted = clamp(Number(count) || 1, 1, 64)
    const intent = this.startIntent('collect', async (signal) => {
      const before = countInventory(bot)
      let dug = 0
      for (let attempt = 0; attempt < wanted * 4; attempt += 1) {
        if (signal.aborted) throw new Error('已取消')
        const gained = inventoryDelta(before, countInventory(bot))
        if (gained.length > 0) {
          // Count only the requested block when possible.
          const have = countInventory(bot).get(blockName) ?? 0
          const start = before.get(blockName) ?? 0
          if (have - start >= wanted) break
        }
        const blocks = findNearbyBlocks(bot, { block: blockName, radius, limit: 4 })
        if (blocks.length === 0) break
        let progressed = false
        for (const entry of blocks) {
          const block = bot.blockAt(new Vec3(entry.position.x, entry.position.y, entry.position.z))
          if (!block) continue
          const result = await this._digOne(block, signal)
          if (result) {
            dug += 1
            progressed = true
            this.emit('intent:progress', { id: intent.id, name: 'collect', dug, wanted })
            break
          }
        }
        if (!progressed) break
        await this._collectNearbyDrops(4)
      }
      await this._collectNearbyDrops(4)
      const gained = inventoryDelta(before, countInventory(bot))
      return gained.length > 0
        ? `采集完成，获得：${gained.join('，')}（挖了 ${dug} 次）。`
        : `采了 ${blockName}，但背包没有增加（可能被别的玩家捡走了）。`
    }, { block: blockName, count: wanted })
    return `开始采集 ${blockName} x${wanted}（${intent.id}），完成会通知你。`
  }

  async pickup(radius = 8, options = {}) {
    const bot = this.requireBot()
    const r = clamp(Number(radius) || 8, 1, 32)
    const outcome = await this.runIntent('pickup', async (signal) => {
      if (signal.aborted) throw new Error('已取消')
      const gained = await this._collectNearbyDrops(r, signal)
      return gained.length > 0
        ? `捡到了：${gained.join('，')}。`
        : '地上没有能捡的掉落物。'
    }, options.timeoutMs ?? 20_000)
    return outcome
  }

  async _collectNearbyDrops(radius, signal) {
    const bot = this.requireBot()
    const before = countInventory(bot)
    const deadline = Date.now() + 5_000
    let lastSeenAt = 0

    // The server spawns the item entity a tick or two after the block breaks,
    // and the client learns about it even later. Wait for it instead of
    // reporting "nothing to pick up" in the same tick as the dig.
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('已取消')
      const drops = this.nearbyDrops(radius).slice(0, 8)
      if (drops.length === 0) {
        if (lastSeenAt > 0 && Date.now() - lastSeenAt > 1_500) break
        await sleep(180)
        continue
      }
      lastSeenAt = Date.now()

      for (const drop of drops) {
        if (signal?.aborted) throw new Error('已取消')
        if (!bot.entities?.[drop.id]) continue
        try {
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.7)),
            6_000,
            '捡东西超时',
          )
        } catch {
          continue
        }

        // Pickup is server-side: keep standing on the item until the entity
        // disappears (or we decide it is unreachable/stuck).
        const pickupUntil = Date.now() + 1_500
        while (bot.entities?.[drop.id] && Date.now() < pickupUntil) {
          if (signal?.aborted) throw new Error('已取消')
          await sleep(100)
        }
      }

      if (this.nearbyDrops(radius).length === 0) break
      await sleep(200)
    }

    await sleep(250)
    return inventoryDelta(before, countInventory(bot))
  }

  async place(itemName, x, y, z) {
    const bot = this.requireBot()
    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const self = bot.entity.position
    const feetY = Math.floor(self.y)
    if (Math.floor(self.x) === target.x && Math.floor(self.z) === target.z && target.y >= feetY && target.y <= feetY + 1) {
      throw new Error('那个位置会把自己卡住')
    }
    const existing = bot.blockAt(target)
    if (existing?.name && !['air', 'cave_air', 'void_air'].includes(existing.name)) {
      throw new Error(`位置 ${posText(target)} 已经被 ${existing.name} 占了`)
    }

    return this._withAction(async () => {
      const item = bot.inventory.items().find((candidate) => candidate.name === itemName)
      if (!item) throw new Error(`背包里没有 ${itemName}`)
      if (bot.entity.position.distanceTo(target) > 4) {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)),
          20_000,
          '走近放置点超时',
        )
      }
      if (bot.heldItem?.name !== itemName) {
        const current = bot.inventory.items().find((candidate) => candidate.name === itemName)
        if (!current) throw new Error(`背包里没有 ${itemName}`)
        await bot.equip(current, 'hand')
      }
      this.gaze?.suspend(1_500)
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true).catch(() => {})

      const reference = this._placementReference(bot, target)
      if (!reference) throw new Error('目标旁边没有可以依附的方块')
      await this.humanDelay(120, 260)
      await withTimeout(bot.placeBlock(reference.block, reference.face), 8_000, '放置超时')
      // The block-update packet arrives after placeBlock resolves, and
      // non-colliding blocks (torch, flower, button) report
      // `boundingBox === "empty"`. Wait for the name instead of trusting the
      // first snapshot.
      const placed = await this._waitForPlacedBlock(target, 1_500)
      if (!placed) throw new Error('放置没有生效')
      return `在 ${posText(target)} 放了 ${placed.name}。`
    })
  }

  async _waitForPlacedBlock(target, timeoutMs) {
    const bot = this.requireBot()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const block = bot.blockAt(target)
      if (block?.name && !['air', 'cave_air', 'void_air'].includes(block.name)) return block
      await sleep(100)
    }
    return null
  }

  _placementReference(bot, target) {
    const neighbours = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
    for (const [dx, dy, dz] of neighbours) {
      const block = bot.blockAt(target.offset(dx, dy, dz))
      if (!block || block.boundingBox !== 'block') continue
      return { block, face: new Vec3(-dx, -dy, -dz) }
    }
    return null
  }

  async attack(target = 'nearest_hostile', radius = 12, options = {}) {
    const bot = this.requireBot()
    const entity = this._resolveEntity(target, radius)
    if (!entity) throw new Error(target === 'nearest_hostile' ? `附近 ${radius} 格没有敌对生物` : `找不到 ${target}`)
    const name = entity.username ?? entity.name ?? '目标'
    if (!bot.pvp) throw new Error('PVP 模块没有加载')
    return this._withAction(async () => {
      this.gaze?.suspend(3_000)
      bot.pvp.followRange = 2
      bot.pvp.attackRange = 3
      bot.pvp.viewDistance = Math.max(radius + 4, 16)
      try {
        await this.humanDelay(120, 280)
        await withTimeout(
          bot.pvp.attack(entity),
          options.timeoutMs ?? 15_000,
          '战斗超时',
          () => { void bot.pvp.stop?.().catch?.(() => {}) },
        )
      } finally {
        await bot.pvp.stop?.().catch?.(() => {})
      }
      const gone = !bot.entities?.[entity.id]
      return `${gone ? '击败了' : '攻击了'} ${name}${gone ? '' : '，它还没死'}。血量 ${Math.round(bot.health)}/20。`
    })
  }

  _resolveEntity(target, radius) {
    const bot = this.requireBot()
    const self = bot.entity.position
    if (target === 'nearest_hostile' || target === 'hostile') {
      return Object.values(bot.entities ?? {})
        .filter((entity) => entity?.position && entity.position.distanceTo(self) <= radius && isHostileName(entity.name))
        .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))[0] ?? null
    }
    const player = playerOf(bot, target)
    if (player?.entity) return player.entity
    return Object.values(bot.entities ?? {})
      .filter((entity) => (entity?.username ?? entity?.name) === target && entity.position)
      .sort((a, b) => a.position.distanceTo(self) - b.position.distanceTo(self))[0] ?? null
  }

  async eat() {
    const bot = this.requireBot()
    if ((bot.food ?? 20) >= 20) return '现在不饿，不用吃东西。'
    return this._withAction(async () => {
      const food = bot.inventory.items().find((item) => FOOD_NAMES.has(item.name) || bot.registry?.foodsByName?.[item.name])
      if (!food) throw new Error('背包里没有食物')
      await bot.equip(food, 'hand')
      try {
        await withTimeout(bot.consume(), 8_000, '吃东西超时')
      } catch (error) {
        if (/full/i.test(error.message)) return '现在不饿，不用吃东西。'
        throw error
      }
      return `吃了 ${food.name}，饥饿 ${Math.round(bot.food)}/20，血量 ${Math.round(bot.health)}/20。`
    })
  }

  async craft(itemName, count = 1) {
    const bot = this.requireBot()
    return this._withAction(async () => {
      const definition = bot.registry?.itemsByName?.[itemName]
      if (!definition) throw new Error(`未知物品：${itemName}`)
      const tableBlock = this._findCraftingTable()
      let recipes = bot.recipesFor(definition.id, null, 1, tableBlock)
      if ((!recipes || recipes.length === 0) && tableBlock) recipes = bot.recipesFor(definition.id, null, 1, null)
      if (!recipes || recipes.length === 0) {
        throw new Error(`现在做不了 ${itemName}：材料不足${tableBlock ? '' : '，或者附近没有工作台'}`)
      }
      if (!tableBlock && recipes[0].requiresTable) {
        throw new Error(`做 ${itemName} 需要工作台，附近没有`)
      }
      const recipe = recipes[0]
      const times = Math.max(1, Math.ceil(count / (recipe.result?.count ?? 1)))
      const before = countInventory(bot)
      await this.stop()
      await withTimeout(bot.craft(recipe, times, tableBlock), 20_000, '合成超时')
      await sleep(150)
      const gained = inventoryDelta(before, countInventory(bot))
      return gained.length > 0 ? `合成完成，获得：${gained.join('，')}。` : `合成 ${itemName} 没有生效。`
    })
  }

  _findCraftingTable() {
    const bot = this.requireBot()
    const found = bot.findBlocks({ matching: (block) => block?.name === 'crafting_table', maxDistance: 4, count: 1 })
    return found.length > 0 ? bot.blockAt(found[0]) : null
  }

  async give(itemName, count = 1) {
    const bot = this.requireBot()
    return this._withAction(async () => {
      const stacks = bot.inventory.items().filter((item) => item.name === itemName)
      if (stacks.length === 0) throw new Error(`背包里没有 ${itemName}`)
      const owner = playerOf(bot, this.options.owner)
      if (owner?.entity) await bot.lookAt(owner.entity.position.offset(0, 1.5, 0), true).catch(() => {})
      let remaining = Math.max(1, count)
      let given = 0
      for (const stack of stacks) {
        if (remaining <= 0) break
        const amount = Math.min(stack.count, remaining)
        await bot.toss(stack.type, null, amount)
        given += amount
        remaining -= amount
      }
      return `丢出 ${itemName} x${given} 给主人。`
    })
  }

  async equip(itemName, slot = 'hand') {
    const bot = this.requireBot()
    return this._withAction(async () => {
      const item = bot.inventory.items().find((candidate) => candidate.name === itemName)
      if (!item) throw new Error(`背包里没有 ${itemName}`)
      await bot.equip(item, slot)
      return `装备了 ${itemName}（${slot}）。`
    })
  }

  async useHeld() {
    const bot = this.requireBot()
    return this._withAction(async () => {
      const held = bot.heldItem?.name ?? '空手'
      await withTimeout(bot.activateItem(), 5_000, '使用物品超时')
      await sleep(250)
      try { bot.deactivateItem() } catch { /* ignore */ }
      if (bot.currentWindow) {
        try {
          await bot.closeWindow(bot.currentWindow)
        } catch {
          try { bot.currentWindow.close() } catch { /* ignore */ }
        }
        return `使用了 ${held}，打开了容器界面；已关上。存取请用 mc_container。`
      }
      return `使用了 ${held}。`
    })
  }

  async container(options = {}) {
    const bot = this.requireBot()
    return this._withAction(async () => {
      const action = options.action ?? 'list'
      if (!['list', 'withdraw', 'deposit'].includes(action)) {
        throw new Error('action 只能是 list / withdraw / deposit')
      }
      if (bot.currentWindow) {
        try { await bot.closeWindow(bot.currentWindow) } catch { try { bot.currentWindow.close() } catch { /* ignore */ } }
      }

      const chestBlock = await this._findContainer(24)
      if (!chestBlock) throw new Error('附近 24 格没有箱子/木桶/陷阱箱')
      if (bot.entity.position.distanceTo(chestBlock.position) > 4) {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2)),
          20_000,
          '走到箱子超时',
        )
      }

      const container = await bot.openContainer(chestBlock)
      try {
        if (action === 'list') {
          const items = container.containerItems()
          return items.length > 0
            ? `容器里有：${items.map((item) => `${item.name}x${item.count}`).join('，')}。`
            : '容器是空的。'
        }

        const itemName = options.item
        if (!itemName) throw new Error(`${action} 需要 item`)
        const amount = clamp(Number(options.count) || 1, 1, 64 * 9)

        if (action === 'withdraw') {
          const stacks = container.containerItems().filter((item) => item.name === itemName)
          if (stacks.length === 0) throw new Error(`容器里没有 ${itemName}`)
          let remaining = amount
          for (const stack of stacks) {
            if (remaining <= 0) break
            const n = Math.min(stack.count, remaining)
            await container.withdraw(stack.type, stack.metadata ?? null, n)
            remaining -= n
          }
          return `从容器取出 ${itemName} x${amount - remaining}。`
        }

        const stacks = bot.inventory.items().filter((item) => item.name === itemName)
        if (stacks.length === 0) throw new Error(`背包里没有 ${itemName}`)
        let remaining = amount
        for (const stack of stacks) {
          if (remaining <= 0) break
          const n = Math.min(stack.count, remaining)
          await container.deposit(stack.type, stack.metadata ?? null, n)
          remaining -= n
        }
        return `放进容器 ${itemName} x${amount - remaining}。`
      } finally {
        try { await container.close() } catch { /* ignore */ }
      }
    })
  }

  async sleep() {
    const bot = this.requireBot()
    if (bot.isSleeping) return '已经在睡觉了。'
    if (!isNight(bot.time?.timeOfDay, bot.isRaining, bot.thunderState)) {
      throw new Error('现在不是夜晚/雷雨，睡不着。')
    }
    const bed = this._findBed(16)
    if (!bed) throw new Error('附近 16 格没有床')
    this.gaze?.suspend(5_000)
    return this._withAction(async () => {
      if (bot.entity.position.distanceTo(bed.position) > 3) {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)),
          20_000,
          '走到床边超时',
        )
      }
      try {
        await withTimeout(bot.sleep(bed), 10_000, '睡觉超时')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/not night|thunderstorm/i.test(message)) throw new Error('现在不是夜晚/雷雨，睡不着。')
        if (/monsters nearby/i.test(message)) throw new Error('附近有怪物，睡不着。')
        if (/occupied/i.test(message)) throw new Error('床被占了。')
        if (/too far/i.test(message)) throw new Error('离床太远了。')
        throw error
      }
      return '躺下睡觉了。'
    })
  }

  async wake() {
    const bot = this.requireBot()
    if (!bot.isSleeping) return '现在没在睡觉。'
    const confirmed = new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_500)
      timer.unref?.()
      bot.once('wake', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await bot.wake()
    await confirmed
    if (bot.isSleeping) {
      // Some Paper/vanilla combinations do not echo entityWake back to the
      // sleeping client. The out-of-bed action is the source of truth for the
      // body; clear the local flag so movement and reflexes resume.
      bot.isSleeping = false
      return '起床了。'
    }
    return '起床了。'
  }

  _findBed(radius = 16) {
    const bot = this.requireBot()
    const blocks = findNearbyBlocks(bot, { names: [...BED_NAMES], radius, limit: 1 })
    if (blocks.length === 0) return null
    const nearest = blocks[0]
    return bot.blockAt(new Vec3(nearest.position.x, nearest.position.y, nearest.position.z))
  }

  async _findContainer(maxDistance = 16) {
    const bot = this.requireBot()
    const blocks = findNearbyBlocks(bot, {
      names: ['chest', 'trapped_chest', 'barrel'],
      radius: maxDistance,
      limit: 4,
    })
    if (blocks.length > 0) {
      const nearest = blocks[0]
      return bot.blockAt(new Vec3(nearest.position.x, nearest.position.y, nearest.position.z))
    }
    const found = bot.findBlocks({
      matching: (block) => ['chest', 'trapped_chest', 'barrel'].includes(block?.name),
      maxDistance,
      count: 1,
    })
    return found.length > 0 ? bot.blockAt(found[0]) : null
  }

  async say(text) {
    if (!this.online) return false
    const message = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!message) return false
    if (this.options.humanizeChat !== false) {
      const delay = Math.min(1_800, 220 + message.length * 35 + this.options.random() * 250)
      await sleep(delay)
    }
    try {
      this.bot.chat(message)
      this.emit('spoke', { message })
      return true
    } catch {
      return false
    }
  }

  async wait(seconds = 1) {
    const duration = clamp(Number(seconds) || 1, 0, 10) * 1000
    await sleep(duration)
    return `等了 ${round(duration / 1000)} 秒。`
  }

  _checkTool(block) {
    const bot = this.requireBot()
    if (!block?.harvestTools) return
    const hasTool = bot.inventory.items().some((item) => block.harvestTools[item.type] === true)
    if (!hasTool) throw new Error(`挖 ${block.name} 需要合适的工具（镐/斧/锹等），背包里没有`)
  }

  _resolvePoint(target) {
    const bot = this.requireBot()
    if (target === 'owner') {
      const owner = playerOf(bot, this.options.owner)
      if (!owner?.entity) throw new Error(`看不到主人 ${this.options.owner}`)
      return new Vec3(Math.floor(owner.entity.position.x), Math.floor(owner.entity.position.y), Math.floor(owner.entity.position.z))
    }
    if (typeof target === 'string') {
      const parts = target.split(/[ ,]+/).map(Number).filter((value) => Number.isFinite(value))
      if (parts.length >= 3) return new Vec3(Math.floor(parts[0]), Math.floor(parts[1]), Math.floor(parts[2]))
      const player = playerOf(bot, target)
      if (player?.entity) {
        return new Vec3(Math.floor(player.entity.position.x), Math.floor(player.entity.position.y), Math.floor(player.entity.position.z))
      }
    }
    if (target && typeof target === 'object') {
      if (Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
        return new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))
      }
      if (target.player) {
        const player = playerOf(bot, target.player)
        if (!player?.entity) throw new Error(`看不到玩家 ${target.player}`)
        return new Vec3(Math.floor(player.entity.position.x), Math.floor(player.entity.position.y), Math.floor(player.entity.position.z))
      }
    }
    throw new Error('没有有效的目标坐标')
  }

  // ---------------------------------------------------------------------------
  // Human body language, latency and reflexes
  // ---------------------------------------------------------------------------

  _startHumanizers() {
    this.gaze?.start()
    this.gait?.start()
  }

  _stopHumanizers() {
    this.gaze?.stop()
    this.gait?.stop()
    this.explicitSneak = false
    this.explicitSprint = false
  }

  async humanDelay(min, max) {
    if (this.options.humanize === false) return
    const lo = Math.max(0, Number(min ?? this.options.reactionDelayMs) || 0)
    const hi = Math.max(lo, Number(max ?? lo + 180))
    await sleep(lo + this.options.random() * (hi - lo))
  }

  _startReflex() {
    if (this.reflexTimer || this.options.reflex === false) return
    this.reflexTimer = setInterval(() => { void this._reflexTick() }, 750)
    this.reflexTimer.unref?.()
  }

  _stopReflex() {
    if (!this.reflexTimer) return
    clearInterval(this.reflexTimer)
    this.reflexTimer = null
  }

  async _reflexTick() {
    if (!this.online || this.reflexBusy || !this.bot?.entity) return
    const bot = this.bot
    if (bot.isSleeping) return
    const now = Date.now()
    const health = bot.health ?? 20
    const food = bot.food ?? 20
    const hostiles = this.nearbyHostiles(12)
    const interruptible = Boolean(
      this.currentIntent && ['goto', 'dig', 'collect', 'pickup'].includes(this.currentIntent.name),
    )

    // Lava is the one thing that may interrupt anything, including a fight.
    if (this.options.avoidLava !== false && now - this.lastLavaAt > 3_000) {
      const lava = this.nearbyLava(2)
      if (lava) {
        this.lastLavaAt = now
        if (this.currentIntent) this.cancelCurrentIntent('lava nearby')
        this.reflexBusy = true
        try {
          await this._fleeFrom({ position: lava.position })
          this.emit('reflex', { type: 'lava', position: posText(lava.position) })
        } catch { /* try again next tick */ } finally {
          this.reflexBusy = false
        }
        return
      }
    }

    // Low health plus a hostile nearby: run first, fight later. Survival may
    // interrupt a walk/dig/collect; a real player drops the task and runs.
    if (health <= 8 && hostiles.length > 0 && (this.idle || interruptible)) {
      if (this.currentIntent) this.cancelCurrentIntent('flee from hostile')
      this.reflexBusy = true
      try {
        await this._fleeFrom(hostiles[0])
        this.emit('reflex', { type: 'flee', from: hostiles[0].name })
      } catch { /* keep trying next tick */ } finally {
        this.reflexBusy = false
      }
      return
    }

    // Healthy enough and something is in your face: hit it back.
    if (this.options.autoDefend !== false && health > 8 && hostiles.length > 0) {
      const nearest = hostiles[0]
      const threatDistance = nearest.position.distanceTo(bot.entity.position)
      if (threatDistance <= 5 && now - this.lastDefendAt > 6_000 && (this.idle || interruptible)) {
        this.lastDefendAt = now
        if (this.currentIntent) this.cancelCurrentIntent('defend')
        this.reflexBusy = true
        try {
          if (['creeper', 'warden', 'wither', 'ender_dragon'].includes(nearest.name)) {
            await this._fleeFrom(nearest)
            this.emit('reflex', { type: 'flee', from: nearest.name })
          } else {
            const result = await this.attack('nearest_hostile', 8)
            this.emit('reflex', { type: 'defend', target: nearest.name, result })
          }
        } catch { /* next tick */ } finally {
          this.reflexBusy = false
        }
        return
      }
    }

    // Eat before doing anything else. A hungry player regenerates slower and
    // cannot sprint.
    if (food <= 14 && now - this.lastEatAt > 15_000 && this.idle) {
      this.lastEatAt = now
      this.reflexBusy = true
      try {
        const result = await this.eat()
        this.emit('reflex', { type: 'eat', result })
      } catch { /* not fatal */ } finally {
        this.reflexBusy = false
      }
      return
    }

    // At night, with a bed nearby and nothing hostile around, a player sleeps.
    if (
      this.options.autoSleep !== false
      && this.idle
      && now - this.lastSleepAt > 60_000
      && health >= 12
      && hostiles.length === 0
      && isNight(bot.time?.timeOfDay, bot.isRaining, bot.thunderState)
      && this._findBed(16)
    ) {
      this.lastSleepAt = now
      this.reflexBusy = true
      try {
        const result = await this.sleep()
        this.emit('reflex', { type: 'sleep', result })
      } catch (error) {
        this._log('debug', '[minemate] auto sleep failed', error?.message ?? error)
      } finally {
        this.reflexBusy = false
      }
      return
    }

    // A real player does not leave the item they just mined on the ground.
    if (now - this.lastPickupAt > 4_000 && this.idle) {
      const drops = this.nearbyDrops(2.5)
      if (drops.length > 0) {
        this.lastPickupAt = now
        this.reflexBusy = true
        try {
          const gained = await this._collectNearbyDrops(2.5)
          if (gained.length > 0) this.emit('reflex', { type: 'pickup', gained })
        } catch { /* next tick */ } finally {
          this.reflexBusy = false
        }
      }
    }
  }

  async _fleeFrom(entity) {
    const bot = this.requireBot()
    const away = bot.entity.position.minus(entity.position)
    if (away.norm() < 0.5) away.x = 1
    const target = bot.entity.position.plus(away.normalize().scaled(8))
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)),
        6_000,
        '逃跑超时',
        () => { try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } },
      )
    } catch {
      // If pathfinding cannot find a way out, backpedal for a moment.
      bot.setControlState('back', true)
      await sleep(900)
      bot.setControlState('back', false)
    }
  }

  async _withAction(fn) {
    this.busy += 1
    try {
      return await fn()
    } finally {
      this.busy = Math.max(0, this.busy - 1)
    }
  }
}
