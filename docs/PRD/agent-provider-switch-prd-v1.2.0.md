# agent-provider-switch v1.2.0 PRD

## 1. 概述与状态

`1.2.0` 将 Codex 和 Claude Code 的重复 provider 流程重构为公共工作流，通过 target descriptor（目标描述符）选择目标适配器，并新增 `--target <id>` 作为统一选择入口。`--codex`、`--claude` 保留为等价别名。

本版本的主要成果是减少重复实现，让目标差异集中在适配器中；用户仍按现有方式管理两种工具的 provider。统一的是执行流程，两种工具各自的 native 配置、记录格式和正常操作语义继续保留。

- 状态：**已实现并于 2026-10-14 随 `1.2.0` 发布**。
- 前置版本与行为基线：`1.1.3` 实现，源码审查基线 `1da0a60`。
- 使用场景：作者个人使用的 CLI；本轮保留当前行为是范围选择，不是对外兼容承诺。
- 本文与 Technical Design 描述的就是 `1.2.0` 已发布的行为；发布后不再保留计划态表述。

依据：[已确认全局审查](../Reviews/agent-provider-switch-1.2.0-prd-review.md)、[1.x roadmap](../agent-provider-switch-1.x-roadmap.md#4-120--the-target-descriptor)、[ADR-0001](../adr/0001-share-provider-workflows-through-target-adapters.md)。实现方案见 [v1.2.0 Technical Design](../Design/agent-provider-switch-v1.2.0-design.md)，术语使用 [Glossary](../../GLOSSARY.md)。

[1.1.x 个人使用验收](../Reviews/agent-provider-switch-1.1.x-implementation-verification.md) 继续有效。该记录中已接受、暂缓处理的差异不自动成为本版本的修复要求；旧 PRD 中比实际验收更严格的边界也不自动重新成为完成条件。

## 2. 问题、目标与范围

当前 target id、命令 scope 和 mutation target 已存在，但六个 provider 动词仍有两套完整编排。目标差异还散落在 dispatch、交互选择、doctor/status 聚合、输出和备份文件归属中。仅给原 handler 加一个 descriptor 包装无法减少这些重复。

本版本包含三个目标：

1. `add/list/show/current/switch/remove` 各保留一套公共工作流，registry 读写与公共步骤由公共层负责，native 差异由目标适配器提供。
2. selector 统一解析，`--target <id>` 与旧别名等价，命令 scope、目标能力和 flag 适用性使用同一组声明。
3. 公共选择与确认使用现有可注入 prompt runtime；doctor/status 和备份列表使用目标声明编排，不再维护独立的目标分支。

本轮保留 `providers.json`、`claude-providers.json` 及其格式；不迁移 provider 数据，不新增第三个生产目标，不增加 Claude edit/import/export，不建设插件发现机制，不统一两种 native 配置 schema，也不要求穷举损坏配置与异常恢复场景。

## 3. FR-01：公共工作流与目标职责

每个公共动词必须让两个目标经过同一套业务编排。公共实现可以按现有层次拆成多个小模块，文件数量不作为验收依据。

| 动词 | 公共层负责 | 适配器提供的差异 |
|---|---|---|
| `add` | 名称与 metadata、查重、registry 更新、事务编排 | 输入字段、记录构造与校验、defaults/delta、附带配置准备 |
| `list` | 读取集合、遍历记录、组合结果 | effective view、active matching、摘要与目标结果字段 |
| `show` | 按名称查记录、调用目标视图 | 目标详情、JSON 字段、脱敏和 reveal 策略 |
| `current` | 获取目标 live state、读取所需记录、调用匹配与结果策略 | 未激活状态、身份候选及当前状态字段 |
| `switch` | 查记录、解析 effective view、执行变更计划 | native 配置投影、操作前置条件和受影响文件 |
| `remove` | 查记录、选择与确认、删除记录、执行变更计划 | 活动路由保护、替换策略及附带配置写入 |

公共层拥有 registry 文件的集合读写和 provider lookup。codec 负责目标记录的合法性、清理和序列化规则；effective settings、matching 和 projection 属于目标规则。codec 不负责文件 I/O。

适配器的操作钩子只能提供目标规则和 native 变更，不能继续拥有整条命令流程、自己的 registry 集合读写、公共选择器或独立事务包装。把旧两套完整 handler 改名再注册不满足 FR-01。

## 4. FR-02：统一目标选择

支持的目标 id 为 `codex`、`claude`，按该顺序展示。id 精确匹配，不增加隐含别名。

| 输入 | 规范化结果 |
|---|---|
| 无 selector | 未显式选择；由命令策略决定默认范围 |
| `--target codex` 或 `--codex` | 显式选择 Codex |
| `--target claude` 或 `--claude` | 显式选择 Claude |
| 同目标重复，例如 `--claude --target claude --target claude` | 归并为一次显式 Claude 选择 |
| 不同目标，例如 `--codex --target claude` | `INVALID_ARGUMENT`，不采用优先级或 last-wins |
| `--target` 缺值、下一 token 是 flag、未知 id | `INVALID_ARGUMENT` |

`--target <id>` 必须在命令识别前与旧别名一起处理，在命令 token 前后位置等价，不吞掉 provider 名称。`--target=claude`、多目标值列表与 `--all` 不属于本轮新增语法。

解析完成后，guard、dispatch、compact、report filtering 和交互都使用同一规范化选择，不能靠原始 `--claude` 是否存在判断行为。无 selector 与显式选择默认目标仍需可区分，用于 compact 的必需选择检查和 Shared 命令的拒绝。

必须支持：

```text
aps --target claude list
aps list --target claude
aps add p --target claude --from-file settings.json --full
aps config compact --target claude --dry-run
aps doctor --target claude --json
```

## 5. FR-03：命令范围、能力与 flag

命令 scope 定义选择方式、默认范围和是否要求显式选择；target capability 定义该目标支持的操作。guard、dispatch、help 和报告选择共同消费声明，不各自维护支持名单。

沿用当前 21 条命令的范围：

| 范围 | 命令 | 裸调用 | 显式 Codex | 显式 Claude |
|---|---|---|---|---|
| Switchable | `add`, `list`, `show`, `current`, `switch`, `remove` | Codex | 接受 | 接受 |
| Codex only | `init`, `migrate`, `setup`, `edit`, `import`, `export`, `config show`, `config list-profiles` | Codex | 接受 | 拒绝 |
| Claude only | `config compact` | 拒绝，需显式选择 | 拒绝 | 接受 |
| Both | `doctor`, `status`, `backups list` | 两目标 | 收窄为 Codex | 收窄为 Claude |
| Shared | `backups prune`, `rollback`, `unlock` | 共享操作 | 拒绝 | 拒绝 |

表中“接受”描述范围合法性；例如 `setup` 仍返回现有 deprecated 错误，不恢复其旧功能。Shared 命令拒绝所有 selector，包括显式选择默认目标。

- `--full` 仅适用于 Claude `add`，任一等价 Claude selector 均满足条件。
- `--dry-run` 仅适用于 Claude `config compact`，不能被 prune 或其他写操作忽略。
- Both 命令收窄到 Claude 时拒绝显式 `--codex-dir`；`--target claude` 和 `--claude` 相同。
- 沿用其他已有目录参数规则，包括 Switchable 命令选择 Claude 时已接受但不使用 `--codex-dir` 的行为；本轮不扩大拒绝范围。
- 未在本轮明确调整的选项行为沿用基线，不顺带进行通用 parser 重写。

selector 冲突、scope/capability 不支持、compact 缺少显式选择以及上述 flag 拒绝，在迁移与配置 I/O 前完成。compact 的检查位置随统一 scope 解析前移，是该调用链重构的直接要求，不据此扩展整个 1.1.x 暂缓清单。

## 6. FR-04：保留两目标的正常行为

| 操作 | Codex | Claude Code |
|---|---|---|
| `add` | 保存 flat record，并准备 TOML model provider；保留 model/base URL 继承与 `--create-profile` 语义 | 从 settings 文件或交互构造记录；有 defaults 时默认保存 delta，`--full` 保留输入项 |
| `switch` | 投影 TOML 当前 route 和 auth | 将 effective settings 整体写到 `settings.json` |
| `remove` | 删除唯一活动路由需 `--switch-to`；保留现有 TOML 变更与返回字段 | 只删除 registry 记录，不清理或替换 live settings |
| `list/current` | 保留 model_provider 路由与唯一 provider 的识别规则 | 对 effective settings 使用现有身份匹配；歧义时不选第一个候选 |
| 缺少 registry 或 live 文件 | 按各动词现有 required/empty/no-settings 行为处理 | 同左；不能用公共 repo 的单一默认值抹平差异 |

provider name 在目标内唯一，两个 registry 可以各自保存名为 `p` 的记录。指定 Claude 操作 `p` 不读取或覆盖 Codex 的 `p`。

Claude defaults 的存储位置与 merge/diff/compact 规则继续保留：

- registry 中的 stored settings 与 effective settings 分开；公共 repo 只写原始记录。
- 普通读取、切换或删除另一条记录，不能把 defaults 展开到其他记录后写回。
- `--full` 保留输入项，但未写出的项仍可继承 defaults，不表示禁用继承。
- 保留现有对象合并、数组替换、defaults 下删除标记及无 defaults 时的普通 `null` 规则；本轮不重写这些领域算法。

Codex TOML patching、auth projection 与目标专属前置条件继续使用现有规则。公共层不能改成把所有目标当作整文件 JSON 替换。

## 7. FR-05：统一交互

两目标的公共名称选择、列表选择、取消与删除确认使用同一个 `CliPromptRuntime`，不在目标 handler 内直接调用 inquirer。目标输入适配器可以保留各自的字段、提示语和 choice label。

- TTY 且非 `--json` 时，沿用各命令现有可交互的入口和确认规则。
- 非 TTY 或 `--json` 时不触发 prompt；缺少必需信息返回现有类型错误。
- 显式 provider 名称与交互选出的名称进入同一公共 workflow。
- active/candidate 标记来自目标 matching；Claude 歧义候选不能都显示为唯一 active。
- 交互取消不写 registry/native 配置，也不启动 mutation。

统一公共组件不增加原来没有的交互入口，也不要求两目标拥有相同输入字段。

## 8. FR-06：共享路径、存储与事务

保留一份 `APS_HOME`、`.aps.lock`、backups 目录、latest 指针与 retention。`APS_CODEX_DIR` 和 `APS_CLAUDE_DIR` 是目标运行时根目录，不是两个 tool home。

目标目录解析使用各自现有策略。非报告 Codex 命令继续采用显式目录、环境变量、共享配置、既有 discovery/default 的顺序；报告路径沿用已验收的实际策略，默认路径报告差异 F03 仍按原记录暂缓。选中的 Claude 命令不依赖 Codex 路径或其 live 配置可用。

两个 registry 保持原路径、root shape、字段和排序规则；共享配置中的 `defaultCodexDir`、`claudeDefaults` 不迁移到新格式。`target` 是执行选择和描述符属性，本轮不要求在每条 stored record 内新增 target。

每次受管理写操作由公共层调用现有 `runMutation()` 一次：

1. 先完成交互与输入准备，声明实际受影响文件。
2. 获取共享锁并备份这些文件，执行 registry/native 变更。
3. 成功后记录 latest 并执行现有 retention；失败按现有规则自动恢复。

适配器不另建锁，不嵌套 `runMutation()`。保留现有同步 mutation 回调；不在持锁期间等待用户输入。switch 不因公共化而额外写 registry，Claude remove 不因公共化而额外写 settings。

这项要求针对受管理配置与 provider 写入。export 的外部文件原子写入、rollback/prune 自己的共享锁流程及现有工具目录迁移各保留原职责，不能误包进新的双层事务。

## 9. FR-07：描述符驱动的报告与备份

doctor/status 遍历所选 target 的报告适配器；共享工具配置 inspection 与共享锁检查各编排一次，目标适配器提供目标读取与额外诊断。保留当前 Reading、issues、notes、complete、healthy、目标 section 及部分结果字段。

- 裸调用按 Codex、Claude 顺序组合；显式 selector 只收集对应目标 section。
- out-of-scope 目标不读取 registry/native 配置，不运行 runtime probe，不贡献问题或 notes。
- Codex CLI probe 保留现有适用/激活条件；Claude-only 诊断不运行 Codex probe。
- 只加载共享配置需要的部分；严格执行读取与报告 inspection 的现有区别不能被统一读取接口抹平。
- 只迁移现有检查的归属与编排，已暂缓的更严格校验和报告边界不作为本轮新增诊断要求。

backups list 使用声明的 artifacts/roots 识别归属，并保留历史 manifest 读取及现有分类规则。来源与恢复影响仍是两个概念：

| 概念 | 依据与用途 |
|---|---|
| envelope scope | 当前命令接受的目标范围 |
| backup origin | manifest 的目标元数据，或集中保留的历史 reason/path 判断；供列表标记与筛选 |
| restore impact | 实际恢复的文件及所属目标；供 rollback 结果报告 |

新受管理写入仍记录显式 target；不重写已有 manifest。列表 target 继续使用 `codex/claude/mixed/unknown`，筛选仍按 origin：mixed 被任一单目标筛选包含，unknown 只在未筛选列表中包含。

归属元数据不能变成恢复授权。rollback 的 allowlist 仍由当前运行环境构造，不能把 manifest 中的历史目录直接加入可信 roots；rollback 仍恢复整份 manifest，拒绝 selector。本轮不增加分目标 rollback 或 retention。

## 10. FR-08：输出与 JSON 契约

保留现有 envelope 的字段及含义，`targets` 为权威范围，`target` 仅在范围为一个目标时等于该 id。

| 情况 | `targets` | `target` |
|---|---|---|
| 单目标成功或范围接受后的执行失败 | 一个目标 id | 该 id |
| 裸 Both | `["codex", "claude"]` | `null` |
| Shared | `[]` | `null` |
| 解析/未知命令/selector 或范围拒绝 | `[]` | `null` |

不增加 `data.target` 作为路由字段，不把两目标已有 payload 强行改成同一形状。rollback 的 `data.targets` 仍表示 restore impact，不等同于 envelope scope。

目标 presenter 负责目标字段与文本展示，公共 renderer 负责 envelope、共享信息和组合。展示策略必须保留以下差异：

| `show` | 人类可读输出 | JSON |
|---|---|---|
| Codex | apiKey 脱敏；沿用现有 reveal 行为 | 保留完整 apiKey 的现有自动化契约 |
| Claude 默认 | env 秘密脱敏，不展示完整 settings | 同样脱敏，不含 settings/overrides blob |
| Claude `--reveal` | 展示 effective settings 和原始 overrides | 返回现有 `revealed/settings/overrides/inherited` 语义 |

不能由一个 `secretPath` 推导所有目标展示策略。匹配与差异报告继续只输出候选名称和差异路径，不输出比较到的 secret 值。输出函数保持纯函数并沿用现有流和 exit code 约定。

## 11. FR-09：扩展与维护边界

新增目标时允许增加目标声明、codec、适配器、能力、输入/展示、必要静态类型与注册和测试，不允许复制六个公共流程，或在公共选择、执行、报告组合与展示 dispatch 中新增目标名称分支。

设计应保持 `commands/app/domain/storage/interaction/runtime` 分层，domain 不引入 I/O，help/version 和早期错误路径不因 descriptor 引入目标服务或 prompt 的提前加载。不往未使用的 infra 或旧 cli 模块新增实现。

本轮只以现有两目标验证边界，不要求临时制造第三个目标。“新增目标只需一个文件”不作为承诺。清理旧模块前需核查真实调用者，保留仍被使用的测试注入接口。

## 12. 验收与交付

行为断言与结构审查共同决定完成；测试路径、模块接线与版本断言可以随重构调整，不能以“全部旧 spec 原样通过”代替验收。

| 编号 | 覆盖需求 | 验收证据 |
|---|---|---|
| A01 | FR-01、FR-09 | 两目标六个动词调用公共 workflow；适配器不包含公共 registry/选择/事务编排；扩展审查无中央目标分支 |
| A02 | FR-02 | prefix/suffix、旧别名等价、同目标重复、不同目标冲突、缺值/未知值；第 4 节五条调用可执行 |
| A03 | FR-03、FR-08 | 21 命令 scope 表测试；full/dry-run/目录适用性；接受前后失败 envelope；拒绝前不执行迁移/配置 I/O |
| A04 | FR-04、FR-06 | Codex add/switch/remove 文件效果、Claude add/switch/remove 文件效果、两目标同名记录隔离 |
| A05 | FR-04、FR-06 | defaults 下 delta、full、无 defaults 的 null、remove 后 survivor 未展开；保留现有格式和语义断言 |
| A06 | FR-05 | 同一 fake prompt runtime 驱动两个目标的已有交互入口；非 TTY/JSON 不提示，取消无 mutation |
| A07 | FR-06 | 一次锁与 backup，受影响文件准确，失败恢复原文件/原缺失状态；没有嵌套 mutation |
| A08 | FR-07 | 两目标/收窄 reports、未选目标无读/probe、共享检查一次、existing partial-report 行为；新旧备份来源筛选与 rollback impact 保留 |
| A09 | FR-08 | JSON 字段/含义和三个 show 策略回归；renderer 的 stdout/stderr/exit 行为保持 |
| A10 | FR-09 | help/version 不加载目标执行服务，当前有调用者的注入接口保留；三项仓库检查通过 |

实施交付物包含公共工作流、两个目标适配器、selector/能力声明、统一交互与报告/备份接线、相应回归测试及更新的 usage/help/架构文档。实现与正式发布时再按 [CLAUDE.md](../../CLAUDE.md) 同步 package/lock 版本、CHANGELOG 和 release 文档；编写本 PRD 不提前改版本。

完成前使用 Node 20 或 22 执行 `npx tsc --noEmit`、`npm test`、`npm run test:e2e`。后两项会重建 dist，顺序执行；测试隔离 `APS_HOME`、`APS_CODEX_DIR`、`APS_CLAUDE_DIR`。已暂缓的 1.1.x 记录继续独立保留，不要求新增防御性穷举用例。
