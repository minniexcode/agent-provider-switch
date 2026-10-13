# 1.1.x PRD 审查记录

审查范围：1.1.0、1.1.1、1.1.2、1.1.3 的 PRD、对应 Design、审查时工作区中的实现与相关测试。本记录区分历史事实快照、已接受原则和最终规则。用户已回复“全部按建议，确认最终规则”，D0-D8 与 Q9-Q16 全部接受，无待确认分支。工作区仍有其他进行中的修改，历史事实快照不作为当前实现已完成的证明。

已确认的前提：CLI 目前由作者个人使用，尚未对外上线。作者明确接受破坏性更新，无需为了外部消费者保留过渡字段或旧错误码。

## 首轮查证的问题（历史快照；下述建议已写回文档）

### 1.1.0：数组内部的 null 是合并规则的例外

PRD 的 Merge Rule 和验收第 2 条宣称合并结果没有 null 对象成员，但数组整体替换，其内部对象不参与递归合并。例如 `{ items: [{ value: null }] }` 会保留数组内的 null。

建议澄清：参与对象合并的 null 成员是删除标记；数组及其内容是原样数据。无共享 defaults 时，整个 stored settings 也保留原样 null。无需改变既有数组规则。

证据：`src/domain/claude-settings-merge.ts` 的 `applyLayer()`；`tests/claude-settings-merge.spec.js` 的 null 检查明确跳过数组。

### 1.1.1：shared 命令被错误描述为 Codex 命令

Behaviour By Command 给 `backups prune`、`rollback`、`unlock` 标注 `target: "codex"`。它们操作共享状态，rollback 可以恢复 Claude 文件。1.1.3 的 scope 表已将其定义为 shared。

该字段的语义需要随决策 D1 统一。1.1.1 Release Mechanics 还提前声称 `status --claude` 回答 Claude 状态，而本版 Non-Goals 明确该能力属于 1.1.3。

### 1.1.2：init/import 的错误生产者与验收不成立

PRD 的 rename map 和验收第 3 条把 `PROVIDERS_ALREADY_EXISTS` 归于重复 init/import。实际 init 幂等成功；import 默认替换 registry，或按显式选择合并。真实拒绝案例是对已有非空 registry 执行 migrate，却未选择 merge/overwrite。

建议用真实的 migrate 拒绝案例替换验收。Design 的 Enforcement 已纠正此事实，但前面的 producer 说明和 PRD 未同步。

证据：`src/app/init-codex.ts`、`src/app/import-providers.ts`、`src/commands/handlers.ts` 的 migrate 分支、`src/app/setup-codex.ts`。

### 1.1.2：list/current 的空 registry 行为被写成失败

Behaviour By Command 和验收第 4 条要求 `list --claude` 缺少 registry 时报 `PROVIDERS_NOT_FOUND`。实际 list 返回空列表成功，相关错误词汇测试明确断言这一行为。current 同样允许缺少 registry，分别报告 no-settings 或 unmanaged。

建议保留已有行为，修正文档的命令错误矩阵；registry-not-found 验收应使用真正要求 registry 存在的命令。

证据：`src/app/claude-list-providers.ts`、`src/app/claude-current.ts`、`tests/error-vocabulary.spec.js`。

### 1.1.2：CLAUDE 字符串的禁用范围过大

验收第 1 条的 `/CLAUDE_[A-Z_]+/` 会命中合法的环境变量、标识符和诊断 issue code。需要禁止的是被替换的旧 ErrorCode 及其错误生产者，不是所有含 Claude 的字符串。

当前测试已经区分 error 和 issue，但 Design 的部分文字仍声称没有例外，其结尾还重复了已被正文否定的 producer 清单。

### 1.1.2：错误码统计错误，同类条件统一尚未完成

按 rename map，应移除五个旧 union 成员、增加一个新成员，净减少四个；PRD 的“gains none”和 Design 的“净减少三个”均不准确。

Claude provider 重名返回 `PROVIDER_ALREADY_EXISTS`，Codex provider 重名仍返回 `INVALID_IMPORT_FILE`。是否将全量对称条件纳入统一，见决策 D8。

证据：`src/app/claude-add-provider.ts`、`src/app/add-provider.ts`。

### 1.1.3：未配置目标的规则与验收矛盾

doctor 正文规定未配置目标贡献零 issue；验收第 2 条却要求同一台 Claude-only 机器显式选择 Codex 后报告 Codex issues。当前代码没有显式选择改变检查规则的逻辑。

此外，registry 或 runtime directory 存在只能证明有配置痕迹，不能证明曾使用 APS，更不能证明配置完整可用。启发式可以保留，但术语和解释必须准确。见决策 D2。

### 1.1.3：合法删除与冗余删除被误报

1.1.0 已规定 defaults 存在时 null 删除，不存在的键被删除是 no-op；无 defaults 时 null 保留原样。

当前 record 检查直接验证 raw env/model，合法 `{ env: null, model: null }` 即使解析成有效配置，也会得到 `INVALID_CONFIG`。无 defaults 时普通 null 也可能被当作 orphaned deletion。PRD 关于“用户以为此键会被设置”的解释与删除意图不符。见决策 D3。

证据：`src/domain/claude-providers.ts` 的 `collectClaudeRecordIssues()`；`src/domain/claude-settings-merge.ts` 的 `collectOrphanedDeletions()`；现有 defaults 和 merge 测试。

### 1.1.3：healthy 的共享状态规则缺失

PRD 声称 healthy 只覆盖 selected targets；Design 和实现却将共享锁问题算入 healthy，任何 narrowing 下都检查一次。需要明确健康与未托管、正常忙碌、异常锁之间的关系。见决策 D4、D5。

证据：`src/app/run-doctor.ts` 的 issue composition 和 `collectLockIssues()`；`tests/doctor-targets.spec.js`。

### 1.1.3：live settings 的损坏与未托管没有区分

当前 reader 将缺失、读取失败和非法 JSON 都返回为 null，合法 JSON 的顶层形状也未验证。诊断可以把损坏文件归为 unmanaged；顶层数组甚至可能与空 provider 匹配并报告健康。

需要补充未配置、缺失、读失败、解析/形状无效、合法但未托管、合法且匹配的诊断矩阵。内容验证应先于 provider 匹配。其健康含义取决于 D4，其失败边界取决于 D6。

证据：`src/storage/claude-providers-repo.ts` 的 `readClaudeSettings()`；`src/app/get-claude-status.ts`；`src/app/run-doctor.ts`。

### 1.1.3：局部诊断失败的边界没有完整定义

Claude/Codex registry 错误已有局部 catch；Codex config 读取和公共 tool config/defaults 的错误仍可能在完成其他目标检查之前终止诊断。PRD 没有规定哪些问题应成为 issue，哪些问题可以让整条命令失败。见决策 D6。

Design 还说未配置目标不跑 checks，但当前 Codex collector 仍执行 CLI probe，只是 suppress issue；Claude narrowing 确实跳过 Codex probe。需要同步这一行为。

### 1.1.3：provider 身份与完整配置一致性混用

当前 Claude 匹配只比较 model、base URL 和三个 model 映射；不会比较凭据、权限、插件或其他 settings。多条 provider 可以同时 active，但汇总字段按排序取第一条。

PRD 的“live settings match”没有说明指身份匹配还是完整配置一致。需要明确多匹配如何报告，避免虚假的唯一 provider 名称。见决策 D7。

证据：`src/domain/claude-providers.ts` 的 `claudeSettingsMatch()`；`src/app/get-claude-status.ts` 的 activeProvider 汇总。

### 1.1.3：backup 操作归属与恢复影响范围冲突

PRD 要求 rollback 从恢复路径报告实际影响目标；Design、实现及测试优先采用 manifest.target，然后 reason，最后才看路径。元数据与恢复路径冲突时，报告的是操作归属，而不是实际恢复影响。见决策 D1。

普通不重叠 runtime 根的混合路径已能分类为 mixed，不再属于未实现的能力。Design 的“first match wins”和路径阶段累积 set 仍需改成一致的算法描述。

后续必须明确：mixed 如何参与 narrowed list；具体 tool-home artifact 是否按已知归属分类；runtime 根重叠、根改变后的旧备份怎样处理。这些依赖 D1，不在首轮先行决定。

### 1.1.3：新增的 manifest target 缺少运行时校验

`validateBackupManifest()` 没有校验已成为已知字段的 target。`target: "bogus"` 可以通过校验并进入输出，突破承诺的 label 枚举。透传未知字段不代表已知字段无需校验。

合法值必须校验；损坏 manifest 是略过并警告还是降级 unknown，在 D1 之后决定。

### 1.1.3：失败 envelope 的范围规则与版本统计不准确

command 已识别但 flags 被拒绝时，当前 envelope 仍是 targets=[]、target=null；进入 handler 后失败则保留已解析范围。Design 仅说 no command resolved 时为空，没有完整描述这些情况。

默认双目标命令与 shared 命令共六个，其 target 从 Codex 变为 null，Design 的“三个”遗漏 shared 命令。新增可选 manifest target 也属于存储字段增加，不能再声称没有 stored shape changes。

CHANGELOG 已明确列 Breaking。PRD/Design 应同步这项已接受的发布前提，不必再次设计兼容窗口。

## 决策树与已接受的首轮原则

D0 已确定：单人、未对外上线，接受 breaking。用户已明确回复“全部按建议”，接受以下 D1-D8；后续只讨论它们派生的边界，不再重复询问这些原则。

| 决策 | 已接受原则 | 依赖它的后续决定 |
|---|---|---|
| D1：范围术语 | 区分命令范围、备份操作归属、恢复影响范围；rollback 报实际影响 | backup 分类规则、mixed 过滤、未知/冲突 metadata、重叠根、失败 envelope |
| D2：未配置目标 | 有配置痕迹与健康分开；显式选择仍不让未配置目标自动产生问题 | 识别配置痕迹的证据、对外状态名称 |
| D3：删除标记 | 合法删除不报错；冗余删除不降低健康 | 是否保留整理提示、effective 类型检查边界 |
| D4：未托管状态 | 合法但未托管是一种状态，不单独造成不健康 | unmatched/ambiguous/drift 的输出与诊断等级 |
| D5：共享锁 | 所有 doctor 范围都检查共享锁；异常锁降低健康，正常占锁只表示忙碌 | lock 状态字段、healthy 聚合规则 |
| D6：局部损坏 | doctor 尽量收集独立结果，单个目标内容问题不阻断其他目标 | 公共配置错误、读取失败和无法继续检查的边界；status 的策略 |
| D7：身份与一致性 | 区分 provider 身份匹配和完整配置一致；多匹配不任选第一条 | 身份匹配字段、歧义表示、drift 范围 |
| D8：错误词汇范围 | 两个目标的同类失败统一，包括 provider 重名 | 对称条件审计、验收矩阵 |

## 第二轮复核：工作区已发生的修正

以下是首轮之后再次核对的事实，来自工作区中其他进行中的改动，并非本次审查修改的业务代码：

- Codex provider 重名已改为 `PROVIDER_ALREADY_EXISTS`，与 Claude 一致。原 PRD 的矩阵尚未同步。
- record 类型检查已针对 effective settings，合法 env/model 删除和无 defaults 的原样 null 不再误报；冗余删除改为 notes，不影响 healthy。
- live settings reader 已区分 absent、invalid、ok；非法 JSON、数组、标量不再参与 provider 匹配。工具依赖的字段类型仍需诊断。
- rollback 已调用新的 `targetsRestoredBy()`，与读取备份操作归属的 `classifyBackupTargets()` 分开。但当时实际影响仍只统计 runtime 路径，registry-only 恢复显示为空；最终按 Q10 纳入 registry 影响。
- 未托管状态和正常占锁目前仍影响 healthy；多匹配仍按排序取第一条。这些与已接受的 D4、D5、D7 存在差距，不再作为新产品问题重复询问。
- 错误码对称审计还发现：Codex 交互式选择面对空 provider 集合使用单数 `PROVIDER_NOT_FOUND`，Claude 使用复数 `PROVIDERS_NOT_FOUND`。应按 D8 统一为集合缺失/为空的复数条件，无需另行决定。

## 第二轮最终规则（全部已接受）

用户已确认以下 Q9-Q16，作为最终 PRD/Design 的规范。它们均以 D1-D8 为前提。

| 决策 | 已接受的最终规则 | 依赖的首轮原则 |
|---|---|---|
| Q9：配置痕迹与尚未激活 | registry 文件、实际 runtime 配置文件、目标 defaults 都是痕迹；只有空目录不是。没有 runtime 配置属于尚未激活；缺少/空 registry 属于未托管，均不单独构成故障。已有内容损坏仍报告问题 | D2、D4 |
| Q10：恢复影响的边界 | 目标 registry 恢复也计入对应目标。按已知 artifact 归属识别；其他路径累积所有可信根下的目标。区分仅共享状态与无法判断，保留当前允许恢复的根，不自动信任历史根 | D1 |
| Q11：备份列表过滤 | 列表按操作归属过滤；mixed 同时进入两个窄化列表，unknown 只在裸列表。新已知 metadata 必须校验；损坏 manifest 沿用列表略过并警告、显式恢复失败的策略 | D1 |
| Q12：身份比较依据 | Claude 的连接地址、现有模型路由字段和认证配置用于身份匹配，包括 token、API key、apiKeyHelper。只在内存比较敏感值；无 defaults 的普通 null 不自动等于缺失。不猜测归一化。所有查询命令采用相同身份规则 | D7 |
| Q13：完整配置一致性 | 对象键顺序不影响相等，数组顺序影响相等。漂移为 notes，不单独降低健康；多个身份候选逐一报告完整一致性，不暗中据此选定唯一 provider。仅显示差异路径，内容无效仍是故障 | D4、D7 |
| Q14：公共配置局部损坏 | doctor 将仅 Claude defaults 损坏归属 Claude，不阻断 Codex。整份公共 JSON 损坏报告共享问题，只继续不依赖其内容且可可靠确定路径的检查；依赖的结果 unavailable，不猜默认值 | D6 |
| Q15：status 的局部结果 | status 同样保留可读取的所选目标报告，局部数据明确 unavailable，不填零或空值冒充读取成功。获得报告的命令成功与配置是否健康分开；无法完成基本报告才顶层失败 | D6 |
| Q16：失败 envelope | targets 表示已接受的命令范围。非法 scope/conflict、无法解析命令、shared 命令均为空；合法范围在读文件前确定，之后执行失败保留该范围。不增加第二套请求字段 | D1 |

按最终规则，冗余删除保留已有 notes，合法未托管与正常忙碌是状态；无需再询问是否降低健康。unknown 和 unavailable 表示无法可靠得出结果，不能与真实空集合、未激活状态互换。

## 最终文档落地

已将规则写回 1.1.0～1.1.3 的四份 PRD 和四份 Design，并同步根目录
[术语表](../../GLOSSARY.md) 与 [1.x roadmap](../agent-provider-switch-1.x-roadmap.md) 的兼容性描述。

- 1.1.0：限定 null 删除规则只作用于参与合并的对象；数组内部与无 defaults 的 null 保留。
- 1.1.1：保留基础阶段职责，明确历史 Codex 路由标签不等于最终 scope 或 restore impact；
  目标范围拒绝与后续执行失败的 envelope 语义分开，先确定合法路由再做文件 I/O。
- 1.1.2：移除五个旧错误成员、新增一个，净减少四个；加入同类失败矩阵，保留空 registry
  的成功查询、init 幂等与 import 流程，采用真实 migrate 拒绝验收。
- 1.1.3：完整 scope 表、配置证据与健康矩阵、共享锁、局部结果与 unavailable、认证身份、
  多候选/逐候选一致性、origin 过滤、registry/重叠根恢复影响与 manifest 校验。
- 删除“1.1.2 是唯一 breaking release”等不准确承诺；六个 bare target 变化均声明为 breaking。
- 具体报告字段由 Design 给出；术语表只记录领域定义。未为了记录普通产品规则而新增 ADR。

报告的 healthy 在有故障时为 false，健康相关检查完整且无故障时为 true；未能取得必要
检查结果且无已知故障时为 null。这样不会把无法判断伪装成健康。该表示属于 unavailable
规则的具体设计。status 的健康仅覆盖它实际执行的汇总检查，不替代 doctor 的全部检查。

## 实现对齐清单

以下来自最后一次源码复核，是后续实现任务，不代表文档仍待决策，也不宣称本次修改了业务代码：

- doctor 将合法未托管与正常占锁从 issues 移至状态；配置证据不再采用目录存在判断。
- Claude 匹配纳入认证来源，多个候选不选第一条；所有查询统一身份与逐候选一致性。
- doctor/status 的公共配置局部读取、独立目标结果和 unavailable 表达需落实。
- scope 必须在公共配置读取和迁移前确定，后续失败保留已接受范围。
- rollback 纳入 registry-only 影响并累积重叠根；补充 shared/unknown 影响区别。
- backup origin 的 mixed 过滤及已知 target metadata 校验需与最终规则核对。
- Codex 空 provider 交互选择使用集合错误 `PROVIDERS_NOT_FOUND`。
- 测试需覆盖上述规则；现有套件通过不能证明新增验收已经实现。

## 验证范围

本次修改仅涉及规范、设计、术语和审查记录，不修改业务代码或真实目标配置。

- 11 份文档的相对链接、代码块闭合和空白检查通过，`git diff --check` 通过。
- 使用已有 Node 20.19.5，`npx tsc --noEmit` 与 `npm test`（含 build）通过。
- `npm run test:e2e` 首轮 33 项通过、8 项失败；8 项失败均显示 `dist/cli.js`
  缺失。进程检查同时观察到另一组 E2E 在同一工作区运行。
- 单独重跑受影响的 8 项，1 项通过、7 项失败；重跑期间 `dist/cli.js` 再次缺失。
  本次未取得稳定的完整 E2E 通过结果，不将它记录为通过。未中断其他工作区进程。

测试结果只能说明当前代码的已有断言是否通过，不等于已覆盖本次新增规范。
