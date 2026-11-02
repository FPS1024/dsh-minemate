import test from 'node:test'
import assert from 'node:assert/strict'

import { createTools } from '../lib/tools.js'

const ABORTABLE_TOOLS = [
  ['mc_goto', { target: 'owner' }, 'goto'],
  ['mc_move', { direction: 'forward', seconds: 0.1 }, 'move'],
  ['mc_follow', {}, 'follow'],
  ['mc_dig', { block: 'oak_log' }, 'dig'],
  ['mc_pickup', {}, 'pickup'],
  ['mc_place', { item: 'torch', x: 1, y: 2, z: 3 }, 'place'],
  ['mc_attack', { target: 'nearest_hostile' }, 'attack'],
  ['mc_sleep', {}, 'sleep'],
  ['mc_craft', { item: 'stick' }, 'craft'],
  ['mc_container', { action: 'list' }, 'container'],
]

function fakeBody() {
  const calls = []
  const body = {
    online: true,
    calls,
    stop: async () => { calls.push('stop') },
  }
  for (const [, , method] of ABORTABLE_TOOLS) {
    body[method] = async () => {
      calls.push(method)
      return `ok:${method}`
    }
  }
  return body
}

test('abortable tools return a JSON value, not a thunk', async () => {
  const body = fakeBody()
  const tools = new Map(createTools(body).map((tool) => [tool.name, tool]))

  for (const [name, args, method] of ABORTABLE_TOOLS) {
    const tool = tools.get(name)
    assert.ok(tool, `missing ${name}`)
    const result = await tool.execute(args, {})
    assert.equal(typeof result, 'string', `${name} returned ${typeof result}`)
    assert.equal(result, `ok:${method}`, `${name} did not run the body method`)
    assert.equal(body.calls.at(-1), method, `${name} did not reach ${method}`)
  }
})

test('an already-aborted tool call stops the body and returns an error', async () => {
  const body = fakeBody()
  body.calls.length = 0
  const tools = new Map(createTools(body).map((tool) => [tool.name, tool]))
  const controller = new AbortController()
  controller.abort()

  const result = await tools.get('mc_move').execute(
    { direction: 'forward', seconds: 1 },
    { signal: controller.signal },
  )

  assert.match(result, /动作已取消/)
  assert.deepEqual(body.calls, ['stop'])
})
