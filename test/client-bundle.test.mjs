import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadBundle() {
  let definition
  const sandbox = {
    window: { __ModuleLoader__: { load: (next) => { definition = next } } },
    console,
    Symbol,
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(definition, 'client bundle must register a factory')
  return definition
}

function fakeRequire(name) {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
    }
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: function Button() {}, Input: function Input() {} }
  }
  throw new Error(`unexpected client module request: ${name}`)
}

test('client bundle registers the row config slot', () => {
  const definition = loadBundle()
  assert.equal(definition.id, '@fps1024/dsh-minemate')
  const mod = definition.factory(fakeRequire)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['slots'])

  const registrations = []
  const ctx = {
    slots: {
      inject: (name, factory) => {
        assert.equal(name, 'plugins.row.config')
        return factory()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (factory) => factory(),
  }
  mod.apply(ctx)

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.row.config')
  assert.equal(registrations[0].options.key, '@fps1024/dsh-minemate#dsh-minemate')
  assert.equal(typeof registrations[0].component, 'function')
})

test('config component renders a page and a summary without a Host', () => {
  const mod = loadBundle().factory(fakeRequire)
  const form = {
    state: {
      status: 'ready',
      value: { host: '127.0.0.1', auth: 'offline', autoConnect: true },
      revision: 1,
      writable: true,
    },
    mutate: async () => true,
  }
  assert.equal(typeof mod.MinemateConfigForm({ view: 'summary', form }), 'string')
  const tree = mod.MinemateConfigForm({ view: 'page', form })
  assert.equal(tree.type, 'div')
})
