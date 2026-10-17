# Windows 源码包验证（2026-10-17）

- 干净副本：重新 npm ci 成功，135 个依赖包安装完成；没有复用原项目 node_modules。
- Node.js v24.19.0 / macOS：npm test 88/88；npm run build 成功。构建保留原有大于500kB的bundle提醒。
- 干净副本服务（独立端口4341）：首页200、JS资源200；模型 configured=false；没有调用外部模型。
- cmd脚本采用CRLF、ASCII文件名、引用目录路径和npm.cmd；不需要放宽PowerShell执行策略。测试文件由Node枚举，不依赖cmd.exe展开通配符。
- 包含全部 src/tests/scripts 源码、根项目配置、锁文件、文档、模型协作记录、QA辅助源码和精选验证证据；旧版叙事兼容测试所需模拟存档随包提供。
- 排除 .env/.local/.playwright-cli/node_modules/dist/完整运行历史；模板密钥为空。结构化JSON敏感字段与常见密钥格式扫描通过。
- Windows原生CMD、Windows Node依赖安装和实际浏览器未在Windows机器上验证；macOS检查不能代替Windows实测。
- 包内SHA-256清单位于PACKAGE-MANIFEST.json；ZIP校验记录位于下载目录同名.sha256文件。

首次使用读 WINDOWS-开始使用.md。用户已有Mac项目及运行数据未移动、删除或覆盖。
