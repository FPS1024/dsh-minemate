import test from 'node:test'
import assert from 'node:assert/strict'

import { Companion } from '../lib/companion.js'

function fakeBody() {
  const handlers = new Map()
  return {
    online: true,
    idle: true,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    off(event, handler) {
      const list = handlers.get(event) ?? []
      handlers.set(event, list.filter((entry) => entry !== handler))
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
  }
}

function fakeAgent() {
  return {
    id: 'agent-1',
    status: 'running',
    cancels: [],
    followups: [],
    cancel(cause, options) {
      this.cancels.push({ cause, options })
      this.status = 'idle'
    },
    followup(message) {
      this.followups.push(message)
    },
  }
}

function makeCompanion(body, agent, overrides = {}) {
  const companion = new Companion({
    body,
    ctx: { get: () => null },
    config: { owner: 'FPS1024', autonomy: 0, proactiveIntervalMs: 180_000, ...overrides },
    now: () => 1_000,
  })
  companion.bindAgent(agent)
  companion.start()
  return companion
}

test('owner chat preempts a running turn and resets the action budget', () => {
  const body = fakeBody()
  const agent = fakeAgent()
  let reset = 0
  const companion = new Companion({
    body,
    ctx: { get: () => null },
    config: { owner: 'FPS1024' },
    onOwnerMessage: () => { reset += 1 },
  })
  companion.bindAgent(agent)
  companion.start()
  try {
    body.emit('ownerChat', { username: 'FPS1024', message: '在吗' })
    assert.deepEqual(agent.cancels, [{ cause: { kind: 'user' }, options: { keepInbox: true } }])
    assert.equal(agent.followups.length, 1)
    assert.match(agent.followups[0].content[0].text, /\[主人说\] FPS1024：在吗/)
    assert.equal(reset, 1)
  } finally {
    companion.stop()
  }
})

test('connecting alone does not spend a turn when autonomy is off', () => {
  const body = fakeBody()
  const agent = fakeAgent()
  agent.status = 'idle'
  const companion = makeCompanion(body, agent)
  try {
    body.emit('online', { username: 'Alex' })
    companion.flush()
    assert.equal(agent.followups.length, 0)
  } finally {
    companion.stop()
  }
})

test('ambient events do not wake a running agent', () => {
  const body = fakeBody()
  const agent = fakeAgent()
  const companion = makeCompanion(body, agent)
  try {
    body.emit('damage', { health: 8 })
    body.emit('intent:done', { name: 'collect', result: 'oak_log x4' })
    body.emit('chat', { username: 'Steve', message: 'hi' })
    companion.flush()
    assert.equal(agent.followups.length, 0)
  } finally {
    companion.stop()
  }
})

test('collect completion still wakes an idle agent', () => {
  const body = fakeBody()
  const agent = fakeAgent()
  agent.status = 'idle'
  const companion = makeCompanion(body, agent)
  try {
    body.emit('intent:done', { name: 'collect', result: 'oak_log x4' })
    companion.flush()
    assert.equal(agent.followups.length, 1)
    assert.match(agent.followups[0].content[0].text, /采集完成了：oak_log x4/)
  } finally {
    companion.stop()
  }
})
