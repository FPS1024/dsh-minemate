/**
 * DSH plugin entry: MineMate's Minecraft body.
 *
 * The harness is the brain. This plugin owns exactly one Minecraft connection,
 * registers the `mc_*` tool surface, injects Minecraft events into the agent's
 * inbox, and runs a small reflex layer so the body keeps behaving while the
 * model thinks.
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
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(25565),
  username: z.string().default('Alex'),
  auth: z.union(['offline', 'microsoft']).default('offline'),
  version: z.string().default('1.21.6'),
  owner: z.string().default('FPS1024'),
  companionName: z.string().default('Alex'),
  autoConnect: z.boolean().default(true),
  reconnect: z.boolean().default(true),
  reflex: z.boolean().default(true),
  humanize: z.boolean().default(true),
  humanizeChat: z.boolean().default(true),
  reactionDelayMs: z.number().min(0).max(1_000).default(150),
  gaze: z.boolean().default(true),
  gait: z.boolean().default(true),
  autoDefend: z.boolean().default(true),
  avoidLava: z.boolean().default(true),
  autoSleep: z.boolean().default(true),
  autonomy: z.number().min(0).max(100).default(60),
  proactiveIntervalMs: z.number().min(10_000).default(45_000),
  agentSessionId: z.string().default(''),
  persona: z.string().default(''),
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

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
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
    text: buildSystemPrompt(options),
  })

  const companion = new Companion({ body, ctx, config: options, logger })

  ctx.effect(() => {
    companion.start()
    if (options.autoConnect) {
      body.connect().catch((error) => {
        logger.warn?.(`[minemate] initial connection failed: ${error?.message ?? error}`)
      })
    }
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
