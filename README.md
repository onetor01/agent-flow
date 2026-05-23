# Agent Flow

Agent Flow 被定义为 Agent 作为节点构成的有向图，此插件提供可视化构建和调用 Agent Flow 的能力。

Agent 间模型、上下文等可以做到完全隔离，Flow 可以从任意位置启动。

通过 Claude SDK 使用 AI 能力，需要正确配置环境变量。下载 `@anthropic-ai/claude-code` ，如果能通过命令行进行 AI 对话，便可正常使用插件。

---

## 安装

**方式一：直接下载 VSIX**

前往 [Releases 页面](https://github.com/FanetheDivine/agent-flow/releases/) 下载最新的 `.vsix` 文件。

**方式二：从源码构建**

```bash
git clone https://github.com/FanetheDivine/agent-flow.git
cd agent-flow
pnpm install
pnpm build-extension   # 生成 .vsix 文件
```

**安装到 VSCode**

在 VSCode 扩展面板右上角菜单（`···`）中选择 **"从 VSIX 安装"**，选中下载或构建好的 `.vsix` 文件即可。

---

## 界面速览

![](resources/case1.jpg)
![](resources/case2.jpg)
![](resources/case3.jpg)

## 主要功能

### 1. 可视化编辑工作流

- **框选 / 拖拽画布**：左键拖空白处框选节点，中键或右键拖拽平移画布。
- **模型自由搭配**：每个 Agent 独立配置模型（opus / sonnet / haiku）、思考强度（effort）与简介描述。
- **三种工作模式**：`task`（围绕任务推进，达成结束条件后调 `AgentComplete` 流转到下一节点）/ `chat`（长期对话，禁止 `AgentComplete`）/ `silent_task`（无人值守循环：AskUserQuestion 自动应答、每轮 result 自动续「继续」、未授权工具直接 deny，由 `AgentComplete` 或 `terminateTask` 终止；首次切换时弹一次警告 modal，需谨慎选择模型 / effort / 提示词）。
- **无输入启动**：开启 `no_input` 的 Agent 在节点上显示启动按钮，点击后始终以"开始"为初始消息自动运行，无需手动输入。
- **上下文隔离**：每个 Agent 有自己独立的对话上下文。
- **共享数据按 key 授权读写**：Flow 在 `shareValuesKeys` 中声明全部可用 key（每个 key 可附加 `desc` 标注语义）；Agent 各自配置 `allowed_read_values_keys` / `allowed_write_values_keys`，只能看到 / 写入被授权的 key。被授权读取的 key 与当前值会注入到 Agent 系统提示词「# 可用数据」节；写入只能在 `AgentComplete` 时通过 `values` 参数一次性提交，未授权 key 会被静默丢弃。
- **连线约束**：每个 output 最多连一条出边；`next_agent` 允许指向自身以支持循环。

### 2. 自由复制粘贴

- **Agent 节点**：选中一个或多个节点 `Ctrl+C` / `Ctrl+V`，内部连接关系会被保留，ID 自动重映射，指向外部的连接被丢弃。
- **整条 Flow**：工作流列表的复制按钮把 Flow 序列化成 JSON，直接在画布空白处 `Ctrl+V` 即可导入（支持单个对象或数组批量导入）。
- **直接粘贴文件**：在聊天输入框通过 `Ctrl+V` 粘贴图片 / 文本 / 任意文件，都会作为内联附件附加到消息；图片以缩略图展示，外部长文本以独立面板预览。

### 3. AI 对话体验

- **流式传输**：AI 回复的文本块 / thinking 块实时显示，无需等待整段消息生成完毕。
- **虚拟列表渲染**：长对话场景下消息列表基于 `@tanstack/react-virtual` 虚拟化，仅渲染可视区域内消息，滚动与流式更新都不再因历史消息堆积变慢。
- **工具调用可视化**：消息气泡中显示工具调用摘要（读取的文件、执行的命令等），未完成时 loading，完成后可展开查看参数与执行结果。
- **AskUserQuestion 富文本**：AI 向你提问的内容通过 Markdown 渲染，支持代码、链接、列表等格式。
- **多问题自动排队**：同一回合内 AI 抛出多张提问卡片时按顺序排队，回答完一张自动滚动到下一张，全部回答完毕后才回到 running 状态；提问卡片高度自适应容器。
- **Mermaid 图表**：聊天消息中支持渲染 Mermaid 流程图/时序图，AI 可生成可视化图表。
- **可拖拽聊天 Drawer**：支持拖拽调整宽度、`Esc` 关闭。
- **智能通知**：Agent 等待回复或工作流完成时，若面板不在前台，自动弹出 VSCode 系统通知，点击即可跳转回对应聊天。
- **关闭面板不打断运行**：关闭 Webview 后 Agent 继续在后台执行，重新打开时自动恢复全部历史消息与运行态，等待用户回复 / 完成等通知照常送达。
- **Flow 编辑器**：Flow 列表项的数据库按钮打开 FlowEditor 抽屉，集中编辑工作流名称、Flow 简介、`shareValuesKeys`（拖拽列表维护，每项支持 `key` / `desc`、重复校验、一键清空）以及运行中各 key 的当前值；删除 key 时自动清理所有 Agent 的 `allowed_read/write_values_keys` 引用。
- **AgentComplete 完成卡片**：每个 Agent 完成时的卡片直接展示本回合写入的共享数据（按 `key/value` 列出），便于回看数据流转；`AgentComplete` 后立即中断 SDK，避免模型继续生成多余文字，且中断回合的 token / 费用统计不会丢。AgentComplete 的 `content` 现在会作为下一个 Agent 的首条用户消息回显，保证 UI 与运行时输入对齐。
- **Token 消耗可视化**：消息级、回合级、Flow 级三层展示 token 用量与费用，AI 气泡自动回填实际消耗，优先显示 SDK 实际费用而非估算；`agent_complete` 时展示按模型分组的 session 累计 breakdown。
- **上下文窗口占用展示**：在 turn_end / agent_complete 卡片内部展示上下文占用条，展示「最后一次 API 调用真实喂给模型的 input + cache 总量 / 模型上下文窗口」，按占用率以红 / 黄 / 灰渐变上色（≥80% 红、≥50% 黄）。
- **Starting 阶段节点高亮与红点**：启动阶段（session 尚未建立）Agent 节点也能正确高亮显示，对话框同步展示红点提示。
- **AskUserQuestion 字体优化**：调整提问卡片字体样式，提升可读性。
- **对话 Fork**：在 Agent 对话中可从任意一条消息（user / text / thinking / turn_end）右上角的 fork 按钮分叉出新 Flow，原路径保留。fork 走 lazy 模式：构造时不立即启动 SDK，等用户在新 Flow 发消息时再启动。可用来对比不同提示或不同模型的效果。

### 4. 内置示例工作流

插件自带三条内置 Flow（不可删除，位于列表顶部）：

- **工作流生成器**：`需求分析 → 工作流设计 → 工作流校验`。描述一下你的需求，它会自动拆步骤、生成符合 FlowSchema 的 JSON，再校验一遍——粘贴到画布即可得到一条可运行的新 Flow。
- **常用 Agent 可直接复制**：`模型理解能力测试`、`飞书通知`、`修改代码（无限循环）` 等示例 Agent，可复制粘贴到你自己的 Flow 里当零件用。
- **AI 对话**：最小可用的单 Agent 对话工作流，内置 glm / opus / sonnet 三种模型可选。

### 5. 编辑器联动

在 VSCode 编辑器中按 `Ctrl+Shift+L`（macOS：`Cmd+Shift+L`）：

- **有选中文字**：将选区作为带行号的代码引用追加到当前活跃的聊天输入框。
- **无选中文字**：将当前文件的全部内容作为代码引用追加，不附带行号。
- **点击代码片段 Tag**：带行号时打开文件并选中对应行，整个文件片段则仅打开文件。

---

## 快捷键

### VSCode 编辑器

| 快捷键                         | 行为                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | 有选中文字：将选区作为带行号的代码引用发送到活跃输入框；无选中：发送整个文件 |

### 画布

| 快捷键                | 行为                                            |
| --------------------- | ----------------------------------------------- |
| `Ctrl+C`              | 复制选中的一个或多个 Agent 节点                 |
| `Ctrl+V`              | 画布内粘贴 Agent，画布空白处粘贴 Flow JSON 导入 |
| `Delete`              | 删除选中的节点或连线                            |
| `Ctrl` / `Cmd` + 点击 | 多选节点                                        |
| 左键拖空白            | 框选节点                                        |
| 中键 / 右键拖拽       | 平移画布                                        |

### 聊天输入框

| 快捷键                                      | 行为                                 |
| ------------------------------------------- | ------------------------------------ |
| `Enter`                                     | 发送消息 / 提交 AskUserQuestion 回答 |
| `Ctrl` / `Shift` / `Alt` / 系统键 + `Enter` | 换行                                 |
| 粘贴文件                                    | 作为附件附加到消息                   |
