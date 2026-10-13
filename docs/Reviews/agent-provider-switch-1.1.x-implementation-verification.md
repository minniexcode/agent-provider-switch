# 1.1.x 实现验证记录

验证日期：2026-10-13。

审查基线：`e355d0d`（1.1.3），以及前置提交 `016e72e`（1.1.2）、`8f735c0`（1.1.1）。
验证结束时 HEAD 为 `293a8d7`，新增 `.node-version`、`.gitattributes` 与 skills lock；
与上述基线相比，业务源码、测试及 PRD/Design 没有变化，复现结论仍适用。
规范基线：已确认的 1.1.0–1.1.3 PRD/Design，最终范围与诊断规则以 1.1.3 为准。
此前的 PRD 审查记录属于历史快照，本记录重新验证当前实现。

## 结论与个人使用验收

**1.1.x 主体功能完成，按当前单人使用标准验收通过，本轮收尾。**

| 版本 | 主体功能 | 验证判断 |
|---|---|---|
| 1.1.0 | Claude defaults、merge、compact、dry-run 与回滚 | 主流程完成 |
| 1.1.1 | 显式 target、`--codex` 与 envelope | 基础功能完成 |
| 1.1.2 | 统一错误词汇、重复名称错误与移除 Claude `data.target` | 主体功能完成 |
| 1.1.3 | 命令 scope、双目标及窄化报告、身份候选与备份来源/恢复影响报告 | 主体功能完成，边界完善暂缓 |

构建、类型检查、进程内测试与 E2E 全部通过。用户确认当前 CLI 仅供本人使用，配置与
调用方式由本人控制，能够理解报错并自行修正；验收重点是主要功能和正常工作流。
后续完善按实际遇到的影响决定，无需为穷举所有异常分支继续扩大本轮工作。

额外验证记录了 12 组具体行为及其与 PRD 的差异，保留为后续定位依据。用户已接受这些
记录并暂缓处理。原报告对 F01–F05 的 P1 标注及“全部修复后才能完成”的要求过重，
缺少结合当前使用场景的优先级依据，现予以撤销。以下记录不设置统一的紧急修复等级。

本记录保留真实复现结果，不声明所有 PRD 边界均已满足。涉及正常默认路径或报告语义的
差异也保留原样，是否投入修复由实际使用需求决定。本次仅调整验证文档，未修复业务实现。

## 验证方式与结果

在 Windows、Node `20.19.5` 下执行，两个会重建 `dist/` 的测试套件顺序运行：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `fnm exec --using=20.19.5 cmd /c npx tsc --noEmit` | 通过，exit 0 |
| 构建及进程内套件 | `fnm exec --using=20.19.5 cmd /c npm test` | 通过，exit 0；该 runner 成功时不打印用例列表 |
| 构建及 E2E 套件 | `fnm exec --using=20.19.5 cmd /c npm run test:e2e` | 41 passed / 0 failed / 0 skipped，exit 0 |

另用隔离 fixture 调用真实 `runCli()`，验证输出 envelope、局部状态、迁移与 rollback 的实际
文件效果。临时目录由 `tests/helpers.js` 注册和清理；`APS_HOME`、`APS_CODEX_DIR`、
`APS_CLAUDE_DIR` 全部隔离。默认目录和旧目录迁移场景在当前进程中将 `os.homedir()`
替换为注册临时目录，随后还原。未访问真实目标配置。

额外正向断言通过：数组内 `null` 保留；完整一致性忽略对象键顺序；数组顺序改变产生差异；
两个身份候选中仅一个完整一致时仍保持 ambiguous。Codex 漂移场景使用现有
`setCodexSpawnImplementation()` 返回支持的 CLI 版本，排除宿主运行时问题的干扰。

## 暂缓处理的行为记录

| 场景类别 | 记录 | 当前处理决定 |
|---|---|---|
| 非法或损坏配置下的诊断与局部结果 | F01、F02、F07、F09、F10 | 保留复现，防御性完善暂缓 |
| 正常默认路径、配置痕迹及漂移报告语义 | F03、F08、F12 | 接受当前行为，按实际使用影响处理 |
| 缺少必需 flag，涉及旧目录迁移的调用 | F04 | 保留执行顺序记录，暂缓 |
| 特殊恢复路径或未知历史操作名的备份分类 | F05、F11 | 保留分类记录，暂缓 |
| 无 defaults 且身份字段显式为 null | F06 | 保留身份比较记录，暂缓 |

下文“预期”沿用原 PRD 对照，帮助以后定位差异；当前验收决定见上文。

### F01：Claude 依赖字段未完整校验，校验也未阻止身份匹配

位置：[live reader](../../src/storage/claude-providers-repo.ts:80)、
[record 校验](../../src/domain/claude-providers.ts:200)、
[报告匹配与后置校验](../../src/app/get-claude-status.ts:185)。

最小场景与实际结果：

- live `settings.json` 为 `{ "model": 42, "env": "bad" }`，registry 缺失：
  `doctor --claude --json` 返回 `healthy: true`、`complete: true`、`issues: []`，matching 为 unmanaged。
- live 与 record 都使用字符串 model，但 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、
  `apiKeyHelper` 为数字：doctor 返回 healthy，并认定该 record 为 managed。
- live 与 record 都为 `{ "model": 42 }`：doctor 虽有 record 的 `INVALID_CONFIG` issue，
  matching 仍为 `ok(managed)`，候选 `consistent: true`。

预期：先验证 effective/live 的 env 容器及 model/address/model-routing/auth/helper 等依赖字段。
非法类型产生 issue；无法建立完整合法候选集合时 matching 为 unavailable，不能继续认定
managed、unmanaged 或唯一候选。保留无 defaults 的普通 null 语义，不引入完整外部 schema。

### F02：损坏的 Codex TOML 被当成有效配置

位置：[结构扫描器](../../src/domain/config.ts:173)、
[读取入口](../../src/storage/config-repo.ts:32)、[报告入口](../../src/app/get-status.ts:159)。

在隔离 `config.toml` 中写入：

```text
model = [
broken syntax no equals
```

`status --codex --json` 实际返回 `healthy: true`、`complete: true`、`issues: []`，
`artifacts.config.status: "ok"`，activation 为 not-activated。

预期：已存在的非法 TOML 是内容故障；应报告解析问题并使依赖结果 unavailable。
未激活只免除运行时/投影前置要求，不能免除现有内容校验。当前按行提取字段的扫描器
并不是完整 TOML 语法验证器，外围 try/catch 无法捕捉它从未拒绝的语法。

### F03：正常默认 Codex 路径被错误标为 unavailable

位置：[报告路径解析](../../src/commands/dispatch.ts:129)。

未设置 `APS_CODEX_DIR` 或 `--codex-dir`，共享配置缺失，在隔离 home 的 `.codex/config.toml`
放置合法配置后，`status --codex --json` 返回路径 unavailable、`healthy: null`、`complete: false`。
源码中的同一分支也覆盖有效共享配置未声明 `defaultCodexDir` 的情况。

该分支涉及仅依赖默认路径的报告调用；显式提供目录、环境变量或有效共享目录值时有其他
解析分支。此次保留默认路径的复现，用户接受暂缓处理。

预期：共享配置可读或缺失时，继续正常的 discovery/default 路径优先级。只有共享配置损坏、
无法判定其覆盖值且没有独立路径时，才不使用默认路径。

测试覆盖原因：`runBuiltCli()` 在没有 `--codex-dir` 时自动注入临时 `APS_CODEX_DIR`，
现有普通 CLI 测试因此不会进入该默认分支。补测需隔离 home 并明确清空该环境变量。

### F04：裸 config compact 在范围拒绝前执行 I/O，甚至完成旧目录迁移

位置：[范围接受与迁移顺序](../../src/commands/dispatch.ts:68)、
[handler 内的缺少 flag 检查](../../src/commands/claude-handlers.ts:237)。

`config compact --json` 没有必需的 `--claude`：

- 正常共享配置下拒绝，却输出 `targets: ["claude"]`、`target: "claude"`。
- 损坏共享 JSON 下先报 `INVALID_CONFIG`，而不是缺少 selector 的 `INVALID_ARGUMENT`。
- 在隔离 home 中按 `LEGACY_TOOL_HOME_DIRNAME`（见 `src/storage/codex-paths.ts`）准备旧工具 home、
  清空 `APS_HOME` 后调用裸命令：最终虽报 `INVALID_ARGUMENT`，旧目录已经移动到当前 home。

预期：这种调用未接受合法 scope，应在 migration/config read 之前拒绝；
失败 envelope 为 `targets: []`、`target: null`。需要将必需 selector 的检查前移到 dispatch
接受范围之前，而不是仅在 handler 拒绝。

### F05：rollback 按 basename 识别已知 artifact，报告错误的实际影响

位置：[artifactOwner](../../src/domain/backups.ts:58)、
[restoreImpactOf](../../src/domain/backups.ts:301)。

隔离 manifest 恢复早先不存在的 `<claudeDir>/providers.json`，实际 rollback 删除该 Claude 根下文件，
命令成功，但 `data.targets` 为 `["codex"]`。envelope 的共享 scope `[]` 是正确的。

另有纯分类复现：

| 恢复路径 | 当前影响 | 应有影响 |
|---|---|---|
| `<claudeDir>/providers.json` | Codex | Claude，按实际 runtime 根 |
| `<codexDir>/agent-provider-switch.json` | shared | Codex，按实际 runtime 根 |
| `<toolHome>/nested/claude-providers.json`，不在 runtime 根下 | Claude | unknown |

预期：先匹配 caller 提供的**准确已知 artifact 路径**，例如真正的
`<toolHome>/providers.json`；其他路径再累计全部可信 runtime 根。任何位置的同名文件都
当作真实 registry/shared config，会绕过根归属并低估或错报影响。该误判也影响 legacy origin fallback。
现有 caller-built restore allowlist 没有被本问题扩大。

### F06：无 defaults 的 null 身份值被折叠为缺失

位置：[readIdentityValue](../../src/domain/claude-identity.ts:69)。

registry 中唯一 record 的 settings 为 `{ "model": null }`，没有 defaults，live 为 `{}`。
实际 `current --claude` 返回 `status: "managed"` 并选中该 record；status 也给出 managed，
同时又报告 `differencePaths: ["model"]`。

纯函数证据：`readIdentityValue({model:null}, "model")` 返回 `{present:false}`，
`sameIdentity({model:null}, {})` 为 true。

预期：身份路径最终叶子上的 null 是存在的普通数据，与缺失不同。只有路径途中遇到 null，
例如 `env:null` 无法继续取 `env.ANTHROPIC_BASE_URL`，才视为没有该子路径。

### F07：未选中的 Claude defaults 使 Codex-only doctor 不完整

位置：[doctor 健康聚合](../../src/app/run-doctor.ts:104)。

共享 JSON 有效，但 `claudeDefaults.settings` 为数组；Codex 路径通过环境变量可靠提供，
目标没有配置故障。`doctor --codex --json` 返回 `healthy: null`、`complete: false`、`issues: []`；
同 fixture 的 `status --codex --json` 返回 healthy、complete。

预期：未选中的 Claude defaults 不属于 Codex-only 报告的必要依赖，不影响其健康或完整性。
目前 doctor 无条件把 defaults reading 纳入健康计算；应按 selected scope 和真实依赖汇总。

### F08：配置痕迹的来源、归属与未知状态判断不正确

位置：[Codex evidence](../../src/app/get-status.ts:119)、
[Codex runtime evidence](../../src/app/get-status.ts:226)、
[调用方 defaults 归属](../../src/commands/handlers.ts:135)、
[Claude evidence](../../src/app/get-claude-status.ts:170)。

以下均通过实际 status 输出复现：

| fixture | 当前 configured | 应有 configured |
|---|---|---|
| Codex 只有有效 `auth.json`，无 registry/config/defaults | `ok(false)` | `ok(true)`；activation 仍可为 not-activated |
| 仅有有效 `claudeDefaults`，Codex artifacts/registry 缺失 | Codex `ok(true)` | Codex `ok(false)` |
| 已存在但损坏的 `claudeDefaults`，Claude live/registry 缺失 | Claude `ok(false)` | Claude `ok(true)`，另报 defaults 故障 |
| 共享 JSON 损坏、Codex 路径未知且无已知 registry 痕迹 | Codex `ok(false)` | unavailable；未知 runtime 不能支持否定结论 |

原因包括漏掉 auth 存在性、将共享 inspection 的 Claude defaults presence 传给 Codex，以及
把“默认块不可用”或“路径不可用”当作可靠不存在。任何已知痕迹应使 configured 为 true；
可靠确认全部来源缺失才为 false。

### F09：局部失败后仍填空结果，并丢掉独立已知路径

位置：[Claude candidateSet](../../src/app/get-claude-status.ts:185)、
[inheritance](../../src/app/get-claude-status.ts:222)、
[Codex 未知路径分支](../../src/app/get-status.ts:119)。

Claude registry 为 `{ "providers": [] }` 时，status 正确报告 invalid registry，count/matching
为 unavailable，却把 inheritance 报为 `{status:"ok",value:{}}`。实际没有读到可用 records，
不能推导出成功的空继承映射。

共享 JSON 损坏导致 Codex runtime 路径未知时，整个 paths reading 为 unavailable；
可靠已知的 `<toolHome>/providers.json` 路径也随之从报告消失。

预期：损坏 registry 的 record-dependent 结果保留 unavailable；按路径拆分 reading，
保留独立已知 registry 路径。不要用空集合代替未取得的数据。

### F10：current/list 仍把损坏 live 配置当成不存在

位置：[两态兼容 reader](../../src/storage/claude-providers-repo.ts:111)、
[current](../../src/app/claude-current.ts:22)、[list](../../src/app/claude-list-providers.ts:25)。

live `settings.json` 内容为 `{bad`，实际 `current --claude --json` 成功返回
`status: "no-settings"` 和 “No Claude Code settings.json found.”；list 的 matchState 为 not-activated。
同一内容在 doctor/status 中被诊断为 invalid。

预期：不存在与不可读/损坏分开；内容无效时不能宣称未激活或没有文件。查询命令可以使用
明确失败或不可用结果，但必须与统一的身份结果一致。

### F11：备份来源仍从任意 claude- 前缀猜测

位置：[classifyBackupTargets](../../src/domain/backups.ts:247)。

旧 manifest 没有 target metadata，reason 为 `claude-not-a-recognized-operation`，唯一路径位于
Codex runtime 根。实际 `backups list --codex` 得 count 0，`--claude` 得 count 1、target Claude。

预期：采用已知 operation 的显式表。未知 reason 应退回 artifact/path ownership；
该 fixture 的来源应为 Codex。当前实现的注释声称使用显式表，代码却仍为 `startsWith("claude-")`。

### F12：有效 Codex 投影漂移仍降低健康

位置：[投影 issue 汇总](../../src/app/get-status.ts:188)、
[base URL 比较](../../src/domain/config.ts:429)。

Codex live 与 registry 的 profile/model 关联有效，auth 有效，runtime probe 支持；仅 live 的
`base_url` 与 record 的 `baseUrl` 不同。doctor/status 均报告 managed 候选、
`consistent:false`、`differencePaths:["baseUrl"]`，但将 `PROVIDER_BASE_URL_MISMATCH`
放入 issues，使 healthy 为 false，notes 为空。

按最终 PRD 的全局健康表，身份匹配而其他有效设置不同是 drift note，不单独降低健康。
保留投影检查本身，将已知有效漂移与字段/内容故障分开。现有
`tests/provider-workflow.spec.js` 仍断言该漂移出现在 issues；这是应按最终规则调整的旧断言。

## 文档一致性记录

`CHANGELOG.md:39` 仍称 registry-only 的 tool-home 恢复 `targets: []`。最终 PRD/Design 与
当前已知 registry 分类都规定 registry 恢复计入其所属 target。发布说明应改为区分
registry-only、shared-only、unknown。CHANGELOG 顶部对 breaking 范围的概述也只提 bare
multi-target alias，应明确六个命令的 alias 改变；Shared alias 同样变为 null。

这些说明差异作为后续文档维护记录，随相关工作更新；当前个人使用验收已通过。

## 验收决定与后续处理

用户确认主体功能已满足当前个人使用要求，本轮验证收尾。F01–F12 保留记录、暂缓修复，
不作为必须全部完成的清单，也不要求覆盖全部异常输入与历史状态。

后续若实际使用中遇到影响操作或理解结果的情况，再按触发频率与实际影响确定修复范围。
对具体行为做修改时补相应回归用例，并运行适当检查；无需因本记录重新启动全面防御性完善。

本次文档调整没有改变代码或此前测试结果，仅修正验收结论、优先级与后续处理要求。
