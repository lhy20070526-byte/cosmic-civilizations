# 连续通信与模型扩展独立验收

日期：2026-10-17。审查者：Astra。初始 3D 范围为只读审查，新增 output/ 下的审计脚本、浏览器 harness、证据与本报告；后续参与的两项服务端修复及交叉复核分工详见追加章节。全程没有调用付费模型。结论：连续通信、八类模型、新人格先验及结局 V2 范围通过；保留明确的 P2 可用性/性能与主观美术边界。

## 本轮发现并关闭

- P1：双星曾与默认中央主球穿插，双星轮廓被遮挡。已移除双星类型的中央主球和表面附件；实际近景可见两颗分离恒星。
- P2：冰星原表面几何完全埋在主球内。已增加外露冰晶轮廓；近景可见，不仅换色。
- P2：居住环舱体与 Torus 使用不同局部平面。实际近景发现悬浮错位；统一为 XY 平面后，64 模型审计中所有舱体中心均落在环中心线上，最终近景确认修复。
- P2：在途 cooperation-result 曾提前在目标端生成通信环。现全部在途环只在发送端；未产生反向粒子、回执事件或已达成合作声明。

## 独立证据

- `npm test`：59/59 通过，完整日志 `output/tests-continuous-independent.txt`。构建由实现方/root 执行；本结论不以构建代替交互验收。
- 直接转译并执行当前真实 `createPlanet`、`disposeObject`：8 类各 8 seed，共 64 模型；所有变换后 mesh 顶点在其包络内，最大顶点半径/包络为 0.99711234；主星/卫星/子星/双星实体球无交叉；80/80 纹理触发 dispose；居住环附件偏离数 0。见 `output/astra-continuous-geometry.json` 和可重跑的 `output/astra-geometry-audit.ts`。
- 真实浏览器独立会话 `astra-review`，固定 T2 引擎离线 fixture，12 条真实在途、82 个补充粒子。harness 使用当前正式 Universe3D 组件并启用 StrictMode，只读 fixture，无 step 或模型请求。
- 同一 T2 持续运行 3.6 秒：visual elapsed 从 12039 到 15663；超过 3 秒后两张 canvas 截图粒子位置继续变化，已实际审看。没有靠推进物理轮次伪装持续运动。
- 暂停 700ms：elapsed 15688 保持不变，canvas 两次截图字节完全一致。恢复约 50ms 后仅增加 42ms，未计入暂停时长；之后继续增加。
- 减少动态 650ms：elapsed 16013 保持不变。1×和 4×分别观察约 500ms，视觉时钟增量 509/2033ms，倍率正确。
- 逐类直接执行真实 `lineForTransit`：六类通信均为 from→to 单向，所有在途通信环均位于 source；attack/warning/salvage 的循环粒子数均为 0。证据 `output/astra-transit-audit.json`。
- 信号仅来自真实在途列表，流动方向 from→to，视觉粒子数不写入引擎。attack/salvage 仍使用原单次 physicsU；环境/预警不纳入通信循环。物理到达时间、事件、成本和可见视图不变。
- 实际审看八类全景，以及冰星、站群、双星、居住环近景。类别由确定性 seed 选择，新增的是不同网格结构，不仅颜色。全景模型相对较小、标签突出仍为视觉取舍。
- 正式 App 实际点击 T5 历史帧：24 条当时在途，视觉时钟 0→0，间隔 500ms 两张 canvas 像素完全一致；running 条件仍要求 `!isReplay`，历史状态没有被视觉时钟修改。完整 App 新一轮追加 UI 会在冻结后单独复核。

浏览器数值证据：`output/astra-continuous-browser.json`。截图：

- `output/playwright/astra-flow-after-3s-a.png`、`astra-flow-after-3s-b.png`
- `output/playwright/astra-model-gallery.png`
- `output/playwright/astra-model-civ-2.png`（冰晶）、`astra-model-civ-5.png`（站群）、`astra-model-civ-6.png`（双星）
- `output/playwright/astra-habitat-closeup.png`（修前反例）、`astra-habitat-fixed.png`（修后）

## 边界与待办

- P0/P1：上述展示改动无未关闭阻断项。
- P2，可自动推进：最大 50 文明长时间浏览器帧率/GPU 内存、低端手机专项；本轮未测，不宣称性能已通过。
- P2，需用户审看：程序化八类模型的艺术风格和大小是否符合期待。几何类别齐全不等于主观美术已获认可。
- 本轮没有更改或续跑原 385 请求真实运行，没有部署或公开发布。

## 新人格先验追加复核

只读检查 `src/server/persona.ts` 与 runtime 接线，独立人格测试 1/1 通过。输入仅 seed、ordinal、人格动机/风险/信任取向与边界说明，没有世界真值；不命令战争、合作或结局。success/fallback 请求跳过逻辑仍在，已生成人格不重写。严格说是“今后生成的人格”生效，也包括旧 run 中尚未成功的人格请求；未调用真实模型验证，因此不声称真实策略分布已改变。

另直接读取两份已完成真实存档：每份 360 个决策均无 strike，6 次环境事件均未波及文明，全部健康 100。当前全存活的直接原因是无攻击且无环境波及，不能归因为已发生攻击全部无效。详见 `output/astra-survival-audit.json`。本轮未更改物理规则或离线选择概率。

## 结局叙事 V2 与恢复追加验收

追加范围已经复核通过。实际实现分工需区分：Astra 独立审查并复验了 Luna 的 V2 卡片/页面、版本兼容以及 root 的单文明在途威胁结束判断；Astra 自己实施了 completed-cancel 状态修复及 endingRefs 直接证据补齐，这两项由 root 另行读代码复核，不冒称自我独立验收。

发现并关闭的具体问题：

- 纯环境灭亡被误写为全部存活；混合环境+攻击损伤被单独归因攻击。现分别按因果分类，混合损伤与灭亡明确不可拆分。
- V2 历史回验带入未来 history/observation 和新 segmentEnd。真实离线 T3 完成→延长至 T6→导入曾失败；修后两份叙事恢复，T3 文字保持不变。
- 旧已成功但尚未落入 narratives 的模型响应使用旧 factIds；现在识别旧版本直接恢复 factVersion1，测试阻止 fetch 并确认零重复请求。
- accepted 待结算遗漏、未发生 settlesAt 混入叙事发生区间、终局仍提示延长已修。最后一个文明仍有在途威胁时，叙事复用引擎 evaluateEnd，保留阶段可续状态。
- completed 运行在浏览器 reset/离开时被 cancel 改为 paused。现保留 completed 和终局事实，同时 generation 失效晚响应；completed 取消和 extend 清旧 stopRequests。测试证明 world/history/narratives/requestLog/预算不变，并可正常延长，不会新段意外暂停。
- 结局正数汇总补齐攻击发射、全部冲击、灭亡、环境及合作结果事件的直接引用。

正式回归文件：`tests/narrative-regression.test.ts`、`tests/completed-cancel.test.ts`；另独立执行 root 的 `tests/narrative-threat.test.ts`。定向取消/暂停/服务器/叙事 15 项通过，追加威胁边界与相关回归 7 项通过。直接调用 templateNarrative(midrun) 的辅助函数反例不计入产品阻断：正式 runtime.narrate 已要求 completed。

独立真实浏览器使用 `output/ending-updated-real-snapshot.json` 的只读数据替换当前会话 GET 响应，并拦截全部非 GET 请求；不会取消、修改或为用户真实 run 发起模型请求。使用正式 App 组件，验证：

- 新真实叙事为第 0—30 轮、21 张事实卡，旧 73 卡叙事仍保留。
- 实际展开其余 6 个文明完整事实卡；关系按明确方向呈现联络、提案、同意、拒绝、结算和接收。
- 结局显示 12/12 存活、0 攻击、0 攻击相关损伤、3 在途、2 待处理，与输入事实一致；没有把全存活自动写成永久和平。
- 点击关系依据 event-38，详情显示 T1、contact、cost3，引用正确。桌面长页中详情位于页面上方，点击后可能需回到上方查看，这是 P2 可用性限制，非数据错误。
- 390×844 实际审看结局与推测，正文可读，documentWidth=390；已恢复 1440×900。
- 最终模型标签移到包络下方，已审看 `astra-final-label-closeup.png`；特写下标签可能接近画布边缘，侧栏继续显示身份，属于展示取舍。

截图：`output/playwright/astra-v2-expanded-facts.png`、`astra-v2-relations.png`、`astra-v2-evidence.png`、`astra-v2-mobile-ending.png`。真实付费验证由 root 完成，见 `output/ending-real-validation.json`；本次独立审查没有产生付费请求。

最终全量独立执行 `npm test`：**70/70 通过**（`output/tests-continuous-final-independent.txt`）。类型检查 `npx tsc --noEmit` 通过。没有将这些结果替代上面的真实浏览器交互与截图审看。

## 最后追加：导入后的本机恢复指针

已只读审查最后的 `restoreSnapshot`、`persistRunSnapshot`、`generateNarrative` 修改，未再次修改源码或发请求。原问题是导入后仅切换页面运行，没有更新 IndexedDB 的 latest-v1，刷新仍可能找到另一份旧运行。新流程先增加 epoch/pauseNonce、清理调度和轮询；导入成功后同步采用新 run 与 runRef，再等待服务端 export 的完整快照写入 IndexedDB。保存事务 oncomplete 后才显示已保存；旧轮询/请求通过 epoch 与 run ID 检查被拒绝应用。叙事响应成功应用后也执行相同持久化流程。此项代码收口审查通过；跨 run 导入→刷新→reset completed→重新导入真实运行→刷新由 root 在真实浏览器执行，本追加不冒称独立重复了该路径，也不沿用此前 70 测试作为新增浏览器持久化证据。

P2 通知边界已告知 root：叙事 API 可以 HTTP 200 返回 narrativeError，生成成功提示应与该字段一致；该边界不影响已验证的真实成功路径和导入保存修复。

## 十二主体与五档结构变体追加独立验收

12 类主体已按稳定文明 ordinal 分配，默认 12 个不重复；50 文明使用 12 类及 0—4 档结构变化。审查发现并由 scene 修复：variant % 3 导致结构重复、mesh cache 未包含 profile 导致旧 mesh 与新包络/HUD 错配。最终实际构造 480 个模型（12 类×5 变体×8 个分散种子），每类固定种子有 5 个不同几何结构，0 包络越界、0 独立球体重叠、环舱中心均处于环平面，480 张纹理均释放。默认 12 样例 205 meshes / 70576 triangles；50 样例 1071 meshes / 324600 triangles / 48 textures，预留 1.14 选中缩放后的最小间隔 2.4001。证据：`output/astra-distinct-geometry-audit.ts`、`output/astra-distinct-geometry.json`。目录/布局定向测试独立执行 8/8 通过；root 最终全量 72/72 结果另存，不冒称本人重复全量。

正式 Universe3D 组件在独立 StrictMode 浏览器、纯离线只读 harness 验证：默认 12 个主体可区分；环带舱、站群、空心港的方块改为圆柱舱、锥头和接驳环；Dyson 改为薄面板。最终已实际操作选择/靠近、纵览，并审看 `astra-twelve-final.png` 与 `astra-rounded-civ-4/5/10/12.png`。camera-space depth fit 取代 2.4 倍缩远，标签以缓存真实 Box3 底部定位；实际 mesh、HUD、布局均使用同一 profile，死亡文明保留 slot。

P2 限制：特写时选中标签仍可能在画布下方，背景文明标签也可能投影到前景主体；50 全景标签密集，需选中查看。艺术风格是否符合偏好仍由用户审看。50 文明旧造型短样本 RAF 平均 8.36ms / P95 9.1ms，暂停 700ms pixels 一致；最终圆柱舱增加 meshes 后未重复该性能样本，因此不宣称最终 50 文明性能或低端移动端长期稳定已验。此项检查未请求模型、未推进或更改用户真实运行。

## 人工接管版本：连续动效与相机追加独立复核

独立审查 scene 的稳定依赖、视觉时钟、相机平移代码。onSelect 使用 ref，事件/在途依赖采用稳定内容 key；通信 elapsed 不随普通 render 或物理 tick 重置。暂停与减少动态只重置上帧时间，恢复不追赶暂停期间的墙钟时间。平移/旋转交由 OrbitControls，拖动阈值避免误选。

在正式 Universe3D、StrictMode、独立离线 fixture 的真实浏览器中实际操作：固定 T2 等待 3.6 秒，通信 elapsed 前进 3733ms 且 canvas 像素变化；暂停 700ms elapsed 与 canvas 完全一致；恢复 100ms 仅前进 83ms。左键平移后相机从 (-0.39,40.79,49.60) 到 (-5.69,40.79,49.60)，旋转后到 (-43.39,40.79,38.22)，两次拖动均未误选文明。截图已实际审看。

进一步每 300ms 深复制 world 模拟状态轮询，elapsed 仍连续前进；使用真实 prepareTick/applyDecisions 在内存把 T2 推至 T3 后 elapsed 18346→19546 持续推进，没有归零。保持该轮询时暂停与 reduced-motion 两种模式均经 700ms canvas 像素相等验证。证据 `output/astra-human-revision-motion.json`、`output/playwright/astra-human-revision-motion.png`；只修改 output 测试 harness，零 API/模型请求，未推进服务端原 fixture 或用户 run。

本次动效/鼠标相机范围没有未关闭 P0/P1。实体手机多指手势、50 文明长期 GPU/内存仍未测。人工面板与后端由 Astra 实施、root 独立验收，分工与证据见 `HUMAN_CONTROL_IMPLEMENTATION.md`，不把作者自测混作本报告的独立验收。
