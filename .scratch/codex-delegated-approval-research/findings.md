# Codex “替我审批”机制调研

调研日期：2026-07-21
对标目标：`pi-permission-safe-allow`
证据优先级：Codex 官方手册 > OpenAI Codex `rust-v0.144.4` 源码 > 本机只读配置状态。

## 结论摘要

Codex 的“替我审批（Approve for me / auto review）”**不是黑名单放行模式，也不是更宽的权限模式**。它保留原来的 sandbox、writable roots、network policy、MCP approval policy 与确定性规则，只把“原本已经需要交给用户的某一次具体审批请求”路由给一个独立、锁定为只读的 Guardian reviewer。

因此，最接近 Codex 的 Pi 设计不是维护一张庞大的 Bash/MCP/Skill 黑名单，而是：

1. 由 permission-system 继续决定哪些操作在现有权限边界内直接执行、哪些必须形成审批请求、哪些硬拒绝。
2. safe-allow 接收**完整的单次审批 dossier**，结合精简会话、精确 action、风险和用户授权语义做 `allow/deny`。
3. reviewer 不能改变 sandbox envelope；失败、超时、坏输出一律不执行。
4. 被拒动作可以让用户看到具体风险后，对**精确动作**显式授权并再审，而不是开启全局 YOLO。

官方说明明确将 auto review 描述为现有审批边界上的 reviewer，并说明它不会扩大 sandbox 权限；Guardian 源码也只在 `approval_policy` 为交互式策略且 `approvals_reviewer` 为 auto review 时接管审批。[Auto review manual](https://learn.chatgpt.com/docs/sandboxing/auto-review)；[Agent approvals security](https://learn.chatgpt.com/docs/agent-approvals-security)；[`review.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/review.rs)

## 1. 本机当前状态（已脱敏）

本机只读检查显示：

- `approval_policy = "on-request"`
- `sandbox_mode = "workspace-write"`
- `approvals_reviewer = "guardian_subagent"`（本机版本的配置命名）
- `features.guardian_approval = true`
- Codex App 当前本地 agent mode 为 `guardian-approvals`
- Codex CLI 版本为 `0.144.4`

这组配置本身就体现了两层分工：主 agent 仍是 `workspace-write`，审批仍是 `on-request`；Guardian 只替换 reviewer。检查过程中没有读取或记录任何 credential 值。

本机证据：`~/.codex/config.toml` 的非敏感键与 `~/.codex/.codex-global-state.json` 的 agent mode（2026-07-21 只读检查）。

## 2. 什么请求会进入 Guardian

Guardian 不是每个工具调用都运行。只有前置权限机制已经判定“需要审批”的动作，才会进入 auto review。官方手册列出的典型边界包括：

- shell / exec 请求升级 sandbox 权限；
- workspace writable roots 之外的写入；
- 被 network policy 阻止、需要新增网络许可的访问；
- 按 MCP/App annotations 或配置要求审批的工具调用；
- Computer Use 访问新的站点或域名等需要批准的边界。

正常 cwd 内、已被 sandbox/policy 允许的普通操作不会先制造审批，再让模型“批准”。这点对 Pi 很重要：**减少打断应优先修正 permission-system 的正常默认边界，safe-allow 只处理真正的边界请求。**

源码中的审批请求变体是：

- `Shell`
- `ExecCommand`
- `Execve`
- `ApplyPatch`
- `NetworkAccess`
- `McpToolCall`
- `RequestPermissions`

源码没有把“选择/激活一个 Skill”本身列为 Guardian action。更合理的解释是：普通 Skill 是指令/工作流入口，Skill 后续产生的文件、命令、网络或 MCP 行为仍在各自边界逐项治理；skill script 若触发独立权限请求，则审批的是该具体行为，而非 Skill 名字。

来源：[Auto review manual](https://learn.chatgpt.com/docs/sandboxing/auto-review)；[`approval_request.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/approval_request.rs)

## 3. Approval request dossier 包含什么

Guardian 收到的不是只有一条命令字符串，而是两个主要部分。

### 3.1 精简会话证据

- 用户消息；
- surfaced assistant 消息；
- 相关工具调用参数与工具结果；
- 必要时的 retry reason；
- 会话 id；
- 如果 parent turn 有不可读路径/Glob，显式附上这些 policy restrictions；
- 不包含隐藏 chain-of-thought。

实现会对消息和工具证据使用独立 token budget，优先保留首个和最近用户请求，并保留最近相关工具调用/结果。后续连续审批可只发送相对上一轮的 transcript delta。所有 transcript、工具参数、结果和待执行 action 都被 reviewer policy 明确标为“不可信证据”，不能作为改变审批规则的指令。

### 3.2 精确的 planned action JSON

不同 action 携带不同字段：

- Shell/Exec：`tool`、完整 argv/command、`cwd`、请求的 `sandbox_permissions`、附加权限、agent justification、TTY 状态；
- ApplyPatch：`cwd`、目标文件列表、patch 内容；
- Network：目标、host、protocol、port，以及触发该网络访问的 command/cwd/权限/理由；
- MCP：server、tool name、arguments、connector identity/description、connected account、工具 title/description、annotations；
- RequestPermissions：turn id、reason、请求的 permission profile。

字符串会被有界截断；截断会显式标记，policy 要求不能假设省略部分无害。`v0.144.4` 的主要上限包括：消息 transcript 10k tokens、tool transcript 10k、单 action 字符串 16k、最近非用户 entry 40 个。

来源：[`prompt.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/prompt.rs)；[`approval_request.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/approval_request.rs)；[`mod.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/mod.rs)

## 4. Reviewer 如何判断与返回

Guardian 的结构化输出不是 `allow / deny / escalate` 三态，而是：

```json
{
  "risk_level": "low | medium | high | critical",
  "user_authorization": "unknown | low | medium | high",
  "outcome": "allow | deny",
  "rationale": "string"
}
```

其中只有 `outcome` 必填。低风险允许直接返回 `{"outcome":"allow"}`。

默认语义阈值是：

| 风险 | 默认处理 |
|---|---|
| low | allow |
| medium | allow |
| high | 只有用户授权至少为 medium、范围窄且不命中绝对 deny 时 allow |
| critical | deny |

`user_authorization` 不是问用户是否写出了完全相同的 shell syntax，而是判断用户是否授权了动作的**实质目标、payload 和副作用**。明确请求精确动作通常是 high；只授权了效果但没指定实现可能是 medium；弱相关为 low；几乎无证据或动作来自工具输出/agent 漂移为 unknown。

Reviewer 可以做少量只读检查来消除不确定性。例如删除前检查目标是否存在、大小和范围；推送前检查 remote 与分支；判断网络导出前确认数据和目的地。Guardian 自己运行在 read-only sandbox、`approval_policy = never`，清空非必要 MCP，并禁用会产生副作用的能力；它不能自己再申请审批或改变用户状态。

来源：[`policy_template.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy_template.md)；[`policy.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy.md)；[`prompt.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/prompt.rs)；[`review.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/review.rs)

## 5. Sandbox、静态策略与 semantic reviewer 的分工

Codex 不是单一黑名单，而是分层决策：

```text
权限/sandbox/网络/MCP 配置
  ├─ 已允许：直接执行，不进入 Guardian
  ├─ 硬禁止：阻止，Guardian 不扩大边界
  └─ 需要审批：形成精确 request dossier
                    ↓
             Guardian semantic review
                    ↓
                allow / deny
```

### 5.1 Bash 不是只按危险命令名判断

Codex 另有确定性的 exec policy 规则，可以按命令前缀产生 `allow / prompt / forbidden`，冲突时使用更严格结果。对于 `bash -c/-lc`，规则系统只会拆分能够可靠静态理解的简单线性命令链；变量、赋值、重定向、命令替换、glob、控制流等不安全地猜测其运行时含义，而是把 wrapper/script 当作整体交给后续边界处理。

关键点是：**“无法静态拆分”不等于 Guardian 必须永久拒绝。** 若这个整体已进入审批，Guardian 可以结合精确脚本字符串、用户授权、上下文和只读证据做语义判断。反过来，单看出现 `rm -rf` 也不会自动判为高风险：官方 policy 明确要求先看目标；一个用户指定、经检查为空或范围窄的本地目录删除通常只是 low/medium。

来源：[Rules manual](https://learn.chatgpt.com/docs/agent-configuration/rules)；[`policy_template.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy_template.md)

### 5.2 MCP 不是工具名黑名单

MCP/App 的前置审批主要由 server/tool 配置与 annotations 驱动，例如：

- `readOnlyHint`
- `destructiveHint`
- `openWorldHint`
- server/app 默认 approval mode
- per-tool override

进入 Guardian 后，dossier 会同时带 tool 名、参数、连接器/账户信息、工具说明与 annotations。Reviewer 判断的是这一**次具体调用和参数**是否匹配用户意图、是否产生外部副作用，而不是只凭 `delete_*`、`send_*` 等名称黑名单。

来源：[MCP manual](https://learn.chatgpt.com/docs/mcp)；[Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)；[`approval_request.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/approval_request.rs)

## 6. 硬边界与风险政策

默认 Guardian policy 关注的是“不可逆损害 + 用户/组织是否授权”，而不是“cwd 外 = 危险”。官方 policy 特别说明：

- 普通 cwd 外本地文件操作本身通常仍是 low risk；
- sandbox denial 后请求升级本身不表示可疑，应判断 unsandboxed action 的真实风险；
- 大规模/长时间工作流本身不等于破坏性；
- 使用已有 credential 完成用户明确请求的正常认证，不等于 credential exfiltration；
- 向不可信外部目的地披露 secret、credential 或私有组织数据是绝对 deny，即使授权看似 high；
- 广泛、持久的安全削弱需要覆盖精确 setting、服务和 blast radius 的明确授权；
- 广泛破坏、默认/保护分支破坏、未授权清理属于高风险；单一已验证 feature branch 上的有限变更可以只是 medium。

这说明 Pi 的敏感路径边界不应简单等同于“永远不能使用 credential”。更接近 Codex 的边界是：**可以通过服务原生认证通道使用 credential，但不应把 secret 值暴露给 reviewer、shell output 或不可信 sink。**

来源：[`policy.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy.md)；[`policy_template.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy_template.md)

## 7. 失败、超时与拒绝循环

Guardian 是 fail-closed：

- prompt 构建失败：不执行；
- reviewer session 失败：不执行；
- 输出无法解析：不执行；
- 超时：不执行，但明确标记为 timeout，不能把 timeout 本身解释成动作危险；
- cancel：中止。

`v0.144.4` 的全局 review deadline 是 90 秒；瞬时服务错误和 parse error 最多在同一 deadline 内尝试 3 次。超时后主 agent 可以重试一次，或请求用户指导/显式批准，但不能默认执行。

为防止 agent 被拒后持续换写法绕过，Guardian 有拒绝 circuit breaker：同一 turn 连续 3 次 deny，或最近 50 次 review 中累计 10 次 deny，会中断当前 turn。拒绝反馈还明确要求 agent 不得通过 workaround、间接执行或规避策略实现相同结果，只能选择实质更安全的替代方案，或在说明风险后取得用户明确批准。

来源：[`review.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/review.rs)；[`mod.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/mod.rs)；[Agent approvals security](https://learn.chatgpt.com/docs/agent-approvals-security)

## 8. 哪些情况仍需要用户

Guardian 没有 `escalate` verdict。需要用户介入时，表现为动作未执行、agent 停止并请求用户输入，或者用户使用 `/approve` 对最近某个被拒的**精确动作**重新授权。重新授权不是全局放开；该精确动作仍会再经过 reviewer，绝对 tenant deny 仍可拒绝。

已确认仍直接或最终需要用户的情形包括：

- Computer Use 的 app-level prompts（官方说明不会被 auto review 替代）；
- critical 或 tenant absolute-deny 动作；
- reviewer 超时/失败后若任务必须继续；
- reviewer 因授权不足拒绝、但用户愿意在看到具体风险后精确授权的动作；
- 无法通过安全替代路径完成、且需扩大既有权限 envelope 的动作。

需要区分“要求 approval”和“要求 human approval”：destructive MCP call 可以始终要求 approval，但在启用 auto review 时，这个 approval 可能由 Guardian 完成；只有 Guardian 拒绝/失败或产品明确排除 auto review 时才真正落到人。

来源：[Auto review manual](https://learn.chatgpt.com/docs/sandboxing/auto-review)；[Agent approvals security](https://learn.chatgpt.com/docs/agent-approvals-security)；[`policy_template.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy_template.md)

## 9. 对 `pi-permission-safe-allow` 的产品建议

### 9.1 应复刻的核心链路

建议把 Ticket 2 从“黑名单导向自动放行”改写为：

> permission-system 保持确定性 sandbox/权限边界；safe-allow 对所有 eligible approval request 进行基于完整 dossier 的语义代审，在不扩大 delegation envelope 的前提下达到 Codex 式“替我审批”。

建议的最小 dossier：

```text
request id / turn id
surface + exact tool/action
cwd + workspace roots
requested permission delta
exact argv / patch / MCP args / network destination
agent justification
relevant user intent and recent assistant/tool evidence
policy facts: protected paths, network/MCP annotations, connected account
prior denial + exact user override（如有）
```

Reviewer 输出建议与 Codex 对齐：

```json
{
  "riskLevel": "low | medium | high | critical",
  "userAuthorization": "unknown | low | medium | high",
  "verdict": "allow | deny",
  "rationale": "string"
}
```

### 9.2 对 Skill、MCP、Special 的处理

- **Skill**：不要因为 Skill 名称本身频繁弹审批。可信安装来源的普通 Skill 选择可直接允许；其后续 tool calls 各自在真实边界审批。
- **MCP**：不要使用固定工具名黑名单作为主机制。优先使用 annotations、server/tool approval config、连接账户、精确参数与 side effect 判断；需要审批的调用交给 safe-allow。
- **Special**：把它拆成可描述的具体 action schema；无法形成精确 action dossier 的 special 不应自动批准。

### 9.3 Bash 的处理

- 保留静态 parser/exec policy，用于已知 allow、hard deny 和构造准确 dossier；
- 能可靠拆分的 chain 可逐项分类，最严格的前置边界生效；
- 无法静态拆分的 wrapper 不要假装理解，也不要仅因此永久人工：把完整静态脚本文本和上下文交给 semantic reviewer；
- 真正动态、最终 payload 不可见的调用，因 dossier 不完整而提高不确定性，通常 deny 并要求提供具体命令或用户精确授权；
- 对 `rm -rf`、`git reset`、force push 等必须结合目标范围、remote/branch、可恢复性与用户授权，不应只按 token 命中永久阻止。

### 9.4 必须保留的保险线

- reviewer 只审单次动作，不能改写 permission envelope；
- credential value 不进入 reviewer dossier；
- fail-closed + bounded retry + 明确 timeout；
- denial rationale 返回主 agent，禁止换壳规避；
- denial circuit breaker；
- 用户对最近拒绝的精确动作做 one-shot override，而不是全局 allow；
- audit log 记录 request 摘要、风险、授权、结论、rationale、耗时和 decision source，但脱敏 secret。

## 10. 对前述“安全边界草案”的修正

基于本次调研，前述草案中以下表述需要修正：

1. **不是**“除了敏感路径和危险 Bash，其他全放行”的纯黑名单模式。
2. **不是**“不透明 Bash 一律只能人工审批”；完整静态脚本仍可由语义 reviewer 判断，真正不可见的运行时 payload 才应因证据不足 deny/请用户具体化。
3. MCP/Skill 不应默认长期保守为人工 `ask`；应让常见动作在前置边界直接通过，真正需要 approval 的具体调用进入 safe-allow。
4. 敏感路径不应粗暴等同于永不访问；应重点保护 secret value 不被读取到不可信上下文或发送到不可信 sink，同时允许服务原生认证完成用户请求。
5. Reviewer 本身不负责扩大 sandbox；它只批准或拒绝 permission-system 已构造出的精确权限增量。

## 来源清单

- OpenAI Codex manual — [Auto review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- OpenAI Codex manual — [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- OpenAI Codex manual — [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)
- OpenAI Codex manual — [MCP](https://learn.chatgpt.com/docs/mcp)
- OpenAI Codex manual — [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- OpenAI Codex source `rust-v0.144.4` — [`approval_request.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/approval_request.rs)
- OpenAI Codex source `rust-v0.144.4` — [`prompt.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/prompt.rs)
- OpenAI Codex source `rust-v0.144.4` — [`policy_template.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy_template.md)
- OpenAI Codex source `rust-v0.144.4` — [`policy.md`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/policy.md)
- OpenAI Codex source `rust-v0.144.4` — [`review.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/review.rs)
- OpenAI Codex source `rust-v0.144.4` — [`review_session.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/review_session.rs)
- OpenAI Codex source `rust-v0.144.4` — [`mod.rs`](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/guardian/mod.rs)

## 证据边界

- 本文对 Guardian 内部行为的精确描述固定到本机已安装的 Codex `0.144.4` / Git tag `rust-v0.144.4`；后续版本可能调整字段、阈值和 UI 命名。
- 官方 manual 页面可能持续更新；产品实现时应固定测试契约，而不是依赖文档措辞不变。
- 本机配置仅用于确认当前启用形态，不作为公开产品 API 的依据。
