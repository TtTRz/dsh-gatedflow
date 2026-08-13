# dsh-gatedflow

面向 **DeepSeek Harness** 的门禁式、可持久、**人在环** 工作流引擎——
门禁即控制流："务必验证 / 确认 / review" 的规则活在引擎里，而不是
prompt 里，任何 agent 都无法在高负载下绕过。

> **零突变 replan · 门禁即控制流 · 声明式 subflow。**
> 引擎核心不含 LLM，也不依赖任何 orchestrator。

## 包结构

| 包 | 职责 | 依赖 |
|---|---|---|
| [`@gatedflow/engine`](packages/engine) | 框架无关的引擎核心：校验、展开、确定性条件、工作流状态机 | 无 |
| [`@gatedflow/dsh`](packages/dsh-gatedflow) | DSH 适配层：`gf_*` 工具、门禁面板 UI、防绕过 guard、文件持久化 | `@gatedflow/engine` + DSH 服务 |

## 一张图看懂

```
用户任务 ──► agent 组合 atomics（Ref/Inline）──► gf_start
                                                  │
              路① 单项 Ref ──────────────────┐    │
              路② 多项/含 inline ── pre_start_gate（人审计划）
                                                  ▼
              shell（command + expect）─ interrupt（面板人审门）
              handoff（交回 agent）── conditional（结构化字段判定）
                                                  ▼
                                              done（引擎自动追加）
```

- **门禁是控制流。** `interrupt` 步骤暂停引擎；用户在会话中的面板卡片上
  批准/否决。模型 agent **没有任何 approve/reject 通道**——`gf_advance`
  拒绝它们（guard + schema 双保险），人审决定从面板直达引擎。
- **零突变。** agent 无权改写 workflow 状态、参数或路由。失败只有两条
  路：step 级失败且声明 `pause_on_failure` → 暂停 → 人修复 → `retry`
  （前置成果保留）；否则 `abort` → 失败 → 人审 → 起新 workflow。
- **声明式 subflow。** workflow 是 JSON/YAML 数据，加载时结构校验、
  启动时快照——**人批的计划就是执行的计划**。
- **引擎不含 LLM。** 语义判断在 agent 侧完成并返回**结构化字段**；引擎
  只计算确定性算子（`==`、`!=`、`>`、`<`、`contains`、`&&`、`||`、`!`）。

## 快速开始

```bash
npm install
npm run check   # build + typecheck + 49 个单元测试
```

### 跑一个 workflow（DSH 用户视角）

适配层注册 7 个工具。agent 组合计划后：

```
gf_start({ atomics: [
  { name: 'gf-verify-demo', params: { note: 'hello' } },
  { type: 'shell', params: { command: 'echo done', expect: 'true' } },
]})
```

- **单项 Ref** 确定性运行预设（不包门）。
- **多项 / 含 Inline** 自动包 `pre_start_gate`：引擎暂停，计划以面板卡片
  出现在输入框上方。点 **✓ 批准** 继续，点 **✕ 否决** 中止。
- handoff 门暂停等 agent；agent 用
  `gf_advance(handoff_complete, result)` 回传结构化结果。
- 声明了 `pause_on_failure` 的失败 step 会显示**待续跑**卡片；人修复环境
  后 `gf_advance(decision: 'retry')` 只重跑该 step。

### 写一个 subflow

把 JSON 文件放进 subflows 目录（默认 `~/.gatedflow/subflows`，可用
`GATEDFLOW_SUBFLOWS_DIR` 覆盖），然后调 `gf_reload_subflows`——热加载，
无需重启：

```json
{
  "name": "release",
  "description": "客观校验的构建 + 人审 + 发布",
  "keywords": ["release", "build", "review"],
  "params": { "branch": { "required": true } },
  "steps": [
    { "id": "build", "type": "shell", "params": { "command": "npm run build", "expect": "test -f dist/index.js", "max_retries": 1, "pause_on_failure": true }, "on_success": "review", "on_failure": "abort" },
    { "id": "review", "type": "interrupt", "params": { "message": "发布 ${branch}？" }, "on_approve": "publish", "on_reject": "abort" },
    { "id": "publish", "type": "shell", "params": { "command": "npm publish" }, "on_success": "next", "on_failure": "abort" }
  ]
}
```

更多示例见 [`examples/subflows/`](examples/subflows)。

## 架构

- [`docs/DESIGN.md`](docs/DESIGN.md) —— 根约束、step 模型、routing、数据
  引用、门禁协议、持久化与反卡死设计，含决策记录。
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) —— 在 DSH 组合中挂载适配
  层、环境变量、工具参考与 agent 技能引导。

## 开发

```bash
npm install
npm run test          # 引擎单元测试（vitest，49 个用例）
npm run typecheck     # 两个包的全量严格类型检查
npm run build         # engine + dsh 的 tsc 产物
```

引擎包刻意零依赖、框架无关；DSH 适配层是对 harness 服务
（`fs`/`shell`/`tools`/`timer`/`subagents`/`webServer`）的薄类型化接线层。
欢迎贡献——见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 现状

v0.1 交付引擎核心 + DSH 适配层：`shell`/`interrupt`/`handoff`/`conditional`/
`agent_delegate`/`agent_resume` 步骤、门禁面板、防绕过 guard、门禁超时、
/stop 安全的中断语义、热加载 subflow、有界尾部审计日志、按引用恢复的
持久化（状态与审计落在工作区 `.gatedflow/`）。
路线图：更完善的 YAML 编写体验、把高频动态组合固化为具名预设的
solidify 流程。

## License

MIT —— 见 [LICENSE](LICENSE)。

## 与 gatedflow 的关系

本项目是对 gatedflow 理念面向 DeepSeek Harness 的独立原生实现，沿用其
词汇（atomics、subflow、pre_start_gate、零突变 replan、决策记录），但
全部在 harness 原生原语上从零重新实现——引擎核心为 TypeScript 编写，
无任何外部依赖。
