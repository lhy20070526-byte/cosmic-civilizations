# 宇宙文明推演器实现契约

唯一类型真源是 `src/shared/types.ts`。服务端负责物理、知识边界、决策校验、成本、PRNG、快照；React 负责展示、单 tick 调度与历史只读查看。浏览器绝不持有 API key。

## 模块边界

- `server/engine.ts`：seed PRNG、初始世界、白名单 `VisibleView`、物理和原子提交、确定性规则回退。
- `server/llm.ts`：环境配置、真实请求、JSON schema 校验、共享至多一次修复或网络重试、超时与并发限制。
- `server/index.ts`：run store、每 run 互斥、API、导入导出、generation 失效控制。
- `server/narrative.ts`：从已提交事件生成事实卡，模型仅选择和组织事实卡，输出引用校验及明确模板标识。
- `src/App.tsx`：创建、运行、暂停、恢复、显式混合回退、续跑、宇宙/文明/事件/叙事/历史视图。

## API

`GET /api/config` → ConfigResponse。`POST /api/runs` + CreateRunRequest → PublicRun。

`GET /api/runs/:id`、`POST /api/runs/:id/step|pause|resume` → PublicRun。

`POST /api/runs/:id/fallback` + FallbackRequest、`POST /api/runs/:id/extend` + ExtendRequest、`POST /api/runs/:id/narrative` + NarrativeRequest → PublicRun。

`GET /api/runs/:id/export` → Snapshot；`POST /api/import` + Snapshot → PublicRun。错误 HTTP 4xx/5xx + ApiError；需要保留的暂停状态可附 run。

默认 12 文明、每段 30 tick；文明 2–50，每段 1–50；`maxTicks` 是全局期限，`segmentEnd` 是本次运行暂停点，续跑只能递增。Decision 统一为 action/target/intensity/budget/message/reason/beliefUpdates；message={kind,replyTo,text}|null。mode=llm/offline/mixed，source=llm/rules/template。requestLimit 默认 500，failurePolicy=pause/auto-fallback。默认真实 LLM；缺配置返回明确错误，不伪装模板输出。模板及混合模式均显式标识。

## tick 事务与恢复

1. 在 run 互斥锁内复制已提交世界和 PRNG，冻结物理输入；该 tick 到期飞行器全部收集后按同一冻结状态批量结算。攻击来自已经死亡的文明仍有效，同刻伤害聚合后决定死亡。通信/攻击最小延迟 1。
2. 结算资源生产（来源有限且有上限）、合作、观测后，形成 `pendingTick.physicalWorld` 和 `rngState`；从此不再重复物理。
3. 对存活文明构建第二次冻结的 VisibleView，模型仅收到该白名单对象，不传 civilizationId、contactMap、siteMap、任何绝对真坐标、真目标名；self 同样不包含 position。未知目标使用本地 contactId/siteId；估计坐标必须是带误差观测。
4. 并发获取每文明一次 decision。JSON schema `additionalProperties:false`；再校验本地目标、可用资源/成本、合作权限等。每成功响应即写 pendingTick，失败暂停，resume 只补缺失项。修复与网络重试共用单个重试预算。
5. 按稳定文明顺序预留成本；所有决策基于冻结视图批量应用至临时世界，资源不足明确拒绝，不允许负数或部分写回。最后一次替换 world/rngState/history，清 pendingTick。暂停、重置后的 generation 不符则旧请求不能提交。

合作仅由明确 propose/accept/reject/expiry 状态机驱动；接受必须经延迟消息达到发起者后才成立。双方出资进入 escrow，奖励总量与库存/上限绑定，禁止凭消息凭空无限增殖。攻击可受防御减伤并造成非致死 health 损失。

终局仅为全灭，或单一存活且不存在威胁该存活者的有效在途攻击，或达到全局期限；每段用尽只暂停。历史帧冻结、只读，不可对历史帧调用 step。导入必须版本、结构、checksum 验证，回放只读取存档，零模型请求；含 pendingTick 和 PRNG 的有效快照可显式恢复。

## 叙事约束

从引擎事件创建四层事实卡（universe/civilization/relation/reflection），卡片关联真实事件 ID。LLM 返回卡片顺序/引用，最终展示文本由事实卡组装；不接受自由新增事件、数值、因果或人物动机。每条引用必须存在且属于请求 tick 区间。模板输出标注 source=template，LLM 组织标注 source=llm。occurredTick 与每个观察者 observedTick 分别展示，不将宇宙全知事实冒充文明即时知识。

## 验收关键项

seed + 同一决策序列确定性；同刻互毁；死者在途攻击；非致死伤害；白名单隔离；本地目标拒绝；成本原子性；合作双向与有限收益；失败续跑保留成功请求；pause/generation 无迟到提交；快照损坏拒绝、pending 恢复、零 LLM 历史回放；真实浏览器运行/暂停/续跑/查看/导出导入；无凭据时不声称真实 LLM 验证完成。

快照强制字段为 schemaVersion/engineVersion/runId/seed/config/engineState/eventLog/decisions/narrative/exportCreatedAt/checksum。World 内完整 PRNG 为 rngState={algorithm:mulberry32,state,draws}；pending、历史及 RunState 中对应状态必须一致。事件强制使用 eventId/occurredTick/source/participants/facts/causalEventIds，接收记录使用 observerId/observedTick/sourceEventId。

## 规范化归档与恢复边界

50 文明 × 50 tick 的完整历史会多次引用相同观测、事件、人格和决策视图。持久化与网络使用 `src/shared/archive.ts` 的 `cosmic-dag-v1` 后序 DAG：字符串、数组、对象按 JSON 值去重，节点只引用此前节点。全部观测与历史保留，没有截断回放数据。节点数、深度、逻辑展开量及原型键都有校验。

`exportArchive` 校验码覆盖规范化图，避免为了哈希先展开数百 MB 历史；旧版展开 `Snapshot` 仍可导入。canonical checksum 使用增量 SHA-256，不构建多份巨型字符串。历史捕获在 clone 前排除重复全局事件日志，并共享已经提交的不可变观测记录。

解码后的图仅可读。恢复执行必须经过 `importSnapshot`：它对活动 world、pendingTick、requestLog、config 使用不保留别名的递归复制，历史帧保持只读共享；随后按请求 ID 重连 pending.requests 与 requestLog。同值空数组绝不成为不同文明的共用可变状态。

压力验收使用 `tests/stress.ts`：25 tick 归档恢复后续跑到 50，与独立从头运行比较完整 JSON 语义世界 checksum 和完整 PRNG。测试释放已完成的重复运行引用，但不会删除观测或历史；原生 JS 中 `undefined` 可选字段与 JSON 中省略字段按相同 JSON 语义处理。
