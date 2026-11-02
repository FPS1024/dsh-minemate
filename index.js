/**
 * DSH plugin entry: MineMate's Minecraft body.
 *
 * The harness is the brain. This plugin owns exactly one Minecraft connection,
 * registers the `mc_*` tool surface, injects Minecraft events into the agent's
 * inbox, and runs a small reflex layer so the body keeps behaving while the
 * model thinks.
 *
 * Every Config field is volatile: DSH's settings service only exposes volatile
 * fields to the Plugins page, and the plugin re-reads them on
 * `loader/volatile-update` so the browser-side form takes effect without a
 * full DSH restart (connection changes reconnect the body).
 */

import z from '@deepseek-ai/schemastery'

import { buildSystemPrompt } from './lib/persona.js'
import { Companion } from './lib/companion.js'
import { createTools } from './lib/tools.js'
import { MinecraftBot } from './lib/bot.js'

export const name = 'minemate'

/** The harness services this plugin needs. The agent registry is optional and
 * resolved lazily, so the body can also be tested without a brain. */
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  host: z.string().default('127.0.0.1').volatile(),
  port: z.number().min(1).max(65535).default(25565).volatile(),
  username: z.string().default('Alex').volatile(),
  auth: z.union(['offline', 'microsoft']).default('offline').volatile(),
  version: z.string().default('1.21.6').volatile(),
  owner: z.string().default('FPS1024').volatile(),
  companionName: z.string().default('Alex').volatile(),
  autoConnect: z.boolean().default(true).volatile(),
  reconnect: z.boolean().default(true).volatile(),
  reflex: z.boolean().default(true).volatile(),
  humanize: z.boolean().default(true).volatile(),
  humanizeChat: z.boolean().default(true).volatile(),
  reactionDelayMs: z.number().min(0).max(1_000).default(150).volatile(),
  gaze: z.boolean().default(true).volatile(),
  gait: z.boolean().default(true).volatile(),
  autoDefend: z.boolean().default(true).volatile(),
  avoidLava: z.boolean().default(true).volatile(),
  autoSleep: z.boolean().default(true).volatile(),
  autonomy: z.number().min(0).max(100).default(0).volatile(),
  proactiveIntervalMs: z.number().min(30_000).default(180_000).volatile(),
  ambientChat: z.boolean().default(false).volatile(),
  agentSessionId: z.string().default('').volatile(),
  persona: z.string().default('').volatile(),
})

const DEFAULTS = {
  host: '127.0.0.1',
  port: 25565,
  username: 'Alex',
  auth: 'offline',
  version: '1.21.6',
  owner: 'FPS1024',
  companionName: 'Alex',
  autoConnect: true,
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
  autonomy: 0,
  proactiveIntervalMs: 180_000,
  ambientChat: false,
  agentSessionId: '',
  persona: '',
}

const CONNECTION_KEYS = new Set(['host', 'port', 'username', 'auth', 'version'])

function readValue(config, key) {
  const raw = config?.[key]
  const value = raw && typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined ? DEFAULTS[key] : value
}

function readConfig(config) {
  const result = {}
  for (const key of Object.keys(DEFAULTS)) result[key] = readValue(config, key)
  return result
}

function changedKeys(previous, next) {
  return Object.keys(DEFAULTS).filter((key) => previous[key] !== next[key])
}

export function apply(ctx, config = {}) {
  const options = readConfig(config)
  const logger = ctx.logger?.('minemate') ?? console

  const body = new MinecraftBot({
    host: options.host,
    port: options.port,
    username: options.username,
    auth: options.auth,
    version: options.version,
    owner: options.owner,
    reconnect: options.reconnect,
    reflex: options.reflex,
    humanize: options.humanize,
    humanizeChat: options.humanizeChat,
    reactionDelayMs: options.reactionDelayMs,
    gaze: options.gaze,
    gait: options.gait,
    autoDefend: options.autoDefend,
    avoidLava: options.avoidLava,
    autoSleep: options.autoSleep,
    logger,
  })

  const actionBudget = new Map()
  let ownerActionAt = 0
  const resetActionBudget = () => {
    // A fresh owner message gets its own short leash: at most 3 action tools.
    ownerActionAt = Date.now()
    actionBudget.clear()
  }
  const clearActionBudget = (agent) => {
    actionBudget.delete(agent?.id ?? 'unknown')
  }

  const companion = new Companion({
    body,
    ctx,
    config: options,
    logger,
    onOwnerMessage: resetActionBudget,
  })

  const ACTION_TOOLS = new Set([
    'mc_goto', 'mc_move', 'mc_follow', 'mc_dig', 'mc_collect', 'mc_pickup',
    'mc_place', 'mc_attack', 'mc_eat', 'mc_craft', 'mc_equip', 'mc_give',
    'mc_use', 'mc_container', 'mc_sleep', 'mc_wake', 'mc_jump', 'mc_sneak',
    'mc_sprint', 'mc_swing',
  ])
  const ACTION_LIMIT = 8
  const OWNER_ACTION_LIMIT = 3
  const ACTION_WINDOW_MS = 60_000

  const takeActionBudget = (agent) => {
    const key = agent?.id ?? 'unknown'
    const now = Date.now()
    const entry = actionBudget.get(key)
    if (entry === undefined || now - entry.start > ACTION_WINDOW_MS) {
      const limit = now - ownerActionAt <= ACTION_WINDOW_MS ? OWNER_ACTION_LIMIT : ACTION_LIMIT
      actionBudget.set(key, { start: now, count: 1, limit })
      return true
    }
    entry.count += 1
    return entry.count <= entry.limit
  }

  for (const tool of createTools(body)) {
    const original = tool.execute
    const guarded = {
      ...tool,
      async execute(args, exec) {
        if (exec?.agent) companion.bindAgent(exec.agent)

        // mc_stop must always get through, even while an intent is running.
        if (ACTION_TOOLS.has(tool.name) && tool.name !== 'mc_stop') {
          if (!takeActionBudget(exec?.agent)) {
            return '⛔ 这条消息里的动作次数太多了。先停下，回答主人或汇报进展；不要继续刷动作。'
          }
          const busy = body.busy > 0 || body.currentIntent !== null || body.following
          if (busy) {
            const doing = body.currentIntent?.name ?? (body.following ? 'follow' : '另一个动作')
            return `⛔ 身体还在做 ${doing}。先 mc_status 看进度，或 mc_stop 再换动作。不要重复调用。`
          }
        }

        const result = await original(args, exec)
        if (tool.name === 'mc_stop') clearActionBudget(exec?.agent)
        return result
      },
    }
    ctx.tools.register(guarded)
  }

  ctx.systemPrompt.section({
    name: 'minemate:embodiment',
    order: 100,
    // Dynamic so persona/owner edits take effect on the next request.
    text: () => buildSystemPrompt(options),
  })

  const connectQuietly = (reason) => {
    body.connect().catch((error) => {
      logger.warn?.(`[minemate] ${reason}: ${error?.message ?? error}`)
    })
  }

  const applyRuntime = (previous, next, changed) => {
    Object.assign(body.options, {
      host: next.host,
      port: next.port,
      username: next.username,
      auth: next.auth,
      version: next.version,
      owner: next.owner,
      reconnect: next.reconnect,
      reflex: next.reflex,
      humanize: next.humanize,
      humanizeChat: next.humanizeChat,
      reactionDelayMs: next.reactionDelayMs,
      gaze: next.gaze,
      gait: next.gait,
      autoDefend: next.autoDefend,
      avoidLava: next.avoidLava,
      autoSleep: next.autoSleep,
    })
    body.gaze.enabled = next.gaze !== false
    body.gait.enabled = next.gait !== false

    if (changed.includes('reflex')) {
      body._stopReflex()
      if (next.reflex) body._startReflex()
    }
    if (changed.includes('gaze') || changed.includes('gait')) {
      body._stopHumanizers()
      body._startHumanizers()
    }

    companion.reconfigure(next)

    const connectionChanged = changed.some((key) => CONNECTION_KEYS.has(key))
    if (connectionChanged) {
      const reconnect = next.autoConnect
      if (body.online || body.desired) {
        void body.disconnect('configuration changed')
          .then(() => { if (reconnect) return body.connect() })
          .catch((error) => logger.warn?.(`[minemate] reconnect after config change failed: ${error?.message ?? error}`))
      } else if (reconnect) {
        connectQuietly('connect after config change failed')
      }
      return
    }

    if (changed.includes('autoConnect')) {
      if (!next.autoConnect && (body.online || body.desired)) {
        void body.disconnect('autoConnect disabled')
      } else if (next.autoConnect && !body.online && !body.desired) {
        connectQuietly('connect after enabling autoConnect failed')
      }
    }
  }

  const refresh = () => {
    const next = readConfig(config)
    const changed = changedKeys(options, next)
    if (changed.length === 0) return
    const previous = { ...options }
    Object.assign(options, next)
    applyRuntime(previous, next, changed)
    logger.info?.(`[minemate] config updated: ${changed.join(', ')}`)
  }

  ctx.on?.('loader/volatile-update', refresh)

  ctx.effect(() => {
    companion.start()
    if (options.autoConnect) connectQuietly('initial connection failed')
    return () => {
      companion.stop()
      void body.disconnect('plugin unloaded')
    }
  })

  logger.info?.(
    `[minemate] body ready; target ${options.host}:${options.port} as ${options.username}; `
    + `${options.autoConnect ? 'connecting' : 'autoConnect is off'}`,
  )
}
