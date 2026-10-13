# agent-provider-switch

`@minniexcode/agent-provider-switch` 是一个本地优先的 CLI，用于管理和切换 Codex 与 Claude Code 的 provider 路由。

它把自己的状态保存在 `~/.config/agent-provider-switch`，与它写入的运行时目录分开，因此 provider 记录、备份和运行时投影都通过明确命令修改，而不是手工编辑 `config.toml` 和 `settings.json`。

当前包版本：`1.2.0`。它新增 `--target <id>`，并让两个 target 共用同一份实现；存储格式、JSON envelope 和错误码词表都没有变化。下面描述的就是当前 `aps --help` 打印的内容。各版本的发布说明见 [CHANGELOG](./CHANGELOG.md)。

## 安装

```bash
npm install -g @minniexcode/agent-provider-switch
aps --help
```

需要 Node.js `>=18`，但有一个注意事项 —— 见[未实现](#未实现)。从源码构建见[开发](#开发)。

## 快速开始

### Codex

```bash
aps init
aps add packycode --profile packycode --model gpt-5 --api-key sk-xxx --base-url https://api.example/v1
aps switch packycode
aps status
aps doctor
```

- `init` 创建工具 home 文件。
- `add` 在 `providers.json` 中保存受管 provider，并创建或更新对应的 `[model_providers.<id>]` 投影。
- `switch` 写入顶层 `model` 和 `model_provider`，并把 `OPENAI_API_KEY` 投影到 `auth.json`。
- `status` 汇总当前映射、认证投影和漂移状态。
- `doctor` 输出问题优先的诊断结果。

`--profile` 是受管 Codex `model_provider` id 的 CLI alias，不是旧 Codex 顶层 `profile` selector。

### Claude Code

```bash
aps add --claude opus --from-file ~/.claude/settings.json
aps add --claude copilot --from-file ~/.claude/settings-copilot.json
aps switch --claude copilot
aps current --claude
aps list --claude
aps show --claude copilot
```

- `add --claude` 把完整的 `settings.json` 导入为命名配置，存入 `claude-providers.json`。存在 `claudeDefaults` 块时只保存与它不同的条目，`--full` 则保留全部条目。
- `switch --claude` 原子替换 `~/.claude/settings.json`；有共享默认设置时叠加在其上。
- `current --claude` 检测当前活跃的 Claude 配置。
- `list --claude` 显示所有 Claude 配置及活跃标记。
- `show --claude` 显示单个配置解析后的结果，标出继承条目，掩码 secret 类 env 值，并且不返回原始 `settings` blob。

没有 `claudeDefaults` 块时，Claude provider 存储完整的 `settings.json` 内容，切换时替换整个文件。设置高度重叠的 provider 更适合存成差异，见下一节。

## 选择 target

每条命令默认作用于 Codex，除非用 target flag 指定。三个 flag 等价，且一次只能指定一个 target：

| 写法 | 含义 |
|---|---|
| *(无)* | Codex —— 默认值 |
| `--codex` | 显式写出 Codex，让命令行不论选哪个 target 读起来都一致 |
| `--claude` | Claude Code |
| `--target <id>` | `codex` 或 `claude`，用于来自变量的取值 |

指定两个不同 target 会以 `INVALID_ARGUMENT` 被拒绝，而不是按优先级择一；重复指定同一个则被接受。`--target` 的值以空格分隔 —— `--target=codex` 这种写法会被拒绝。

不同命令里 target 的含义不同：

| 命令 | target 范围 | flag 的含义 |
|---|---|---|
| `add`、`switch`、`list`、`show`、`current`、`remove` | 一个 | 选择 Claude 代码路径；默认是 Codex |
| `init`、`migrate`、`setup`、`edit`、`import`、`export`、`config show`、`config list-profiles` | Codex | Claude target 被拒绝；`--codex` 被接受且不改变任何行为 |
| `config compact` | Claude | 必须指定 Claude target —— 该命令没有 Codex 形态 |
| `status`、`doctor`、`backups list` | 两个 | 收窄报告范围，而不是选择代码路径；裸调用表示两个都要 |
| `backups prune`、`rollback`、`unlock` | 共享 | 两个都被拒绝：一把锁、一个 `backups/` 同时服务两个 target，任何一个 flag 都不是更小的答案 |

在这三条双 target 命令上，`--codex-dir` 与 Claude target 同时出现也会被拒绝 —— 该目录本来就属于命令要报告的内容，指定它与收窄范围相矛盾。

### 同时报告两个 target

`status`、`doctor`、`backups list` 一次运行同时覆盖两个 target，所以只用 Claude 的用户也有了自己的健康检查与状态报告。

- **你从未配置过的 target 不产生任何 finding，也不会让这次运行变成不健康。** 证据必须是文件 —— 注册表、真实的运行时配置文件，或 defaults 块 —— 所以一个空的 `~/.codex` 什么也证明不了，也不会随之产生"配置缺失"的 finding。
- **只看 Claude 的运行不读取任何 Codex 文件，也不运行 Codex CLI 探针**，所以机器上没有 Codex CLI 时不会被报告成 Codex 有问题。
- 每条 finding 都会说明自己属于哪个 target。唯一例外是残留的锁：它只报告一次且 `target` 为 `null`，因为一把锁会同时阻塞两个 target 的写入。正在被运行中的操作持有的锁是一种状态而非 finding，所以后台跑一次命令不会让 `doctor` 断言安装已损坏。
- 裸调用多 target 命令时，JSON envelope 的 `target` 为 `null` —— 请读 `targets`，它才是权威字段。只有恰有一个 target 在范围内时 `target` 才非空。
- `aps backups list` 给每条记录打上 `codex`、`claude`、`mixed` 或 `unknown` 标签，并可按 target 过滤。无法分类的 manifest 读作 `unknown` 而不是去猜，因为这个标签正是用来告诉你 `rollback` 将要恢复什么。`mixed` 同时含两个 target 的文件，因此出现在两个收窄后的列表里；`unknown` 只出现在未过滤的列表中。

每个 target 的完整 payload 形状 —— 每个字段都是 `ok` / `absent` / `invalid` / `unavailable` 四种 reading 之一，`healthy` 取三值 —— 见[技术架构文档](./docs/agent-provider-switch-technical-architecture.md)。

## 命令面

```text
aps init
aps migrate
aps list [--claude]
aps show <provider> [--claude] [--reveal]
aps current [--claude]
aps status [--codex] [--claude]
aps config show
aps config list-profiles
aps config compact --claude [--dry-run]
aps add <provider> --profile <id> --model <model> --api-key <key> [--base-url <url>] [--create-profile]
aps add --claude <name> --from-file <settings.json> [--full]
aps edit <provider> [options] [--create-profile]
aps switch <provider> [--claude]
aps remove <provider> [--claude] --force
aps import <file>
aps export <file>
aps backups list [--codex] [--claude]
aps backups prune [--keep N]
aps unlock [--force]
aps rollback [backup-id]
aps doctor [--codex] [--claude]
aps setup
```

凡是接受 target 的命令，也都可以用 `--target <id>` 取代那两个简写 flag。所有命令都接受 `--json` 标准 JSON envelope，以及用于指定目标 Codex 目录的 `--codex-dir <path>`；`--codex-dir` 必须跟路径，紧随其后以 `-` 开头的 token 会被拒绝，而不是被当作路径。

`setup` 已废弃，只保留为指向 `init`（全新状态）或 `migrate`（采用已有 Codex 配置）的兼容入口。

## 共享 Claude 默认设置

各 provider 的设置往往几乎完全重叠：同样的十几个 env 开关、同样的主题，常常还有同样的权限块。把公共部分放进工具配置，每个 provider 记录只保留自己独有的内容。

`~/.config/agent-provider-switch/agent-provider-switch.json` —— 保留已有的 `version` 字段，手工加入这个块；没有任何命令会创建它：

```json
{
  "version": "1.2.0",
  "claudeDefaults": {
    "settings": {
      "env": {
        "CLAUDE_CODE_USE_VERTEX": "0",
        "CLAUDE_CODE_USE_BEDROCK": "0",
        "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
        "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
        "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
        "CLAUDE_CODE_EFFORT_LEVEL": "XHIGH",
        "MCP_CONNECT_TIMEOUT_MS": "30000"
      },
      "model": "sonnet",
      "theme": "dark",
      "editorMode": "normal",
      "autoCompactEnabled": true
    }
  }
}
```

这样每个 provider 只需写自己的条目：

```json
"freemodel": {
  "settings": {
    "env": {
      "ANTHROPIC_BASE_URL": "https://cc-t2.freemodel.dev",
      "ANTHROPIC_API_KEY": "...",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5.5"
    }
  },
  "note": "freemodel claude code"
}
```

合并规则只有一条：**对象递归合并，provider 的值优先，数组整体替换，`null` 删除继承来的键。** `env` 不需要特殊处理 —— 它只是一个由标量组成的对象，所以其中的键逐个合并。

有两点最好提前知道，以免被意外到：

- **空对象不会清空。** 默认设置里 `enabledPlugins` 有内容时，provider 写 `"enabledPlugins": {}` 仍然继承它们。要丢掉某个继承来的键，请把它设为 `null`。
- **默认设置里有、provider 里没写的键，是继承而来，不是缺失。** 这正是设计目的，但意味着 provider 存储的设置不再是全部内容；`aps show --claude <name>` 打印解析后的结果并标出每个继承条目，`--json` 会列出继承路径（只有路径，绝不含值）。

转换你已有的 provider，先预览：

```bash
aps config compact --claude --dry-run   # 只报告将发生的变化；不加锁、不写入
aps config compact --claude             # 备份后把每条记录改写成差异形式
```

压缩只改变 provider 的存储方式。记录在每次读取时都会叠加在默认设置之上，所以 `switch --claude` 在压缩前后写出的文件相同，`aps rollback` 也能撤销这次改写。格式错误的 `claudeDefaults` 块 —— 例如把 `env` 直接放在它下面而不是 `settings` 下面 —— 会以 `INVALID_CONFIG` 被拒绝，而不是被静默忽略；由于每条命令都会读取工具配置，修复之前所有命令都会被它拦住。

### 查看 secret

`show` 会掩码所有 key 名看起来像凭据的 env 值（`*_TOKEN`、`*_API_KEY`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL`，以及任何包含 `auth` 的 key），human 输出和 `--json` 输出都是如此。`ANTHROPIC_BASE_URL` 这类非 secret 的邻居字段照常显示，而 Claude `show` 在两种模式下都不返回原始 `settings` blob。

`--reveal` 打印真实值并附带 `settings` blob。它是显式的逃生口，不会被默认应用：

```bash
aps show --claude copilot --reveal
```

Codex `show --json` 是刻意的例外：不加 `--reveal` 也会返回完整的 `apiKey`，这是有文档记录的自动化契约。

工具写入的文件在 **macOS 和 Linux** 上使用仅属主可读权限（文件 `0600`，工具自己创建的目录 `0700`）。Windows 上跳过权限收紧 —— NTFS 没有供 `chmod` 设置的 group/other 位，访问由 ACL 决定，本工具不触碰 ACL。在 macOS 和 Linux 上，升级前写入的文件会保持原有权限，直到下一次写入触及它；要一次性全部修正：

```bash
# 仅 macOS / Linux —— 在 Windows 上是 no-op。
chmod -R go-rwx ~/.config/agent-provider-switch ~/.codex/config.toml ~/.codex/auth.json ~/.claude/settings.json
```

## Runtime 投影

Codex `0.134.0+` 的活动路由由 `config.toml` 顶层 `model` 和 `model_provider` 决定。受管 OpenAI-compatible provider 的投影形态：

```toml
model = "gpt-5"
model_provider = "packycode"

[model_providers.packycode]
name = "packycode"
base_url = "https://api.example/v1"
wire_api = "responses"
requires_openai_auth = true
```

默认不为新受管 provider 写入旧 `[profiles.*]` 段。`--create-profile` 是显式开关，用于额外写入对应的 `[profiles.<id>]`，供仍通过该段路由的旧 Codex 版本使用；写入受管投影时它会清理旧 `env_key` / `env_key_instructions` 字段。

认证会投影到目标 `auth.json`，使用 API-key 模式和 `OPENAI_API_KEY`。

## 状态位置

```text
~/.config/agent-provider-switch/     # 工具 home
  agent-provider-switch.json
  providers.json
  claude-providers.json
  backups/
  .aps.lock

~/.codex/                            # Codex target
  config.toml
  auth.json

~/.claude/                           # Claude Code target
  settings.json
```

环境变量：

- `APS_HOME` 覆盖工具 home。
- `APS_CODEX_DIR` 在未传 `--codex-dir` 时提供默认 Codex 目录。
- `APS_CLAUDE_DIR` 覆盖 Claude Code 目录（默认：`~/.claude`）。
- 开发环境下，`NODE_ENV=development` 且没有显式覆盖时默认使用 `./dev-codex/local-sandbox`。

`migrate` 把已有的 Codex 运行时配置 adopt 到受管状态，它不是全新安装的命令：

```bash
aps migrate
aps migrate --overwrite --codex-dir ~/.codex
```

## 锁与备份保留

每个写入命令都会获取同一把锁（两个 target 共用），并先把要改动的文件快照到 `backups/`。

写入过程中被 kill 的进程会把锁留下。`aps unlock` 可以清除它，但只会在确认记录的持有者确实已消失之后才清除 —— 持有者仍存活时会被拒绝，因为从运行中的进程手里抢锁会破坏状态，而拒绝只是带来不便：

```bash
aps unlock
aps unlock --force   # 用于你确认已被复用的 pid
```

这里没有基于超时的接管：慢速 `migrate` 可以超过任何计时器，所以看起来存活的 pid 一律按存活处理，`--force` 是针对"它其实不是原持有者"这一情况的显式覆盖。

备份默认保留最新的 20 个。每次成功变更后都会自动执行保留策略，`backups prune` 是手动入口：

```bash
aps backups prune
aps backups prune --keep 5
```

任何仍被幸存 manifest 引用的目录都不会被删除，因此即使创建它的备份本身很旧，回滚路径依然完整。manifest 缺失或不可读的目录只会被报告，不会被删除。两个 target 共用同一个 `backups/` 目录和同一个 `latest.json`。

## 未实现

- 创建或编辑 `claudeDefaults` 块的命令。它需要手工编写，块不存在时 `config compact` 会拒绝执行，而不是去猜哪些键是公共的。
- Claude provider 记录的导出与导入 —— 这两个命令只支持 Codex。
- 按字段逐个创建 Claude provider；目前只支持 `--from-file` 导入。
- GitHub Copilot SDK 集成、device-flow 登录、HTTP proxy bridge、后台 runtime service、内置第三方 router 封装、账号系统或云同步、Claude Code 插件市场管理。
- 退出码分类体系：成功为 `0`，失败为 `1`，没有用于用法错误的 `2`。
- 修改 `engines.node`。它仍声明 `>=18`，而唯一的运行时依赖要求 `>=20.12`，且 CI 不测试 Node 18 —— CI 全绿不能证明声明的最低版本已受支持。

## 开发

```bash
npm run build
npx tsc --noEmit
npm test          # 进程内测试套件；静默即通过
npm run test:e2e  # 真实子进程 + 沙箱根目录；打印 passed/failed/skipped
node dist/cli.js --help
npm pack --dry-run
```

`npm test` 通过唯一的进程内 harness 运行所有 `tests/*.spec.js`，通过时不打印任何内容。`npm run test:e2e` 先构建 CLI，再把真实二进制作为子进程驱动，`APS_HOME`、`APS_CODEX_DIR`、`APS_CLAUDE_DIR` 全部指向运行器拒绝离开的沙箱。它是独立命令、也是独立的 CI 步骤：每个用例都要付一次进程启动成本，而它覆盖的是进程内套件在结构上无法覆盖的部分 —— 退出码、真实管道、环境隔离。

## 文档

- [产品概览](./docs/agent-provider-switch-product-overview.md)
- [技术架构](./docs/agent-provider-switch-technical-architecture.md)
- [CLI 用法](./docs/cli-usage.md)
- [1.x 路线图](./docs/agent-provider-switch-1.x-roadmap.md)
- [CHANGELOG](./CHANGELOG.md)
- 当前事实源：[PRD 1.2.0](./docs/PRD/agent-provider-switch-prd-v1.2.0.md)、[Design 1.2.0](./docs/Design/agent-provider-switch-v1.2.0-design.md)

`docs/PRD/` 和 `docs/Design/` 下的内容都作为历史保留，每次发布各对应一份 PRD 和一份设计文档。
