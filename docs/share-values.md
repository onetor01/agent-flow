# ShareValues 授权读写

## 关键文件

- [`../src/common/index.ts`](../src/common/index.ts) — `Flow.shareValuesKeys`、prompt 注入、schema 清理。
- [`../src/common/extension.ts`](../src/common/extension.ts) — `CompleteTask.values` 动态 schema；`ReadShareValue` 工具挂载。
- [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) — values 合并与 setShareValues reducer。
- [`../src/extension/FlowRunStateManager.ts`](../src/extension/FlowRunStateManager.ts) — extension 端运行态读取。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — next agent prompt 快照拼接。

## 命名

- Flow 视角：`shareValues`。
- Agent 视角：`values`。

## 声明

`Flow.shareValuesKeys` 声明共享数据 key。删除 key 时，相关 `allowed_read_values_keys` / `allowed_write_values_keys` 自动清理。

## 读

`buildAgentSystemPrompt` 注入「可读写数据」与「可用数据」节。可读值是 prompt 时点快照，运行中更新值需要切到下一 agent 后生效。

系统提示词注入与首条 user 消息 UI 展示是两路独立逻辑：系统提示词按小值内联 / 大值 `ReadShareValue` 分流；首条 user 消息的 `injectedShareValues` 展示 `allowed_read_values_keys` 全量值（无大小限制），code 节点展示完整 shareValues，仅用于 UI 可读性，与 executor prompt 无关。

- 小值（≤ 500 字符）：内联 JSON 块直接注入 `<shared_data>`，零工具往返。
- 大值（> 500 字符）：仅列摘要行（key + 字符数），完整值通过 `ReadShareValue(key)` MCP 工具按需读取。`ReadShareValue` 读取的是 `init()` 时点固化的 prompt 快照，与内联值同源一致。`ReadShareValue` 仅在有大值 key 时挂载到 `AgentControllerMcp`，无大值时不挂载。对同一 key 多次调用返回相同结果（幂等），系统提示词与工具描述均声明此约束。
- `AgentRun.shareValuesSnapshot` 是 run 会话开始（创建）时点的完整 shareValues 快照。
- 普通启动 / 切 agent 的 executor 取 `getLatestShareValues()`；fork / restore 的 lazy executor 优先取源 run 的 `AgentRun.shareValuesSnapshot`，旧持久化 run 缺失此字段时 fallback 到 `getLatestShareValues()`，复现起点的 system prompt 与 ReadShareValue，与历史自洽，不受 fork 后 `setShareValues` 变更影响。两路取值同源于 `FlowRunStateManager`。

## 写

- `node_type='agent'`：仅 `CompleteTask.values` 可写；schema 由 `allowed_write_values_keys` 动态生成，未授权 key 静默丢弃。
- `work_mode='chat'`：不挂载 CompleteTask，无法通过 `CompleteTask.values` 写 values。
- `node_type='code'`：全量读取 shareValues；返回的 `values` 仅提交代码显式修改的 key，delta 合并到 shareValues，不受 allowed_write 约束。

CompleteTask.values 为 key 级增量（未传 key 保留）、单个 value 整值替换（提交需给完整新值）。

## 事件与运行时取值

- `flow.signal.agentComplete.values`：reducer 合并到 `state.shareValues`。
- `flow.command.setShareValues`：full replace，无 `runId`，未运行时也能编辑。
- extension 端通过 `getLatestShareValues(flowId)` 读取 `FlowRunStateManager` 最新值。
- `FlowRunner` 不持有 shareValues 副本。

## 硬约束

- shareValues 是 prompt 快照；切下一 agent 时必须手动 `{ ...getLatestShareValues(), ...result.values }` 拼接。
- `allowed_read_values_keys` / `allowed_write_values_keys` 仅约束 `node_type='agent'`。
- code 节点全量读、delta 写。
- `setShareValues` 是 full replace，调用方负责传完整对象。
- CompleteTask 的 MCP 参数 schema 见 [common-domain.md](common-domain.md)；CompleteTask 驱动下一 agent 的运行时流程见 [extension-runtime.md](extension-runtime.md)。
