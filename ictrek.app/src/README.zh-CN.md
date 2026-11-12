# V-Note

V-Note 是运行在 VOS 上的 AI 知识库与笔记工作区，基于 EdgeEver 适配。

## 使用

- 从 VOS 应用抽屉打开 V-Note，使用当前 VOS 用户自动登录。
- 界面语言设为“跟随系统 (VOS)”时跟随平台语言；也可在设置中手动选择语言。
- 每位 VOS 用户拥有独立的笔记空间；VOS 管理员可管理实例用户和存储，但不会看到其他用户的笔记。
- 支持笔记、附件、全文搜索、模板、AI BYOK 和 MCP/API Token。
- 匿名公开分享、整本笔记本发布和公开收集表单在 VOS 版中关闭。
- 新用户不会自动获得上游示例笔记；已有示例笔记会保留，其中介绍公开发布的内容不适用于 VOS 版。

## AI

在设置中配置可访问的 OpenAI 兼容模型端点。本应用不强制依赖 V-Scheduler，也不内置模型；
V-Scheduler 的接入地址和浏览器访问方式需要根据实际部署确认。

## 数据与恢复

- 数据保存在应用存储目录的 `data/` 下，卸载时请选择保留数据。
- 建议定期使用应用内“导入与导出”生成 ZIP 备份。
- 如需本地应急管理员，在安装配置中设置 `VNOTE_BREAK_GLASS_PASSWORD`，然后打开
  `/app/com.ictrek.v-note/?local=1`；正常使用不需要该入口。

## MCP 与手机客户端

从 VOS 应用抽屉的 V-Note 分组打开「API 接入指南」，也可以从「个人中心 → API / MCP → API 接入指南」进入。网关 MCP 地址为 `https://<VOS 主机>:1180/app/com.ictrek.v-note/mcp`，使用 V-Note Bearer API Token。安装包已将局域网 HTTP 端口 `22710` 映射到容器 `8787`。普通 VOS 用户可进入「个人中心 → 连接原生 App」，将显示的服务器地址、用户名和一次性配对码填入 EdgeEver 的服务器地址、用户名、密码栏。登录后同步原有的 VOS 工作区。配对码五分钟内仅可使用一次，无需另配端口。完整下载与操作步骤、排错和 API 契约见内置指南。

## 来源

本应用基于 EdgeEver（AGPL-3.0）适配，公开 fork 为 https://github.com/ictrektech/v-note。
