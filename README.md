# MineMate — DSH Minecraft body

> 让 **DeepSeek Harness** 作为一个真实的 Minecraft Java 玩家生活：看、走、挖、建、捡、打、睡、聊天。

- 开源地址：<https://github.com/FPS1024/dsh-minemate>
- 包名：`@fps1024/dsh-minemate`
- 当前版本：**1.2.5（P2 + 可视化配置 + Host bundle）**

> **1.2.5 关键修复**：如果在发行版客户端启用时报
> `createRequire.resolve.paths is not a function or its return value is not iterable`，
> 请升级到 1.2.5。Host 依赖已打包进 `bundle/index.js`，绕过了 DSH
> profile loader 对 `readable-stream` 发出的 `process/`、`string_decoder/`
> 这种带尾斜杠请求的解析 bug。
- License：MIT

这个仓库是独立插件项目，不属于 `~/deepseek-harness` 的编译产物。DSH 是大脑，本插件是身体；在已经安装好的 DSH 发行版里从插件地址安装即可。

## 它是什么

- **DSH 原生插件**：不再自己写 LLM 循环、ContextBuilder、Decision JSON 解析；思考交给 DSH 的 agent loop。
- **真实玩家身体**：通过 mineflayer 以正常玩家账号进服，服务器和其他玩家看到的是玩家，不是 NPC。
- **实时感知**：`mc_observe` / `mc_scan` / 掉落物 / 视线 / 敌对生物 / 背包 / 容器，不是一张固定快照。
- **可取消 intent**：`mc_goto`、`mc_collect` 等先返回，身体继续执行；完成/失败时用 `agent.followup(...)` 把大脑叫醒。
- **反射层**：吃、低血逃跑、自动还手、避岩浆、夜晚睡床、顺手捡掉落物，不花模型调用。
- **P2 人化层**：平滑凝视（主人/敌人/行进方向）、步态（安全时冲刺、危险处潜行）、反应/打字延迟。

## 安装（发行版客户端）

### 方式 A：直接从 Git 地址安装

```bash
dsh plugin --profile tui add github:FPS1024/dsh-minemate
dsh tui
```

或者在 DSH 客户端插件页的安装地址里填入：

```text
github:FPS1024/dsh-minemate
```

插件包自带 `dsh.bundle.patch`，安装后会把身体插件插入 profile。

### 方式 B：从插件市场索引安装

仓库里的 `market/index.json` 是 DSH 插件市场索引。把它和 `market/icon.svg` 发布到任意 HTTPS 静态主机（GitHub Pages / raw.githubusercontent.com）后，在 DSH 的 **插件 → 发现 → 添加索引源** 填入索引 URL。

生成索引（在提交代码之后）：

```bash
pnpm run market
# 写入 market/index.json + market/icon.svg
```

可以直接使用的索引 URL（jsDelivr 的更新比 raw.githubusercontent.com 快）：

```text
https://cdn.jsdelivr.net/gh/FPS1024/dsh-minemate@main/market/index.json
```

raw 备用地址：

```text
https://raw.githubusercontent.com/FPS1024/dsh-minemate/main/market/index.json
```

### 运行时依赖

`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery` 由 DSH 宿主/profile 提供。包内刻意没有把它们写成 peer dependency，避免普通 `pnpm install` 去解析未发布的 harness 包。

## 本地开发

前置：Node ≥ 22.12、pnpm 10、一个可用的 DSH 安装、一个 Minecraft 服务器（Paper 1.21.6 即可）。

```bash
git clone https://github.com/FPS1024/dsh-minemate.git
cd dsh-minemate
pnpm install

# 本地测试服可以用 MineMate 的 docker-compose：
#   cd ~/MineMate && pnpm mc:up

./scripts/dsh-dev.sh
# 或 web 宿主：
DSH_PROFILE=web ./scripts/dsh-dev.sh --no-open --port 0
```

`scripts/dsh-dev.sh` 会：

1. 从 `~/.dsh/profiles/node_modules/@deepseek-ai` 链接 DSH 运行时包（仅本地开发）；
2. 生成 `.local/dsh-minemate.patch.yml`（绝对路径，不提交）；
3. 执行 `dsh tui --patch ...`。

## 配置

### 在 DSH 客户端里配置

安装并启用插件后，打开 **插件 → MineMate → 行 `dsh-minemate` → 配置**。1.2.2 起插件自带浏览器侧配置面板（`client.js`），可以编辑下面的连接、行为、Agent 字段并保存；如果页面提示需要重启，重启 DSH 后生效。

`cordis.patch.yml` 的 `config` 仍然有效，适合部署时直接写 profile：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `25565` | 服务器 |
| `username` | `Alex` | 玩家名 |
| `auth` | `offline` | `offline` 或 `microsoft` |
| `version` | `1.21.6` | 协议版本 |
| `owner` | `FPS1024` | 主人用户名（大小写不敏感） |
| `companionName` | `Alex` | 人格里的名字 |
| `autoConnect` | `true` | 插件加载即上线 |
| `reconnect` | `true` | 断线指数退避重连 |
| `reflex` | `true` | 反射层总开关 |
| `humanize` | `true` | 动作前反应延迟 |
| `humanizeChat` | `true` | 说话前打字延迟 |
| `reactionDelayMs` | `150` | 反应延迟基准 |
| `gaze` | `true` | 平滑凝视 |
| `gait` | `true` | 冲刺/潜行步态 |
| `autoDefend` | `true` | 被近身敌人攻击时还手；苦力怕等改为逃跑 |
| `avoidLava` | `true` | 岩浆 2 格内中断动作并离开 |
| `autoSleep` | `true` | 夜晚、有床、无怪且空闲时自动睡 |
| `autonomy` | `60` | 0–100，空闲生活回合主动程度；0 关闭 |
| `proactiveIntervalMs` | `45000` | 生活回合最小间隔 |
| `agentSessionId` | `''` | 指定 DSH session；空 = 当前 profile 的单个根 agent |
| `persona` | `''` | 追加人格 prompt |

## 工具面

感知：

- `mc_observe`、`mc_scan`、`mc_look`、`mc_status`

移动与身体语言：

- `mc_goto`、`mc_move`、`mc_follow`、`mc_jump`、`mc_sneak`、`mc_sprint`、`mc_swing`

世界交互：

- `mc_dig`、`mc_collect`、`mc_pickup`、`mc_place`、`mc_use`
- `mc_attack`、`mc_eat`、`mc_craft`、`mc_equip`、`mc_give`
- `mc_container`（`list` / `withdraw` / `deposit`）
- `mc_sleep` / `mc_wake`
- `mc_say`
- `mc_stop`

长动作返回 intent id；完成/失败时 companion 会把 `[身体] ...` 消息注入 agent。

## 皮肤与图标

- 插件卡片图标是 `icon.svg`：经典 Alex 头像（橙发、浅肤色、绿眼、浅绿色上衣）。
- **游戏内皮肤不由 mineflayer 决定**：皮肤是服务器/客户端根据玩家 profile 发给其他客户端的。离线服（`online-mode=false`）通常按离线 UUID 选默认 Steve/Alex，或由服务器皮肤插件覆盖。
- 要固定 Alex 的游戏内皮肤，二选一：
  1. 服务器安装 **SkinsRestorer**（或同类皮肤插件），给 `Alex` 设置默认 Alex 皮肤；
  2. 使用正版 Microsoft 账号 + `online-mode=true`，让真实 profile 皮肤生效。
- 本插件不会伪造皮肤纹理；它只负责让玩家正常上线和行动。具体命令见 [docs/skin.md](docs/skin.md)。

## 验证

```bash
pnpm build                # 修改 Host 源码后重新生成 bundle/index.js
pnpm test                 # 单元测试：感知、humanizer、反射判定、插件装配、客户端配置 bundle
pnpm smoke                # 实机：上线→观察→扫树→走→挖→捡→说
pnpm smoke:place          # 实机：放火把，确认成功判定
pnpm smoke:container      # 实机：箱子 list / deposit / withdraw 往返
pnpm smoke:sleep          # 实机：睡床/起床（需要夜晚）
pnpm smoke:defend         # 实机：RCON 放 NoAI 僵尸，确认自动还手
pnpm smoke:lava           # 实机：RCON 放岩浆，确认避岩浆
```

已实测（2026-11-02）：

- 单元测试 15 passed（含客户端配置 bundle 的 slot 注册与表单渲染）。
- 1.2.5 实机安装：web profile 用普通 tarball 包安装，插件激活成功、Alex 上线；1.2.2 的 `createRequire.resolve.paths` 错误不再出现。
- Web UI 验收：Plugins → `@fps1024/dsh-minemate` → Configure，MineMate 设置表单完整渲染；把 `autonomy` 改为 61 并保存，profile 写入 `autonomy: 61`。
- 实机：上线、观察、扫描 `oak_log`、寻路、挖原木、拾取、聊天。
- DSH headless：harness 自己调用 `mc_observe` / `mc_scan` / `mc_craft` / `mc_place` / `mc_say`，服务器日志出现 Alex 聊天。
- 睡床：`mc_sleep` → `isSleeping: true`，`mc_wake` → `false`。
- 自动还手：NoAI 僵尸 → `defend` 事件，血量 20/20。
- 避岩浆：2 格外岩浆 → `lava` 事件，Alex 撤离到安全位置。
- `mc_place`：`在 59/-60/2 放了 torch。`
- `mc_container`：合成/放置箱子，`deposit torch` → `list torchx1` → `withdraw`，数量往返一致。

## 已知边界

- 没有截图/视觉；当前是结构化感知。真正“自己看见画面”需要 Java 客户端身体。
- 没有独立 `BodyPort` 接口；后续换 Java 身体时再抽。
- 战斗走位、盾牌、弓箭、跳跃搭路等高级身体技巧在后续。
- 空间记忆/目标（家、箱子、矿点、建筑、危险点）在 P4。
- 公共服务器注意反作弊/ToS；建议只在自己的服务器使用。

## License

MIT
