import test from 'node:test'
import assert from 'node:assert/strict'

import { angleDelta, isNight, lerpAngle } from '../lib/humanizer.js'

const PI = Math.PI

test('angleDelta takes the shortest arc across the wrap point', () => {
  assert.ok(Math.abs(angleDelta(0, PI / 2) - PI / 2) < 1e-9)
  assert.ok(Math.abs(angleDelta(0, (3 * PI) / 2) + PI / 2) < 1e-9)
  assert.ok(Math.abs(angleDelta(-PI + 0.1, PI - 0.1) + 0.2) < 1e-9)
  assert.equal(angleDelta(1, 1), 0)
})

test('lerpAngle interpolates along the short arc and clamps t', () => {
  assert.ok(Math.abs(lerpAngle(0, PI / 2, 0.5) - PI / 4) < 1e-9)
  assert.ok(Math.abs(lerpAngle(0, -PI / 2, 0.5) + PI / 4) < 1e-9)
  assert.equal(lerpAngle(0, PI / 2, -1), 0)
  assert.ok(Math.abs(lerpAngle(0, PI / 2, 2) - PI / 2) < 1e-9)
})

test('isNight only opens the vanilla sleep window or a thunderstorm', () => {
  assert.equal(isNight(6000), false)
  assert.equal(isNight(13000), true)
  assert.equal(isNight(23000), true)
  assert.equal(isNight(24000), false)
  assert.equal(isNight(6000, true, 0), false)
  assert.equal(isNight(6000, true, 1), true)
})
