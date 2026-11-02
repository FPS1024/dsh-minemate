/**
 * Bridge between the Minecraft body and the DSH agent.
 *
 * The body stays dumb: it emits events. This module decides which events are
 * worth waking the harness for, coalesces noisy ones, and injects a normal
 * user-role message into the agent's inbox with `agent.followup(...)`.
 *
 * It also runs the "life tick": when the body is idle, the agent gets a short
 * observation and a nudge to continue its own plans. That is what keeps the
 * companion from standing still between user messages.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export class Companion {
  constructor({ body, ctx, config = {}, logger }) {
    this.body = body
    this.ctx = ctx
    this.config = config
    this.logger = logger ?? console
    this.agent = null
    this.pending = []
    this.flushTimer = null
    this.lifeTimer = null
    this.unsubscribers = []
    this.lastLifeTick = 0
    this.lastDangerAt = 0
    this.lastPickupNoteAt = 0
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true

    const on = (event, handler) => {
      this.body.on(event, handler)
      this.unsubscribers.push(() => this.body.off(event, handler))
    }

    on('online', ({ username }) => {
      this.queue(`[上线] 你以 ${username} 的身份进入世界了。先观察一下周围，然后决定做什么。`, { urgent: true })
    })

    on('ownerChat', ({ username, message }) => {
      this.queue(`[主人说] ${username}：${message}`, { urgent: true })
    })

    on('chat', ({ username, message }) => {
      if (String(username).toLowerCase() === String(this.config.owner ?? '').toLowerCase()) return
      this.queue(`[旁听] ${username}：${message}`)
    })

    on('ownerJoin', ({ username }) => {
      this.queue(`[主人上线] ${username} 进入服务器了。可以打个招呼。`, { urgent: true })
    })

    on('ownerLeave', ({ username }) => {
      this.queue(`[主人下线] ${username} 离开服务器了。`, { urgent: true })
    })

    on('damage', ({ health }) => {
      if (health <= 12) this.queue(`[受伤] 你现在只有 ${health}/20 血。先确认周围安全，必要时吃东西或逃跑。`, { urgent: true })
    })

    on('death', () => {
      this.queue('[死亡] 你死了一次，掉了东西。重生后先看看周围，别重复送命。', { urgent: true })
    })

    on('hostile', ({ name, distance }) => {
      const now = Date.now()
      if (now - this.lastDangerAt < 15_000) return
      this.lastDangerAt = now
      this.queue(`[危险] ${name} 在 ${distance} 格内。判断是打还是跑。`, { urgent: true })
    })

    on('intent:done', ({ name, result }) => {
      this.queue(`[身体] ${name} 完成了：${result}`, { urgent: true })
    })

    on('intent:failed', ({ name, error }) => {
      this.queue(`[身体] ${name} 失败了：${error}。看情况换个办法，不要原样重试。`, { urgent: true })
    })

    on('rareItem', ({ name }) => {
      this.queue(`[稀有] 你捡到了 ${name}。`, { urgent: true })
    })

    on('pickup', ({ name }) => {
      const now = Date.now()
      if (now - this.lastPickupNoteAt < 4_000) return
      this.lastPickupNoteAt = now
      this.queue(`[背包] 捡到了 ${name}。`)
    })

    on('botError', (error) => {
      this.logger?.warn?.(`[minemate] bot error: ${error?.message ?? error}`)
    })

    on('kicked', ({ reason }) => {
      this.queue(`[连接] 被服务器踢出：${reason}。身体会自动重连。`, { urgent: true })
    })

    on('offline', (reason) => {
      this.logger?.warn?.(`[minemate] offline: ${reason ?? 'unknown'}`)
    })

    const interval = Math.max(10_000, Number(this.config.proactiveIntervalMs) || 45_000)
    this.lifeTimer = setInterval(() => { void this.lifeTick() }, interval)
    this.lifeTimer.unref?.()
  }

  stop() {
    this.started = false
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.lifeTimer) {
      clearInterval(this.lifeTimer)
      this.lifeTimer = null
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.pending = []
  }

  _agents() {
    try {
      return this.ctx.get?.('agents') ?? this.ctx.agents ?? null
    } catch {
      return null
    }
  }

  resolveAgent() {
    if (this.agent) return this.agent
    const agents = this._agents()
    if (!agents) return null

    const configured = this.config.agentSessionId
    if (configured) {
      const exact = agents.get?.(configured)
      if (exact) {
        this.agent = exact
        return exact
      }
    }

    const list = agents.list?.() ?? []
    if (list.length > 0) {
      // The tui/web profiles normally run one root agent. If a deployment has
      // several, agentSessionId pins the intended one.
      this.agent = list[0]
      return this.agent
    }
    return null
  }

  queue(text, options = {}) {
    if (!text) return
    this.pending.push(String(text))
    if (this.pending.length > 12) this.pending.splice(0, this.pending.length - 12)

    if (options.urgent) {
      this.flush()
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 800)
    this.flushTimer.unref?.()
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    const text = this.pending.splice(0).join('\n')
    if (!this.deliver(text)) {
      // No agent yet: keep it for the next event/tick instead of losing it.
      this.pending.unshift(text)
      if (this.pending.length > 12) this.pending.length = 12
    }
  }

  deliver(text) {
    const agent = this.resolveAgent()
    if (!agent?.followup) return false
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return true
    } catch (error) {
      this.logger?.warn?.(`[minemate] couldn't wake the agent: ${error?.message ?? error}`)
      this.agent = null
      return false
    }
  }

  async lifeTick() {
    if (!this.started || !this.body.online) return
    if (!this.body.idle) return

    const autonomy = Math.max(0, Math.min(100, Number(this.config.autonomy) || 0))
    if (autonomy <= 0) return
    if (Math.random() * 100 > autonomy) return

    const now = Date.now()
    const interval = Math.max(10_000, Number(this.config.proactiveIntervalMs) || 45_000)
    if (now - this.lastLifeTick < interval) return
    this.lastLifeTick = now

    let observation
    try {
      observation = this.body.observe(12)
    } catch (error) {
      this.logger?.debug?.(`[minemate] life tick observation failed: ${error?.message ?? error}`)
      return
    }

    this.queue(
      `[生活回合] 你现在没在做事。\n${observation}\n\n`
      + '你可以继续自己的目标、和主人互动、整理背包，或者找点事做。不要每回合都问主人“要做什么”。',
      { urgent: true },
    )
  }
}
