# Upstream sync — 2026-09-26

Reviewed upstream [`5.2.0-r15` through `5.2.1-r21`](https://github.com/V5-Client/V5/compare/5.2.0-r14...5.2.1-r21), inclusive. The reviewed upstream tip is `06d368f018e42fd3e7dc1ebbc84d8fa55903590f`; the offline base is `92fe7f5d719d5779e23480ce40affd5d55048fdd`.

| Upstream release | Ported changes |
| --- | --- |
| `5.2.0-r15`, `5.2.0-r16` | Movement iteration fix and validation of ore-route pathfinder arrays. |
| `5.2.1-r1` | Version-independent registry-name checks for raytracing, snow blocks, gemstone waypoints, stone, and chests. |
| `5.2.1-r2`, `5.2.1-r3` | Lapis mining cost and A/D Crop Macro. |
| `5.2.1-r5` | Auto Conversation message extraction and HideonLeaf detection in Galatea/Moonglade Marsh. |
| `5.2.1-r6`, `5.2.1-r7` | Hybrid pest rewarp mode and configurable post-loadout-swap delay range. |
| `5.2.1-r8` | Cache the formatted TPS value when a sample changes. |
| `5.2.1-r10` | Register background tick/render handlers only when needed, share module lifecycle handlers, and avoid repeated keybind reads during initialization. |
| `5.2.1-r11`, `5.2.1-r14` | Freecam physical movement input and event-based possession clicks, adapted to existing loader APIs. |
| `5.2.1-r12` | Center and widen the macro-toggle panel; reserve and clip category navigation around the settings button. |
| `5.2.1-r13` | Remove the Glowing Mushroom debug message. |
| `5.2.1-r15` | Advance the Bazaar order queue after cancellation instead of repeatedly inspecting a stale target. |
| `5.2.1-r16`, `5.2.1-r19`, `5.2.1-r20` | Mirrorverse Dance Macro, Kloon Hacking Macro with the row-click stability fix, and the Rift category including SunGecko. |

## Offline adaptations

- Apply refueling-handler registration to `MiningUtilsLegacy.js`; retain its Abiphone/NPC fallbacks and GUI retries.
- Keep commission claim-method selection, Royal Pigeon retries, delayed Mismyla responses, reward synchronization, and Limbo recovery delays.
- Keep world-unload context and parent-managed state in the shared module handler. Preserve the GameState-based scheduler and Bazaar's world-unload disable behavior.
- Refresh saved keybind data before writes so the shared handler cannot overwrite keys saved by the GUI, route editor, or other offline helpers.
- Retain offline path rotations, compatibility exports, and the macro-toggle rule that includes all modules with toggle keybinds.

## Deferred or already covered

- Minecraft 26.3 input, packet, SDL/PiP, and generated-typing changes require the corresponding loader migration. Current targets remain 26.1.2/26.2.
- The Linux cursor fix in `5.2.1-r4` is already present (`window.handle()`).
- The `5.2.1-r8`–`r10` HUD/PiP rendering rewrite depends on the upstream Skija pipeline. Keep the offline NanoVG HUD; do not restore MusicOverlay or Discord integration.
- The `5.2.1-r13` scheduler change targets the old upstream scheduler. The offline implementation already preserves remaining session time across recovery and has explicit manual-disconnect/ban handling.
- Upstream version bumps, changelog-only commits (`5.2.1-r17`, `r18`, `r21`), and unrelated formatting are not copied.

Validation: format changed JavaScript with Prettier 3.6.2 and review imports, runtime API compatibility, conflict resolution, and preserved offline behavior. This repository has no build/test runner; follow its guidance not to add or run tests. Minecraft gameplay remains to be verified in the client.
