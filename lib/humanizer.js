/**
 * Small body-language controllers.
 *
 * GazeController turns the head smoothly instead of snapping to every target,
 * and keeps the eyes on the owner/hostile/threat the way a player would.
 * GaitController decides when sprinting looks natural and when sneaking near
 * danger is the human choice. Neither controller makes high-level decisions;
 * they only shape how the body performs them.
 */

import {
  distance,
  hasLineOfSight,
  isHostileName,
  playerOf,
} from './perception.js'

const TWO_PI = Math.PI * 2

/** Shortest signed angular distance from `from` to `to`, in radians. */
export function angleDelta(from, to) {
  let delta = (to - from) % TWO_PI
  if (delta > Math.PI) delta -= TWO_PI
  if (delta < -Math.PI) delta += TWO_PI
  return delta
}

/** Interpolate an angle along the shortest arc. */
export function lerpAngle(from, to, t) {
  return from + angleDelta(from, to) * Math.max(0, Math.min(1, t))
}

/** Whether the vanilla sleep window is open. */
export function isNight(timeOfDay, isRaining = false, thunderState = 0) {
  if (isRaining && thunderState > 0) return true
  return Number.isFinite(timeOfDay) && timeOfDay >= 12541 && timeOfDay <= 23458
}

function offsetPoint(position, height) {
  return position.offset(0, (height ?? 1.8) * 0.75, 0)
}

export class GazeController {
  constructor(body, options = {}) {
    this.body = body
    this.enabled = options.enabled !== false
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.timer = null
    this.suspendUntil = 0
    this.forced = null
    this.noiseYaw = 0
    this.noisePitch = 0
    this.noiseUntil = 0
  }

  start() {
    if (this.timer || !this.enabled) return
    this.timer = setInterval(() => { void this.tick() }, 100)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  suspend(ms = 500) {
    this.suspendUntil = Math.max(this.suspendUntil, this.now() + ms)
  }

  lookAtOwner(ms = 2_500) {
    this.lookAt(() => {
      const owner = playerOf(this.body.bot, this.body.options.owner)
      return owner?.entity ?? null
    }, ms)
  }

  lookAtEntity(entity, ms = 2_000) {
    if (!entity) return
    this.lookAt(() => (entity.isValid === false ? null : entity), ms)
  }

  lookAt(target, ms = 2_000) {
    this.forced = typeof target === 'function' ? target : () => target
    this.forcedUntil = this.now() + ms
  }

  _chooseTarget() {
    const body = this.body
    const bot = body.bot
    if (!bot?.entity) return null
    const now = this.now()

    if (this.forced && now < this.forcedUntil) {
      const forced = this.forced()
      if (forced) return forced
    }

    const owner = playerOf(bot, body.options.owner)
    const ownerEntity = owner?.entity
    if (ownerEntity) {
      // Look at the person who just spoke, or the person you are following.
      if ((body.ownerSpokeAt && now - body.ownerSpokeAt < 6_000) || body.following) {
        return ownerEntity
      }
    }

    // A hostile within sight gets attention before scenery.
    let nearestHostile = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity?.position || !isHostileName(entity.name)) continue
      const d = entity.position.distanceTo(bot.entity.position)
      if (d > 12 || d >= nearestDistance) continue
      if (!hasLineOfSight(bot, entity)) continue
      nearestHostile = entity
      nearestDistance = d
    }
    if (nearestHostile) return nearestHostile

    // While walking somewhere, look at the destination (or past it).
    if (body.currentIntent?.meta?.target) {
      return { position: body.currentIntent.meta.target, block: true }
    }

    if (ownerEntity && distance(bot.entity.position, ownerEntity.position) <= 16) {
      return ownerEntity
    }

    return null
  }

  async tick() {
    const body = this.body
    const bot = body.bot
    if (!this.enabled || !body.online || !bot?.entity) return
    if (this.now() < this.suspendUntil) return
    if (body.busy > 0 || body.digging) return
    if (body.currentIntent && !['goto', 'collect', 'pickup', 'follow'].includes(body.currentIntent.name)) return

    const now = this.now()
    if (now > this.noiseUntil) {
      this.noiseUntil = now + 1_500 + this.random() * 2_500
      this.noiseYaw = (this.random() - 0.5) * 0.02
      this.noisePitch = (this.random() - 0.5) * 0.015
    }

    const target = this._chooseTarget()
    if (!target) return

    const position = target.position
    if (!position) return
    const point = target.block
      ? position.offset(0.5, 0.5, 0.5)
      : offsetPoint(position, target.height)

    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    const delta = point.minus(eye)
    const ground = Math.hypot(delta.x, delta.z)
    if (ground < 0.05 && Math.abs(delta.y) < 0.05) return

    const desiredYaw = Math.atan2(-delta.x, -delta.z)
    const desiredPitch = Math.atan2(delta.y, Math.max(ground, 0.001))

    const yaw = lerpAngle(bot.entity.yaw, desiredYaw + this.noiseYaw, 0.22)
    const pitch = bot.entity.pitch + (desiredPitch + this.noisePitch - bot.entity.pitch) * 0.22
    try {
      await bot.look(yaw, pitch, true)
    } catch { /* physics can be between ticks */ }
  }
}

export class GaitController {
  constructor(body, options = {}) {
    this.body = body
    this.enabled = options.enabled !== false
    this.timer = null
  }

  start() {
    if (this.timer || !this.enabled) return
    this.timer = setInterval(() => this.tick(), 250)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  _set(control, value) {
    try {
      this.body.bot?.setControlState?.(control, value)
    } catch { /* disconnected */ }
  }

  tick() {
    const body = this.body
    const bot = body.bot
    if (!this.enabled || !body.online || !bot?.entity) return
    if (body.busy > 0) return

    const moving = body.following
      || (body.currentIntent && ['goto', 'collect', 'pickup'].includes(body.currentIntent.name))

    if (!moving) {
      if (!body.explicitSprint) this._set('sprint', false)
      if (!body.explicitSneak) this._set('sneak', false)
      return
    }

    const lava = body.nearbyLava(3)
    const hostiles = body.nearbyHostiles(8)
    const health = bot.health ?? 20
    const food = bot.food ?? 20

    if (lava) {
      if (!body.explicitSneak) this._set('sneak', true)
      if (!body.explicitSprint) this._set('sprint', false)
      return
    }

    if (!body.explicitSneak) this._set('sneak', false)
    if (!body.explicitSprint) {
      this._set('sprint', health > 12 && food > 6 && hostiles.length === 0)
    }
  }
}
