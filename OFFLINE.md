# V5 本地脚本版

配套 **V5 Offline / Minecraft Java 26.1.2**，无需 requestV2、WebSocket、Discord 或 V5 账号。

将本目录内容手动放到游戏工作目录的 `config/ChatTriggers/modules/V5/`。确认文件是 `V5/loader.js` 和 `V5/metadata.json`，不要再多套一层 `V5script/`。使用新模块目录，不要覆盖混合旧在线版文件。启动游戏后 `/v5` 打开 GUI，`/ct load` 重新读取本地脚本；含动态 mixin 的改动需要重启。

- 后端认证、IRC、WebSocket、Webhook、Discord RPC、截图/封禁数据上报、音乐助手下载/运行及 Mojang token 读取已移除。
- GUI 原 Discord 入口改为 **Client**，保留本地 GUI 缩放、滚动速度和点击音设置。
- 物品与 Bazaar 行情只通过加载器的固定 Hypixel 公共接口读取，不传用户名、UUID 或账号令牌。数据缓存在 `V5Config/public-data/`，断网可继续使用已有缓存，价格可能过期。首次启动无缓存时相关数据显示不可用。
- 自定义显示名不再读取旧 AuthCache 文件。
- 桌面通知改为本地游戏消息。错误和调试信息写入 `logs/latest.log`。
- 更新方式始终是手动替换本地文件，developerMode 只控制实验性功能的显示。

用户扩展脚本仍可以手动添加至 `V5Config/UserScripts/`。这些脚本具有 Java 互操作能力，应只使用自己检查过的代码；本版本不是运行任意恶意脚本的沙箱。

本次成品包含 Windows x86_64 寻路 DLL，需要 Java 25、Fabric Loader 0.19.3、Fabric API 0.153.0+26.1.2、Fabric Language Kotlin 1.13.9+kotlin.2.3.10。完整联网边界、构建与安装说明见配套 Loader 仓库的 `OFFLINE.md`。

保留上游版权与 GPL-3.0 许可。
