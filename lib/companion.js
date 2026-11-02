/**
 * Bridge between the Minecraft body and the DSH agent.
 *
 * The body stays dumb: it emits events. This module decides which events are
 * worth waking the harness for, coalesces noisy ones, and injects a normal
 * user-role message into the agent's inbox with `agent.followup(...)`.
 *
 * Policy (1.2.6):
 *   - owner chat is the only event allowed to preempt a running turn;
 *   - pickups / owner join-leave / hostile proximity / ambient chat do NOT
 *     wake the agent;
 *   - long-collect completion is the only intent event kept, and only when idle;
 *   - the life tick is off by default and never includes a full observation.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export class Companion {
  constructor({ body, ctx, config = {}, logger, onOwnerMessage, now }) {
    this.body = body
    this.ctx = ctx
    this.config = config
    this.logger = logger ?? console
    this.onOwnerMessage = onOwnerMessage
    this.now = now ?? Date.now
    this.agent = null
    this.pending = []
    this.flushTimer = null
    this.lifeTimer = null
    this.unsubscribers = []
    this.lastLifeTick = 0
    this.lastOwnerChatAt = 0
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
      // Connecting is not a reason to spend a turn. Only autonomous mode gets
      // a wake-up; otherwise the owner's first message starts the session.
      if (Number(this.config.autonomy) > 0) {
        this.queue(`[上线] 你以 ${username} 的身份进入世界了。`)
      }
    })

    on('ownerChat', ({ username, message }) => {
      this.deliverOwner(`[主人说] ${username}：${message}`)
    })

    on('chat', ({ username, message }) => {
      if (this.config.ambientChat !== true) return
      if (String(username).toLowerCase() === String(this.config.owner ?? '').toLowerCase()) return
      this.queue(`[旁听] ${username}：${message}`)
    })

    on('damage', ({ health }) => {
      // The reflex layer already eats/flees/fights. Only tell the model when
      // this is actually dangerous; never interrupt a turn for a scratch.
      if (health <= 12) this.queue(`[受伤] 你现在只有 ${health}/20 血。先确认周围安全。`)
    })

    on('death', () => {
      this.queue('[死亡] 你死了一次，掉了东西。重生后先看看周围，别重复送命。', { urgent: true })
    })

    on('intent:done', ({ name, result }) => {
      // Only long collection jobs need a wake. Dig/goto/pickup results are
      // already in the tool result; waking for them creates tool loops.
      if (name !== 'collect') return
      this.queue(`[身体] 采集完成了：${String(result).slice(0, 300)}`)
    })

    on('intent:failed', ({ name, error }) => {
      if (name !== 'collect') return
      this.queue(`[身体] 采集失败了：${String(error).slice(0, 300)}。看情况换个办法，不要原样重试。`)
    })

    on('botError', (error) => {
      this.logger?.warn?.(`[minemate] bot error: ${error?.message ?? error}`)
    })

    on('kicked', ({ reason }) => {
      this.logger?.warn?.(`[minemate] kicked: ${reason}`)
    })

    on('offline', (reason) => {
      this.logger?.warn?.(`[minemate] offline: ${reason ?? 'unknown'}`)
    })

    const interval = Math.max(30_000, Number(this.config.proactiveIntervalMs) || 180_000)
    this.lifeTimer = setInterval(() => { void this.lifeTick() }, interval)
    this.lifeTimer.unref?.()
  }

  reconfigure(config) {
    const previousAgent = this.config?.agentSessionId
    const previousInterval = this.config?.proactiveIntervalMs
    this.config = config
    if (config.agentSessionId !== previousAgent) this.agent = null
    if (this.started && config.proactiveIntervalMs !== previousInterval) {
      if (this.lifeTimer) clearInterval(this.lifeTimer)
      const interval = Math.max(30_000, Number(config.proactiveIntervalMs) || 180_000)
      this.lifeTimer = setInterval(() => { void this.lifeTick() }, interval)
      this.lifeTimer.unref?.()
    }
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

  /** Bind the body to the exact agent that actually called a tool. */
  bindAgent(agent) {
    if (agent) this.agent = agent
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
      this.agent = list[0]
      return this.agent
    }
    return null
  }

  queue(text, options = {}) {
    if (!text) return
    const agent = this.resolveAgent()

    // Non-critical events never join a running turn, and never interrupt the
    // first few minutes of an owner conversation.
    if (!options.urgent) {
      if (agent?.status === 'running') return
      if (this.lastOwnerChatAt > 0 && this.now() - this.lastOwnerChatAt < 10_000) return
    }

    this.pending.push(String(text))
    if (this.pending.length > 6) this.pending.splice(0, this.pending.length - 6)

    if (options.urgent) {
      this.flush()
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 1_200)
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
      this.pending.unshift(text)
      if (this.pending.length > 6) this.pending.length = 6
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

  /** Owner chat preempts a long tool turn; everything else waits or is dropped. */
  deliverOwner(text) {
    this.lastOwnerChatAt = this.now()
    const agent = this.resolveAgent()
    this.onOwnerMessage?.(agent)
    // Drop queued ambient noise; the owner message is the priority.
    this.pending = []

    if (!agent?.followup) {
      this.pending.push(text)
      return false
    }

    try {
      if (agent.status === 'running') {
        try {
          agent.cancel?.({ kind: 'user' }, { keepInbox: true })
        } catch (error) {
          this.logger?.debug?.(`[minemate] cancel before owner message failed: ${error?.message ?? error}`)
        }
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return true
    } catch (error) {
      this.logger?.warn?.(`[minemate] couldn't deliver owner chat: ${error?.message ?? error}`)
      this.agent = null
      this.pending.push(text)
      return false
    }
  }

  async lifeTick() {
    if (!this.started || !this.body.online) return
    if (!this.body.idle) return

    const autonomy = Math.max(0, Math.min(100, Number(this.config.autonomy) || 0))
    if (autonomy <= 0) return
    if (Math.random() * 100 > autonomy) return

    const now = this.now()
    // Do not nudge while the owner is around or has just spoken.
    if (this.lastOwnerChatAt > 0 && now - this.lastOwnerChatAt < 300_000) return
    const agent = this.resolveAgent()
    if (agent?.status === 'running') return

    const interval = Math.max(120_000, Number(this.config.proactiveIntervalMs) || 180_000)
    if (now - this.lastLifeTick < interval) return
    this.lastLifeTick = now

    // No observation dump. If the agent wants details it can call mc_observe.
    this.queue('[空闲] 你已经闲了一会儿。可以继续自己的目标，也可以休息；不用强行找事做。')
  }
}
