# 持久化

## 关键文件

- [`../src/extension/index.ts`](../src/extension/index.ts) — load/save/fork 与运行态持久化调度。
- [`../src/extension/PersistedDataController/index.ts`](../src/extension/PersistedDataController/index.ts) — globalStore / projectStore / workspaceStore。
- [`../src/extension/PersistedDataController/defaultStore.ts`](../src/extension/PersistedDataController/defaultStore.ts) — 默认 flow。
- [`../scripts/update-preset-flows.mjs`](../scripts/update-preset-flows.mjs) — 从 `PresetFlows.ts` 同步预设 Flow JSON。
- [`../src/common/index.ts`](../src/common/index.ts) — `PersistedData` / `WorkspacePersistedData` / `stripFlowRuntimeFields`。

## 持久化文件

Flow 分三个持久化文件：

- `~/.agent-flows.json`：全局 flows。
- `~/.agent-flows-projects/<sanitized_cwd>.json`：workspaceStore，保存项目 flows 与全量 runStates。
- `<workspaceRoot>/.agent-flows.json`：项目 flows 兼容读取来源。

workspaceStore 的 `runStates` 包含该 cwd 下所有 flow 的运行记录，不区分 flow 来源。

## 预设 Flow 同步

[`../scripts/update-preset-flows.mjs`](../scripts/update-preset-flows.mjs) 从 [`../src/common/PresetFlows.ts`](../src/common/PresetFlows.ts) 提取 `PresetFlows`，同时生成根目录 `preset-flows.json` 与 `.agent-flows.json`；前者用于 README 对外复制，后者保持与全局 flows 持久化结构一致。

## 读取规则

load 时并行读取 globalStore 与 workspaceStore：

- globalStore 提供全局 flows。
- workspaceStore 提供项目 flows 与 runStates。
- workspaceStore 不存在时，读取 projectStore 的 flows，runStates 为空。
- 全局与项目 flows 同时为空时注入 `defaultStore.flows` 作为全局 flows；项目 flows 按读取结果数组长度判断，workspaceStore 不存在时 fallback 到 projectStore，projectStore 不存在 / 非法 / 语义错误返回空数组，合法 `{ flows: [] }` 也算空。

## 保存规则

- `Flow.project?: boolean` 是内存/UI 标记，标识 flow 属于项目作用域。
- 保存前必须调用 `stripFlowRuntimeFields` 剥离 `project`。
- extension save handler 按 `project` 路由到全局或 workspaceStore；全局 flows 仅在用户主动触发 `save` command 时写入 globalStore。
- workspaceStore 持久化 runStates，`~/.agent-flows.json` 只保存全局 flows。
- flushMessages 节流回调不自动写全局 flows，只持久化 workspaceStore 的 runStates 与项目 flows。

## project 标记

- 新建/克隆/粘贴产生的新 flow 自动标 `project: true`。
- fork 继承源 flow 的 `project` 值。
- 项目 flows 在 [`../src/webview/components/FlowListPanel/index.tsx`](../src/webview/components/FlowListPanel/index.tsx) 展示时，上方渲染“文件夹图标 + 项目flow”分割线标题。

## load 合并

加载时以磁盘 flows 为基准；内存中存在但磁盘不存在的 flow，若该 flow 有消息记录 `state.runs.some(r => r.messages.length > 0)`，则追加保留，否则丢弃；**目的是防止用户编辑磁盘配置后，正在对话的 flow 被无谓丢失**。

## 硬约束

- `project` 字段是内存 / UI 标记，保存前由 `stripFlowRuntimeFields` 剥离；`LiteFlow` 不含 `project` 见 [common-domain.md](common-domain.md)。
- `workspaceStore(cwd)` 路径通过 `sanitizeCwd(cwd)` 生成：路径分隔符与非法字符替换为 `-`，再去除首尾破折号并合并连续破折号。
- runStates 只写 workspaceStore。
- load 后恢复 runState 必须先归一化，详见 [flow-run-state.md](flow-run-state.md)。
