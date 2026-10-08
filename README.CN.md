# agent-provider-switch

`@minniexcode/agent-provider-switch` 是一个本地优先的 CLI，用于管理和切换 Codex 与 Claude Code 的 provider 路由。

它把 `agent-provider-switch` 自己的工具状态和目标运行时目录分开，让 provider 管理、备份和运行时投影通过明确命令完成，而不是手工编辑文件。

当前包版本：`1.1.0`

`1.1.0` 让 Claude Code provider 共享公共设置。`agent-provider-switch.json` 中的 `claudeDefaults` 块保存所有 provider 重复出现的设置，每个 provider 记录只存自己独有的部分，`aps switch --claude` 把两层叠加后写入。`aps config compact --claude` 把已有记录改写成这种形式，`aps add --claude` 现在也以这种形式保存新记录。这一切都是可选的：没有这个块的工具 home 行为与以前完全一致。详见[共享 Claude 默认设置](#共享-claude-默认设置)。

`1.0.0` 是改名版本。仓库、npm 包名、可执行文件名（`aps`）、工具 home（`~/.config/agent-provider-switch`）、环境变量（`APS_*`）和状态文件名在同一次破坏性发布中一起迁移。留在 `1.0.0` 之前位置的工具 home 会被第一条运行的命令自动移动到新位置，升级不需要任何手工步骤。旧的可执行文件名直接移除，不保留别名。

`0.4.1` 是状态恢复版本。新增 `aps unlock [--force]` 用于处理持锁进程已不存在的锁，新增 `aps backups prune [--keep N]` 及自动保留策略来约束此前无限增长的 `backups/`。同一秒内的多次变更不再互相覆盖备份，`doctor` 会报告被占用或陈旧的锁。另外两个此前从未真正生效的 flag 现在生效了：`--create-profile` 会写入它一直声称要写的旧 `[profiles.<id>]` 段；在不支持 Claude 的命令上传 `--claude` 会被拒绝，而不是被静默忽略。

`0.4.0` 是基础版本。`--claude`、`--force`、`--merge`、`--overwrite`、`--create-profile` 变成真正的 boolean flag；无法识别的命令以退出码 `1` 加结构化错误结束，而不是以退出码 `0` 打印帮助；`status` 报告工具 home 根目录；整个测试套件收敛到唯一的 `runCli(argv, io)` 入口，并在 Windows 和 Linux 的 Node 20 / 22 上运行。

`0.3.x` 通过 `--claude` flag 增加了 Claude Code provider 切换，`0.3.1` 完成了 secret 处理相关修复。工具同时支持 Codex（OpenAI-compatible provider 投影到 `config.toml`/`auth.json`）和 Claude Code（完整 `settings.json` 配置切换）。

## 安装

```bash
npm install -g @minniexcode/agent-provider-switch
aps --help
```

本地开发：

```bash
npm install
npm run build
node dist/cli.js --help
```

需要 Node.js `>=18`。

## 主工作流 (Codex)

```bash
aps init
aps add packycode --profile packycode --model gpt-5 --api-key sk-xxx --base-url https://api.example/v1
aps switch packycode
aps status
aps doctor
```

- `init` 创建 `agent-provider-switch` 工具状态文件。
- `add` 在 `providers.json` 中保存受管 provider，并创建或更新对应 `[model_providers.<id>]`。
- `switch` 写入目标 Codex 配置的顶层 `model` / `model_provider`，并把 `OPENAI_API_KEY` 投影到 `auth.json`。
- `status` 汇总当前映射、认证投影和漂移状态。
- `doctor` 输出问题优先的诊断结果。

`--profile` 是受管 Codex `model_provider` id 的 CLI alias，不是旧 Codex 顶层 `profile` selector。

## Claude Code 工作流

```bash
aps add --claude opus --from-file ~/.claude/settings.json
aps add --claude copilot --from-file ~/.claude/settings-copilot.json
aps switch --claude copilot
aps current --claude
aps list --claude
aps show --claude copilot
aps show --claude copilot --reveal
```

- `add --claude` 导入完整的 Claude Code `settings.json` 为一个命名配置。存在 `claudeDefaults` 块时只保存与它不同的条目，`--full` 则保留全部条目。
- `switch --claude` 原子替换 `~/.claude/settings.json` 为存储的配置；如果有共享默认设置，则叠加在其上。
- `current --claude` 检测当前活跃的 Claude 配置。
- `list --claude` 显示所有 Claude 配置及活跃标记。
- `show --claude` 显示单个配置解析后的结果，标出哪些条目来自共享默认设置，secret 类 env 值被掩码，原始 `settings` blob 不返回。

没有 `claudeDefaults` 块时，Claude provider 存储完整的 `settings.json` 内容（env 变量、模型映射、权限、插件），切换时替换整个文件。设置高度重叠的 provider 更适合存成差异，见下一节。

### 共享 Claude 默认设置

各 provider 的设置往往几乎完全重叠：同样的十几个 env 开关、同样的主题，常常还有同样的权限块。把公共部分放进工具配置，每个 provider 记录只保留自己独有的内容。

`~/.config/agent-provider-switch/agent-provider-switch.json` —— 保留已有的 `version` 字段，手工加入这个块；没有任何命令会创建它：

```json
{
  "version": "1.1.0",
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

`show --claude` 会掩码所有 key 名看起来像凭据的 env 值（`*_TOKEN`、`*_API_KEY`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL`，以及任何包含 `auth` 的 key），human 输出和 `--json` 输出都是如此。`ANTHROPIC_BASE_URL` 这类非 secret 的邻居字段照常显示。

`--reveal` 是全局 flag，用于打印真实值并附带 `settings` blob。它是显式的逃生口，不会被默认应用：

```bash
aps show --claude copilot --reveal
```

工具写入的文件在 **macOS 和 Linux** 上使用仅属主可读权限（文件 `0600`，工具自己创建的目录 `0700`）。Windows 上跳过权限收紧 —— NTFS 没有供 `chmod` 设置的 group/other 位，访问由 ACL 决定，本工具不触碰 ACL。

在 macOS 和 Linux 上，升级前写入的文件会保持原有权限，直到下一次写入触及它。要一次性全部修正：

```bash
# 仅 macOS / Linux —— 在 Windows 上是 no-op。
chmod -R go-rwx ~/.config/agent-provider-switch ~/.codex/config.toml ~/.codex/auth.json ~/.claude/settings.json
```

## 命令面

`1.1.0` 当前命令：

```text
aps init
aps migrate
aps list [--claude]
aps show <provider> [--claude] [--reveal]
aps current [--claude]
aps status
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
aps backups list
aps backups prune [--keep N]
aps unlock [--force]
aps rollback [backup-id]
aps doctor
aps setup
```

`setup` 已废弃，只保留为指向 `init` 或 `migrate` 的兼容入口。

所有命令都接受 `--json` 标准 JSON envelope（以解析器支持为限），以及用于指定目标 Codex 目录的 `--codex-dir <path>`。`--codex-dir` 必须跟路径：紧随其后以 `-` 开头的 token 会被拒绝，而不是被当作路径。

## Runtime 投影

Codex `0.134.0+` 的活动路由由 `config.toml` 顶层 `model` 和 `model_provider` 决定。

受管 provider 的投影形态：

```toml
model = "gpt-5"
model_provider = "packycode"

[model_providers.packycode]
name = "packycode"
base_url = "https://api.example/v1"
wire_api = "responses"
requires_openai_auth = true
```

`agent-provider-switch` 默认不为新受管 provider 写入旧 `[profiles.*]`。`--create-profile` 是显式开关，用于额外写入对应的 `[profiles.<id>]` 段，供仍通过该段路由的旧 Codex 版本使用；写入受管投影时它会清理旧 `env_key` / `env_key_instructions` 字段。

认证会投影到目标 Codex `auth.json`，使用 API-key 模式和 `OPENAI_API_KEY`。不要提交真实 API key、`auth.json` 或私有 provider 导出。

## 状态位置

工具 home：

```text
~/.config/agent-provider-switch/
  agent-provider-switch.json
  providers.json
  claude-providers.json
  backups/
  .aps.lock
```

目标 Codex 目录：

```text
~/.codex/
  config.toml
  auth.json
```

目标 Claude Code 目录：

```text
~/.claude/
  settings.json
```

环境变量：

- `APS_HOME` 覆盖 `agent-provider-switch` 工具 home。
- `APS_CODEX_DIR` 在未传 `--codex-dir` 时提供默认目标 Codex 目录。
- `APS_CLAUDE_DIR` 覆盖 Claude Code 目录（默认：`~/.claude`）。
- 开发环境下，`NODE_ENV=development` 且没有显式覆盖时默认使用 `./dev-codex/local-sandbox`。

## 迁移与采用

只有当你已经有 Codex 配置，并希望把它 adopt 到受管 `providers.json` 时才使用 `migrate`。新安装默认使用 `init`。

```bash
aps migrate
aps migrate --overwrite --codex-dir ~/.codex
```

## 锁与备份保留

每个写入命令都会获取同一把锁（两个目标共用），并先把要改动的文件快照到 `backups/`。

写入过程中被 kill 的进程会把锁留下。`aps unlock` 可以清除它，但只会在确认记录的持有者确实已消失之后才清除 —— 持有者仍存活时会被拒绝，因为从运行中的进程手里抢锁会破坏状态，而拒绝只是带来不便：

```bash
aps unlock
aps unlock --force   # 用于你确认已被复用的 pid
```

这里没有基于超时的接管：慢速 `migrate` 可以超过任何计时器，所以看起来存活的 pid 一律按存活处理。`--force` 是针对"它其实不是原持有者"这一情况的显式覆盖。

备份默认保留最新的 20 个。每次成功变更后都会自动执行保留策略，`backups prune` 是手动入口：

```bash
aps backups prune
aps backups prune --keep 5
```

任何仍被幸存 manifest 引用的目录都不会被删除，因此即使创建它的备份本身很旧，回滚路径依然完整。manifest 缺失或不可读的目录只会被报告，不会被删除。Codex 和 Claude 共用同一个 `backups/` 目录和同一个 `latest.json`。

## 当前非目标

`1.1.0` 不实现也不预留以下 runtime 代码路径：

- 创建或编辑 `claudeDefaults` 块的命令。它需要手工编写；块不存在时 `config compact` 会拒绝执行，而不是去猜哪些键是公共的。
- Claude provider 记录的导出与导入。这两个命令只支持 Codex。
- GitHub Copilot SDK 集成。
- GitHub device-flow 登录。
- HTTP proxy bridge 或本地 bridge worker 命令。
- 后台 runtime service、bridge log 或 bridge runtime state。
- 内置第三方 router 封装。
- 账号系统或云同步。
- Claude Code 插件市场管理。
- 泛化的 "target" 抽象或可插拔 provider 类型系统。
- 基于 TTL 的锁接管。慢速 `migrate` 可以超过任何计时器，因此被复用的 pid 一律 fail-closed，出口是 `aps unlock --force`。
- 锁接管的审计日志；接管结果通过现有的结果 payload 报告。
- 退出码分类体系。成功为 `0`，失败为 `1`；没有用于用法错误的 `2`，也没有 code map。
- 删除死代码树。`src/infra/` 和死掉的 `src/cli/` shim 属于 Phase 3（`P2-1`）。
- 修改 `engines.node`。它仍声明 `>=18`，而唯一的运行时依赖要求 `>=20.12`，且 CI 不测试 Node 18 —— CI 全绿不能被理解为"声明的最低版本已受支持"。

## 开发

```bash
npm run build
npx tsc --noEmit
npm test          # 进程内测试套件；静默即通过
npm run test:e2e  # 真实子进程 + 沙箱根目录；打印 passed/failed/skipped
node dist/cli.js --help
node dist/cli.js --version
npm pack --dry-run
```

`npm test` 通过唯一的进程内 harness 运行所有 `tests/*.spec.js`，通过时不打印任何内容。`npm run test:e2e` 先构建 CLI，再把真实二进制作为子进程驱动，`APS_HOME`、`APS_CODEX_DIR`、`APS_CLAUDE_DIR` 全部指向运行器拒绝离开的沙箱。它是独立命令、也是独立的 CI 步骤：每个用例都要付一次进程启动成本，而它覆盖的是进程内套件在结构上无法覆盖的部分 —— 退出码、真实管道、环境隔离。

## 当前事实源

- [PRD 1.1.0](./docs/PRD/agent-provider-switch-prd-v1.1.0.md)
- [Design 1.1.0](./docs/Design/agent-provider-switch-v1.1.0-design.md)
- [PRD 1.0.0](./docs/PRD/agent-provider-switch-prd-v1.0.0.md)
- [Design 1.0.0](./docs/Design/agent-provider-switch-v1.0.0-design.md)
- [PRD 0.4.1](./docs/PRD/agent-provider-switch-prd-v0.4.1.md)
- [Design 0.4.1](./docs/Design/agent-provider-switch-v0.4.1-design.md)
- [PRD 0.4.0](./docs/PRD/agent-provider-switch-prd-v0.4.0.md)
- [Design 0.4.0](./docs/Design/agent-provider-switch-v0.4.0-design.md)
- [PRD 0.3.1](./docs/PRD/agent-provider-switch-prd-v0.3.1.md)
- [Design 0.3.1](./docs/Design/agent-provider-switch-v0.3.1-design.md)
- [PRD 0.3.0](./docs/PRD/agent-provider-switch-prd-v0.3.0.md)
- [Design 0.3.0](./docs/Design/agent-provider-switch-v0.3.0-design.md)
- [PRD 0.2.1](./docs/PRD/agent-provider-switch-prd-v0.2.1.md)
- [Design 0.2.1](./docs/Design/agent-provider-switch-v0.2.1-design.md)
- [CLI usage](./docs/cli-usage.md)

旧 `0.1.x` / `0.2.x` 文档保留为历史记录。
