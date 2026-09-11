# V5 Offline Scripts

配套本地静态版 V5 Loader。安装与使用请先阅读 [OFFLINE.md](OFFLINE.md)。始终手动安装和更新脚本，不再依赖 requestV2、WebSocket 或后端账号。

以下为保留的上游项目背景与许可说明；自动更新相关说明不适用于此版本。

## Upstream Developer README

General users should use the public docs:
https://rdbt.top/docs/getting-started

The rest of this README is for developers and contributors.

## License Summary

This project is licensed under **GNU GPL v3.0**. In short:

1. Anyone can copy, modify, and distribute this software.
2. Every distribution must include the license text and existing copyright notices.
3. You can use this software privately.
4. If you distribute modified versions, you must provide the complete source code under GPL-3.0.

- This means that any forks/copies/clones must have the source code freely available.

## Repositories

V5 is split across two repositories:

- **Fabric mod (V5Loader):** https://github.com/V5-Client/V5Loader  
  Contains the technical client internals (rendering, pathfinding, ChatTriggers JavaScript engine).
- **JavaScript module (V5):** https://github.com/V5-Client/V5  
  Contains macros/scripts used by the client.

## Working on the JavaScript Module ([V5](https://github.com/V5-Client/V5))

1. In-game, run `/V5 developerMode true`.
   This disables auto-updater behavior so your local edits are not overwritten.~
2. You are able to git clone into modules folder for ease of use.
3. After making code changes, run `/ct load` to reload immediately.
4. Use `/ct console` to view the JavaScript console.

More detailed contributor docs may be added in the future.
