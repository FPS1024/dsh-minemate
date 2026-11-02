import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

test('exports the Cordis plugin shape', () => {
  assert.equal(plugin.name, 'minemate')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config, 'Config schema should be exported')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
})

test('apply registers the mc_* tools and the embodiment prompt', () => {
  const tools = []
  const sections = []
  let cleanup

  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: { section: (section) => sections.push(section) },
    effect: (fn) => {
      cleanup = fn()
      assert.equal(typeof cleanup, 'function')
      cleanup()
    },
    get: () => null,
  }

  plugin.apply(ctx, { autoConnect: false })

  const names = new Set(tools.map((tool) => tool.name))
  for (const required of [
    'mc_observe', 'mc_scan', 'mc_look', 'mc_goto', 'mc_move', 'mc_dig',
    'mc_collect', 'mc_pickup', 'mc_place', 'mc_attack', 'mc_eat', 'mc_craft',
    'mc_equip', 'mc_container', 'mc_sleep', 'mc_wake', 'mc_say', 'mc_status', 'mc_stop',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`)
  }

  assert.ok(tools.length >= 20)
  assert.ok(sections.some((section) => section.name === 'minemate:embodiment'))
  assert.match(sections[0].text, /真正生活在 Minecraft/)
})
