# 人类接管后端交付

实现：Astra；独立验收由 root 执行，本文不把作者自测称作独立验收。未更改叙事事实卡 V2 生成器，也没有运行付费模型请求。

## 运行与边界

- 新运行默认观察 100 轮，创建单段与延长一次允许 1—500 轮。maxTicks 继续代表累计阶段截止轮次；旧 30 轮档正常导入。请求预算沿现有配置（默认 500），不随轮数增加；原用户显式配置上限 10000 保持兼容。长观察可能先用完请求额度，仍遵循原故障暂停/显式回退机制。
- `RunState.humanCivilizationId?: string|null`：缺失等价未接管；新建请求可传同字段。只控制一个存活文明的主动作，人格生成流程保持原样。
- 接管/放权只能在 server 不 busy 的稳定边界执行。已经成功保存的 request/decision 不被替换；若本轮已有决定，接管从下一轮生效。completed 阶段可接管后延长。
- step 先准备原有物理冻结视图，处理其他文明，缺少受控文明输入则 paused 等待，保持 committed world 不变，不伪造 wait。人类输入保存后，后续 step 才执行全体原子提交。

## API 契约

- `POST /api/runs/:id/control`：`{civilizationId: string|null}`，返回普通 RunState DAG 响应。
- `GET /api/runs/:id/human`：返回共享 `HumanTurn`：`busy, civilizationId, tick, turnId, waiting, submitted, decisionSource, view, guidance`。view 只经 viewFor 白名单生成，target 使用 contactId/siteId；非冻结期可只读查看当前自身视图，但 turnId=null。busy 时 waiting=false。
- guidance 复用 decisionInput 的 affordability、legalExamples、合法目标/提案与预算约束，仅辅助选择，不替用户决定动作。
- `POST /api/runs/:id/human`：`{turnId,decision}`。Decision 使用相同引擎 JSON/目标/成本/证据校验；相同 turn 同值重交幂等，不同值拒绝；已提交轮次或 generation 变化后的旧 turnId 拒绝。返回 RunState，随后继续/step 提交本轮。
- human decision/request/action event 显式来源 human；request attempts=0，不增加 usedRequests。

## 恢复与并发

- pending 等待与已提交输入均随存档恢复，导入后的 generation 变化使旧表单失效。导入核验 human 来源、0 次外部尝试、request/decision 关联、冻结视图合法性与成本。
- 若外部请求已成功但尚未保存 DecisionRecord，step 优先恢复成功响应；接管不会再次请求或覆盖它。
- 暂停无 busy 的 human pending 会刷新 generation，使旧输入失效。cancel 保持原有“取消未提交事务”的语义，并刷新 generation；它不是保存后继续操作。放权保留已提交但尚未 commit 的 human 决定。

## 验证

`tests/human-control.test.ts` 7 项：100/500 与旧档、无输入不提交、局部视图、非法真 ID 与预算拒绝、同值幂等、pending 两种恢复、放权保留、人类旧表单、busy、AI 成功不重复、孤立成功响应恢复、伪造档拒绝。

作者执行定向 25/25 通过（包括 root 编写的 human-review，以及 server/pause/cancel/narrative 回归）：`output/tests-human-backend.txt`。`npx tsc --noEmit` 通过。正式浏览器人类操作、第一人称 UI 与最终独立验收由 root/UI 后续执行。

## 人工指令面板实现与自测

`src/ui/HumanControlPanel.tsx` 与 `src/ui/human-decision.ts` 由 Astra 接管修复。表单使用真实 guidance 的动作、消息种类、contactId/siteId 字符串目标及 incoming/pending/未到期提案。强度为 0—1，预算按引擎成本自动计算，提交前再次走同一 validateDecision；不替用户选择合作结果。每次轮询不重置草稿，仅文明或 turnId 改变才重置。运行中要求先暂停接管，completed 可接管后延长。

我方详情仅展示 VisibleView 的联系人、收到的信息、提案方向和局部观测；没有定位的目标标注“尚无定位”。来信原文保持原内容，不添加全知解释。

`tests/human-decision.test.ts` 4 项覆盖真实字符串目标、所有合法动作/消息组合在最小及最大可负担强度下的成本与引擎合法性、有效合作回复绑定、空消息/真 ID/预算不足拒绝。与通知引擎测试合跑 7/7 通过。独立于 API 的真实浏览器 harness 使用正式面板、StrictMode 和每 300ms 同回合轮询：发展、联络、接受提案的实际点击输出均有效；草稿跨 1.5 秒轮询保留。证据：`output/astra-human-form-browser.txt`、`output/playwright/astra-human-accept.png`、`output/playwright/astra-human-local-info.png`。这些属于作者自测，不代替 root 的正式 App 验收。

## 对 App 的独立只读复核

第一人称模式隐藏全知星图、全局时间线、全局指标、SideContent 与叙事/历史入口；方向键不切换到其他文明。通知只从本文明 VisibleView 的已接收观察生成，无 view 时不回落全局事件。晚到 human 响应校验 runId/epoch/control ID；切换运行、reset 和历史回放清理通知基线。提交后依次完成本轮、准备下一次冻结输入，未输入不伪造 wait。直接 A→B 接管可能瞬时展示旧 view 的问题，root 已在 control 成功后清空 human/civView；Astra 已只读复核关闭。上述限定范围无未关闭 P0/P1。

root 报告正式 App 已实际广播 T1、发展 T2、自动准备 T3，刷新恢复 controlled civ1/pending T3，零调用且 source=human；付费混合小烟测另见 `output/human-real-validation.json`（4 请求，human attempts=0）。本段引用 root 的集成证据，不声称由 Astra 再次执行这些服务端请求。

## 验收边界

- P0/P1：root 正在独立集成验收作者实现；Astra 正在收口只读 App/3D 审查。
- P2：真实移动端触摸、长期等待、跨标签并发不在本次作者浏览器 harness 的证明范围内。
- 无需用户提供密钥或追加付费验证。
