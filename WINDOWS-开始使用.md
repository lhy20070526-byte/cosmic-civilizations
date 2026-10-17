# Windows 源码包：宇宙文明推演器

本包保留 React + TypeScript 前端、Node.js 服务端、推演引擎、测试、开发脚本、设计与交接记录。源码无需转换成 exe；用 VS Code 或其他文本编辑器打开整个文件夹即可编辑。

## 首次启动

1. 把整个 ZIP 解压到本地目录，例如 `C:\Projects\cosmic-civilizations`。不要在 ZIP 预览内直接启动。
2. 安装带 npm 的 Node.js 24（https://nodejs.org/）。脚本最低接受 Node.js 22；本次验证使用 macOS Node.js 24.19.0，没有 Windows 实机。
3. 双击 `START-WINDOWS.cmd`。首次联网安装锁文件依赖，然后构建并启动服务。
4. 看到服务启动提示后，打开 http://127.0.0.1:4321 。保持命令行窗口打开，停止时按 Ctrl+C。
5. 没有 API 密钥时选择“离线规则”。新电脑上的模型需要重新配置和验证，不继承旧电脑的已验证状态。

开发修改：双击 `DEV-WINDOWS.cmd`，打开 http://127.0.0.1:4330 ，编辑 `src/` 后自动刷新。不要同时运行两个启动脚本，它们共用 4321 端口。双击 `TEST-WINDOWS.cmd` 运行回归测试，测试默认不发送真实模型请求。

## API 配置

脚本只在 `.env` 不存在时复制空密钥模板 `.env.example`，不会覆盖已有配置。用文本编辑器在本机 `.env` 填入 `LLM_API_KEY`，并核对 provider/protocol/base URL/model，再重启服务。不要把密钥填到网页、聊天、`VITE_*` 或提交到代码仓库。当前模板非敏感参数来自原项目，接收者应使用自己账号可用的准确模型。

默认请求上限 500，不自动提高；12 文明 × 100 轮约 1213 次基础调用，可能因配额暂停。离线模式不需要 API。`scripts/verify-human-llm.ts`、`verify-ending-update.ts` 等真实模型验收脚本可能消耗额度，不在启动和普通测试中自动执行。

## 命令行与目录

PowerShell 中使用 `npm.cmd` 可避免 npm.ps1 的脚本执行策略问题，无需放宽系统安全设置：

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd start
# 开发模式替代上一条：npm.cmd run dev
```

- `src/ui/`：界面、三维场景、交互。
- `src/engine/`：确定性推演规则。
- `src/server/`：本地 API、真实模型请求、叙事与存档。
- `src/shared/`：数据类型和存档编码。
- `tests/`、`scripts/`：回归测试及维护/验收工具。
- `output/`：精选验证证据、QA 辅助源码、必要的旧版兼容回归存档。旧验收脚本可能引用原电脑特定 run ID 或未随包附带的历史文件，不能直接视为通用启动入口。
- `PACKAGE-MANIFEST.json`：包内文件大小与 SHA-256，可核对完整性。

本包不携带 `.env`、`.local`、浏览器用户目录、node_modules、临时下载或完整私人运行历史。旧版回归存档是模拟数据，用于保证 npm test 能运行；不是新电脑的已验证模型状态。需要迁移自己的推演时，在原应用导出 JSON，再在 Windows 导入。Markdown 是阅读报告，JSON 才能恢复。运行中关闭程序会中断当前请求，成功记录与恢复以已保存检查点为准。

## 故障与验证边界

首次安装依赖需要联网。不要禁用 TLS 校验或更改系统安全策略来解决安装失败。端口占用时先关闭此前启动的本项目窗口。服务启动后浏览器一直等待时查看命令行错误；不要直接双击 `index.html`。

本次在全新解压副本中重新安装依赖、运行测试和构建，并做本地服务 HTTP 检查；实际结果见 `WINDOWS-PACKAGE-VALIDATION.md`。没有 Windows 虚拟机或实体机，因此不宣称 `.cmd` 在真实 Windows 已完成验收。美术、性能及真实模型长跑的已知限制见 README/HANDOFF。
