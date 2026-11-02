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
  autonomy: z.number().min(0).max(100).default(60).volatile(),
  proactiveIntervalMs: z.number().min(10_000).default(45_000).volatile(),
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
  autonomy: 60,
  proactiveIntervalMs: 45_000,
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

  for (const tool of createTools(body)) {
    ctx.tools.register(tool)
  }

  ctx.systemPrompt.section({
    name: 'minemate:embodiment',
    order: 100,
    // Dynamic so persona/owner edits take effect on the next request.
    text: () => buildSystemPrompt(options),
  })

  const companion = new Companion({ body, ctx, config: options, logger })

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
