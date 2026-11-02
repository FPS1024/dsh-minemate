/**
 * DSH tool surface for the Minecraft body.
 *
 * Names are prefixed with `mc_` so they never collide with the harness's own
 * bash/read/edit tools. Long actions return quickly with an intent id; the
 * companion wakes the agent when the intent finishes.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const number = (description, extra = {}) => ({ type: 'number', description, ...extra })
const integer = (description, extra = {}) => ({ type: 'integer', description, ...extra })
const boolean = (description, extra = {}) => ({ type: 'boolean', description, ...extra })
const required = (spec) => ({ ...spec, required: true })
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })

function wrap(body, fn) {
  return async (args, exec) => {
    if (!body.online) return '❌ 还没进入游戏。等 Alex 上线后再试。'
    try {
      const value = await fn(args ?? {}, exec ?? {})
      // Tool output must be lossless JSON. A thunk here is an internal bug;
      // fail loudly instead of handing a function to the harness.
      if (typeof value === 'function') throw new Error('工具内部返回了未执行的函数')
      return value
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Stop the body as soon as the harness aborts this tool call, and let the
 * agent's turn finish instead of waiting out the tool's full timeout. */
async function abortable(body, exec, fn) {
  const signal = exec?.signal
  if (!signal) return fn()
  if (signal.aborted) {
    await body.stop()
    throw new Error('动作已取消')
  }
  return await new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      void body.stop()
      finish(reject, new Error('动作已取消'))
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(fn).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function pointArgs(args) {
  if (Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)) {
    return { x: args.x, y: args.y, z: args.z }
  }
  return args.target ?? 'owner'
}

export function createTools(body) {
  return [
    defineTool({
      name: 'mc_observe',
      description: '看一眼当前世界：位置、血量、饥饿、主人方位、附近玩家/敌对生物/掉落物、附近资源、背包、当前动作。开始一件事之前先看；不确定周围情况时也先看。',
      parameters: {
        radius: number('观察半径（格），默认 14', { default: 14 }),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 8_000,
      execute: wrap(body, (args) => body.observe(args.radius ?? 14)),
    }),

    defineTool({
      name: 'mc_scan',
      description: '在已加载的区块里查找方块。可按类别（wood/ore/stone/water/lava/chest/table/flower）或精确方块名查找；返回坐标、距离。找树用 kinds=["wood"]，找铁矿用 block="iron_ore"。',
      parameters: {
        kinds: strings('方块类别或精确名字的数组，例如 ["wood"] 或 ["oak_log"]'),
        block: string('精确方块名，例如 oak_log、iron_ore、crafting_table'),
        radius: number('扫描半径（格），默认 24', { default: 24 }),
        limit: integer('最多返回多少个，默认 24', { default: 24 }),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, (args) =>
        body.scanBlocks(args.kinds ?? [], args.radius ?? 24, args.limit ?? 24, args.block ?? null),
      ),
    }),

    defineTool({
      name: 'mc_look',
      description: '转头看一个东西：owner（主人）、nearest_hostile（最近敌对生物）、up/down/around，或坐标 "x,y,z"、玩家名。说话时看主人，挖矿时看目标方块。',
      parameters: {
        target: required(string('看哪里：owner / nearest_hostile / up / down / around / "x,y,z" / 玩家名')),
        x: number('可选：精确 x'),
        y: number('可选：精确 y'),
        z: number('可选：精确 z'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 8_000,
      execute: wrap(body, (args) => {
        let target = args.target
        if (Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)) {
          target = { x: args.x, y: args.y, z: args.z }
        }
        return body.look(target)
      }),
    }),

    defineTool({
      name: 'mc_goto',
      description: '走到某个地方：target 可为 owner、玩家名、坐标 "x,y,z"；也可以给 x/y/z。长距离行走会用寻路。可能返回“还在进行”，到达后会收到 [身体] 通知；不要因为没立刻到达就重复调用。',
      parameters: {
        target: string('目标：owner / 玩家名 / "x,y,z"；不给 x/y/z 时默认 owner'),
        x: number('目标 x'),
        y: number('目标 y'),
        z: number('目标 z'),
        range: number('停在离目标多少格，默认 2'),
        timeout_ms: integer('这次最多等多少毫秒，默认 25000；超时后身体仍会继续走'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 35_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () =>
          body.goto(pointArgs(args), args.range ?? 2, { timeoutMs: args.timeout_ms ?? 25_000 }),
        ),
      ),
    }),

    defineTool({
      name: 'mc_move',
      description: '短距离微调：向 forward/back/left/right 走几秒，可配合 sprint/sneak。适合绕开面前的障碍或调整站位；长距离请用 mc_goto。',
      parameters: {
        direction: required(string('方向：forward / back / left / right', { enum: ['forward', 'back', 'left', 'right'] })),
        seconds: number('走几秒，默认 1，最大 10'),
        sprint: boolean('是否冲刺'),
        sneak: boolean('是否潜行'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 15_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () =>
          body.move(args.direction, args.seconds ?? 1, { sprint: args.sprint, sneak: args.sneak }),
        ),
      ),
    }),

    defineTool({
      name: 'mc_follow',
      description: '开始跟着主人，保持指定距离。会一直跟随，直到你调用 mc_stop 或开始别的动作。',
      parameters: {
        distance: number('和主人保持多少格，默认 3'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 8_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () => body.follow(args.distance ?? 3)),
      ),
    }),

    defineTool({
      name: 'mc_dig',
      description: '挖方块。可以给精确坐标，或 block="oak_log" 让身体找最近的；count 最多 16。会自动走近、看目标、挖，并顺手捡掉落物。挖石头需要镐。',
      parameters: {
        block: string('精确方块名，例如 oak_log、stone、dirt'),
        x: number('目标 x'),
        y: number('目标 y'),
        z: number('目标 z'),
        count: integer('挖几个，默认 1，最大 16'),
        radius: integer('找方块半径，默认 32'),
        timeout_ms: integer('这次最多等多少毫秒，默认 35000；超时后身体仍会继续挖'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 45_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () => body.dig(args)),
      ),
    }),

    defineTool({
      name: 'mc_collect',
      description: '采集指定方块若干块（异步长任务）：自动反复找、走近、挖、捡，直到数量够了或找不到。返回 intent id，完成会收到 [身体] 通知。砍树、挖矿优先用这个。',
      parameters: {
        block: required(string('精确方块名，例如 oak_log、iron_ore、stone')),
        count: integer('要采多少个，默认 1，最大 64'),
        radius: integer('搜索半径，默认 32'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, (args) => body.collect(args.block, args.count ?? 1, args.radius ?? 32)),
    }),

    defineTool({
      name: 'mc_pickup',
      description: '把附近地上的掉落物捡起来：走近每个物品等服务器拾取。挖完/打完/别人丢东西后使用。',
      parameters: {
        radius: number('拾取半径，默认 8，最大 32'),
        timeout_ms: integer('这次最多等多少毫秒，默认 20000'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 30_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () => body.pickup(args.radius ?? 8, { timeoutMs: args.timeout_ms ?? 20_000 })),
      ),
    }),

    defineTool({
      name: 'mc_place',
      description: '放置背包里的方块到指定坐标。会自动走近、拿在手上、找依附面。不要放在自己脚下。',
      parameters: {
        item: required(string('物品名，例如 oak_planks、cobblestone、torch')),
        x: required(number('目标 x')),
        y: required(number('目标 y')),
        z: required(number('目标 z')),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 25_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () => body.place(args.item, args.x, args.y, args.z)),
      ),
    }),

    defineTool({
      name: 'mc_attack',
      description: '攻击目标：nearest_hostile（最近敌对生物）、玩家名或实体名。会追到攻击距离内。血少先跑，不要硬拼。',
      parameters: {
        target: string('目标，默认 nearest_hostile'),
        radius: number('搜索半径，默认 12'),
        timeout_ms: integer('战斗最多多少毫秒，默认 15000'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 25_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () =>
          body.attack(args.target ?? 'nearest_hostile', args.radius ?? 12, { timeoutMs: args.timeout_ms ?? 15_000 }),
        ),
      ),
    }),

    defineTool({
      name: 'mc_eat',
      description: '吃背包里的食物。饥饿低时使用；吃完会恢复饥饿和血量。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 15_000,
      execute: wrap(body, () => body.eat()),
    }),

    defineTool({
      name: 'mc_sleep',
      description: '走到附近的床并睡觉。只有夜晚或雷雨、附近没有怪物时才能睡；睡下后天亮会自动醒。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 35_000,
      execute: wrap(body, (_args, exec) => abortable(body, exec, () => body.sleep())),
    }),

    defineTool({
      name: 'mc_wake',
      description: '从床上起来。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, () => body.wake()),
    }),

    defineTool({
      name: 'mc_craft',
      description: '合成物品。附近有工作台会自动用；材料不足会说明。常用：oak_planks、stick、crafting_table、wooden_pickaxe。',
      parameters: {
        item: required(string('要合成的物品名')),
        count: integer('合成几个，默认 1'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 30_000,
      execute: wrap(body, (args, exec) =>
        abortable(body, exec, () => body.craft(args.item, args.count ?? 1)),
      ),
    }),

    defineTool({
      name: 'mc_equip',
      description: '把背包里的物品拿到手上或穿到装备栏。slot: hand/head/torso/legs/feet/off-hand。',
      parameters: {
        item: required(string('物品名')),
        slot: string('装备位置，默认 hand', { enum: ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'] }),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, (args) => body.equip(args.item, args.slot ?? 'hand')),
    }),

    defineTool({
      name: 'mc_give',
      description: '把背包里的物品丢给主人。会先看向主人。',
      parameters: {
        item: required(string('物品名')),
        count: integer('数量，默认 1'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, (args) => body.give(args.item, args.count ?? 1)),
    }),

    defineTool({
      name: 'mc_use',
      description: '使用当前手持物品/方块（右键）：吃东西、放船、点火等。如果打开的是容器界面，会自动关上；存取物品用 mc_container。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, () => body.useHeld()),
    }),

    defineTool({
      name: 'mc_container',
      description: '存取附近的箱子/木桶/陷阱箱：action=list 查看内容，withdraw 取出，deposit 存入。会自动走近并打开，操作完关上。',
      parameters: {
        action: required(string('操作：list / withdraw / deposit', { enum: ['list', 'withdraw', 'deposit'] })),
        item: string('物品名（withdraw/deposit 必填）'),
        count: integer('数量，默认 1'),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 35_000,
      execute: wrap(body, (args, exec) => abortable(body, exec, () => body.container(args))),
    }),

    defineTool({
      name: 'mc_jump',
      description: '跳一下。越过一格高、表达情绪或引起注意时用。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, () => body.jump()),
    }),

    defineTool({
      name: 'mc_sneak',
      description: '开始或停止潜行。边缘、岩浆旁、想悄悄靠近时潜行。',
      parameters: {
        enabled: required(boolean('true 开始潜行，false 停止')),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, (args) => body.sneak(args.enabled)),
    }),

    defineTool({
      name: 'mc_sprint',
      description: '开始或停止冲刺。直路赶路时开，狭窄/危险处关。',
      parameters: {
        enabled: required(boolean('true 开始冲刺，false 停止')),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, (args) => body.sprint(args.enabled)),
    }),

    defineTool({
      name: 'mc_swing',
      description: '挥一下手。打招呼、示意、表达情绪时用。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, () => body.swing()),
    }),

    defineTool({
      name: 'mc_say',
      description: '在游戏聊天里说一句话。对主人说话、报告进展、提醒危险时用。保持简短自然，不要刷屏。',
      parameters: {
        message: required(string('要说的话，最多 240 字符')),
      },
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, async (args) => ((await body.say(args.message)) ? `说了：${args.message}` : '没能发出消息。')),
    }),

    defineTool({
      name: 'mc_status',
      description: '查看身体状态：在线、坐标、血量、饥饿、主人方位、当前动作/意图。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 5_000,
      execute: wrap(body, () => body.statusLine()),
    }),

    defineTool({
      name: 'mc_stop',
      description: '立刻停下：取消寻路、停止挖掘/战斗/跟随、清空移动键。感觉卡住或主人让你停时使用。',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      execute: wrap(body, async () => {
        await body.stop()
        return '停下了。'
      }),
    }),
  ]
}
