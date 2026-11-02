/**
 * MineMate browser half: a configuration page for the plugin row.
 *
 * DSH's client module system serves this file to the web UI. It registers a
 * `plugins.row.config` entry keyed by `<package>#<row id>`; the Plugins page
 * then shows a Configure control on the MineMate row and passes the Host-owned
 * form (`form.state` + `form.mutate`) into this component.
 *
 * The file is a hand-written lazy-CJS bundle, the same format the official
 * client packages emit: running it only registers a factory; the factory runs
 * when the page materializes this plugin.
 */
window.__ModuleLoader__.load({
  id: '@fps1024/dsh-minemate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const TEXT_FIELDS = [
      ['host', '服务器地址', '例如 127.0.0.1'],
      ['username', '玩家名', '例如 Alex'],
      ['version', '协议版本', '例如 1.21.6'],
      ['owner', '主人用户名', '例如 FPS1024'],
      ['companionName', '人格名字', '例如 Alex'],
      ['agentSessionId', 'DSH Session ID（可选）', '留空 = 当前 profile 的单个根 agent'],
    ]
    const NUMBER_FIELDS = [
      ['port', '端口', 1, 65535],
      ['reactionDelayMs', '反应延迟 (ms)', 0, 1000],
      ['autonomy', '主动性 (0–100)', 0, 100],
      ['proactiveIntervalMs', '生活回合间隔 (ms)', 10000, 600000],
    ]
    const BOOL_FIELDS = [
      ['autoConnect', '加载后自动上线'],
      ['reconnect', '断线自动重连'],
      ['reflex', '反射层（吃/逃/还手/避岩浆/睡床）'],
      ['humanize', '动作反应延迟'],
      ['humanizeChat', '说话打字延迟'],
      ['gaze', '平滑凝视'],
      ['gait', '步态（冲刺/潜行）'],
      ['autoDefend', '被近身攻击时自动还手'],
      ['avoidLava', '岩浆附近自动离开'],
      ['autoSleep', '夜晚自动睡床'],
    ]
    const ALL_FIELDS = [
      ...TEXT_FIELDS.map(([field]) => field),
      'auth',
      ...NUMBER_FIELDS.map(([field]) => field),
      ...BOOL_FIELDS.map(([field]) => field),
      'persona',
    ]

    function buildOps(draft, value) {
      const ops = []
      for (const [field] of TEXT_FIELDS) {
        const next = String(draft[field] ?? '')
        if (next !== String(value[field] ?? '')) ops.push({ op: 'set', path: [field], value: next })
      }
      const auth = String(draft.auth ?? 'offline')
      if (auth !== String(value.auth ?? '')) ops.push({ op: 'set', path: ['auth'], value: auth })
      for (const [field] of NUMBER_FIELDS) {
        if (draft[field] === '' || draft[field] === undefined) {
          ops.push({ op: 'unset', path: [field] })
          continue
        }
        const next = Number(draft[field])
        if (Number.isFinite(next) && next !== Number(value[field])) ops.push({ op: 'set', path: [field], value: next })
      }
      for (const [field] of BOOL_FIELDS) {
        const next = Boolean(draft[field])
        if (next !== Boolean(value[field])) ops.push({ op: 'set', path: [field], value: next })
      }
      const persona = String(draft.persona ?? '')
      if (persona !== String(value.persona ?? '')) ops.push({ op: 'set', path: ['persona'], value: persona })
      return ops
    }

    function field(label, control) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '13px' } },
        h('span', { style: { opacity: 0.78 } }, label),
        control)
    }

    function numberField(draft, update, fieldName, label, min, max) {
      return field(label, h(Input, {
        type: 'number',
        min,
        max,
        value: draft[fieldName] ?? '',
        onChange: (event) => update(fieldName, event.target.value),
      }))
    }

    function MinemateConfigForm(props) {
      const snapshot = props.form?.state
      const value = snapshot?.value ?? {}
      const [draft, setDraft] = React.useState(() => ({ ...value }))
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        if (snapshot?.revision !== undefined) {
          setDraft({ ...(snapshot.value ?? {}) })
        }
      }, [snapshot?.revision])

      if (props.view === 'summary') {
        return 'Minecraft 连接、身体、人化与主动性设置'
      }
      if (!props.form || !snapshot) {
        return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '配置表单还没就绪。请确认 MineMate 行已启用。')
      }
      if (snapshot.status === 'loading') {
        return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, '正在读取配置…')
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { style: { fontSize: '13px', opacity: 0.75 } }, 'Host 没有暴露这个配置命名空间。')
      }

      const writable = snapshot.writable !== false
      const update = (key, next) => {
        setMessage('')
        setDraft((current) => ({ ...current, [key]: next }))
      }

      const save = async () => {
        if (!writable || busy) return
        const ops = buildOps(draft, value)
        if (ops.length === 0) {
          setMessage('没有修改。')
          return
        }
        setBusy(true)
        try {
          const accepted = await props.form.mutate(ops, snapshot.revision)
          setMessage(accepted ? '已保存。若页面提示需要重启，请重启 DSH 后生效。' : 'Host 拒绝了这次修改。')
        } catch (error) {
          setMessage(`保存失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }

      const resetAll = async () => {
        if (!writable || busy) return
        setBusy(true)
        try {
          const accepted = await props.form.mutate(
            ALL_FIELDS.map((path) => ({ op: 'unset', path: [path] })),
            snapshot.revision,
          )
          setMessage(accepted ? '已恢复为组合层默认值。' : 'Host 拒绝了重置。')
        } catch (error) {
          setMessage(`重置失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }

      const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }
      const heading = { margin: '18px 0 2px', fontSize: '13px', fontWeight: 600, opacity: 0.85 }
      const note = { fontSize: '12px', opacity: 0.65, margin: '4px 0 0' }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('h3', { style: { margin: 0, fontSize: '14px' } }, 'MineMate 设置'),
        h('p', { style: note }, '这些值写入 profile 的插件行配置；保存后如果提示重启，重启 DSH 生效。'),

        h('h4', { style: heading }, '连接'),
        h('div', { style: grid },
          ...TEXT_FIELDS.slice(0, 3).map(([fieldName, label, placeholder]) => field(label, h(Input, {
            value: draft[fieldName] ?? '',
            placeholder,
            disabled: !writable,
            onChange: (event) => update(fieldName, event.target.value),
          }))),
          numberField(draft, update, 'port', '端口', 1, 65535),
          field('认证', h('select', {
            value: draft.auth ?? 'offline',
            disabled: !writable,
            onChange: (event) => update('auth', event.target.value),
            style: { padding: '8px', borderRadius: '8px' },
          },
          h('option', { value: 'offline' }, 'offline（离线服）'),
          h('option', { value: 'microsoft' }, 'microsoft（正版登录）'))),
          field('主人用户名', h(Input, {
            value: draft.owner ?? '',
            placeholder: 'FPS1024',
            disabled: !writable,
            onChange: (event) => update('owner', event.target.value),
          })),
          field('人格名字', h(Input, {
            value: draft.companionName ?? '',
            placeholder: 'Alex',
            disabled: !writable,
            onChange: (event) => update('companionName', event.target.value),
          })),
        ),

        h('h4', { style: heading }, '行为'),
        h('div', { style: grid },
          ...BOOL_FIELDS.map(([fieldName, label]) => h('label', {
            key: fieldName,
            style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
          },
          h('input', {
            type: 'checkbox',
            checked: Boolean(draft[fieldName]),
            disabled: !writable,
            onChange: (event) => update(fieldName, event.target.checked),
          }),
          label)),
        ),
        h('div', { style: grid },
          numberField(draft, update, 'reactionDelayMs', '反应延迟 (ms)', 0, 1000),
          numberField(draft, update, 'autonomy', '主动性 (0–100)', 0, 100),
          numberField(draft, update, 'proactiveIntervalMs', '生活回合间隔 (ms)', 10000, 600000),
        ),

        h('h4', { style: heading }, 'Agent 与人格'),
        h('div', { style: grid },
          field('DSH Session ID（可选）', h(Input, {
            value: draft.agentSessionId ?? '',
            placeholder: '留空 = 当前 profile 的单个根 agent',
            disabled: !writable,
            onChange: (event) => update('agentSessionId', event.target.value),
          })),
        ),
        field('人格补充 prompt（可选）', h('textarea', {
          value: draft.persona ?? '',
          rows: 3,
          disabled: !writable,
          onChange: (event) => update('persona', event.target.value),
          style: { padding: '8px', borderRadius: '8px', resize: 'vertical' },
        })),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } },
          h(Button, { variant: 'primary', disabled: !writable || busy, onClick: save }, busy ? '保存中…' : '保存'),
          h(Button, { variant: 'outline', disabled: !writable || busy, onClick: resetAll }, '恢复默认'),
          message ? h('span', { style: { fontSize: '12px', opacity: 0.75 } }, message) : null),
        writable ? null : h('p', { style: note }, '当前配置是只读的。'),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: '@fps1024/dsh-minemate#dsh-minemate',
      }, MinemateConfigForm)), 'minemate: config form')
    }

    exports.apply = apply
    exports.inject = inject
    exports.MinemateConfigForm = MinemateConfigForm
    return module.exports
  },
})
