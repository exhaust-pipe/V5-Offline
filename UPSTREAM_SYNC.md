# Upstream sync — 2026-10-02

Ported selected changes from upstream [`5.2.1-r22` through `5.2.2-r2`](https://github.com/V5-Client/V5/compare/5.2.1-r21...5.2.2-r2), inclusive, onto `dev` at `71ed7ac4226352871edd13510250f9714adc1932`. The reviewed upstream tip is `ab6117aae1b3e2704c9f97e50b9fff3ea9e1d4f9`.

| Upstream release | Ported changes |
| --- | --- |
| `5.2.1-r22`, `r23` | Scribe Nuker, its excluded coal-block region, and scoreboard/Rift sub-area detection. |
| `5.2.1-r24` | Vanilla block-breaking mode and Agaricus Cap Triggerbot. |
| `5.2.1-r25` | Auto Chest scans nearby blocks on ticks and works independently of block-entity rendering. |
| `5.2.1-r27` | Path completion no longer blacklists caller-managed external combat targets. |
| `5.2.1-r30` | Resolve matching armor-stand nametags to nearby mob hitboxes; reject ordinary player targets; add powered-creeper Ghost support. |
| `5.2.1-r31` | Auto-Perspective selects back/front third person or Freelook, Precision Miner targets particles without an added pitch offset, and mining can use the shared rotation speed. |
| `5.2.1-r31`, `5.2.2-r2` | Structure ESP uses the new Loader cache API, configurable structure filters, and batch rendering. The upstream developer-mode registration guard remains in place. |

## Offline adaptations

- Keep the existing commission recovery, NPC/Pigeon claim handling, scheduler, offline GUI, combat travel clicks, roaming, pitch variation, escalating blacklist delays, and `findMob` whitelist argument.
- Keep Hypixel as the default Nuker mode. Vanilla mining tracks block damage, sends stop/abort packets, and cancels on disable, mode change, chest solving, GUI/manual attack, invalid/replaced targets, or world/game unload. Delayed break packets are discarded after a world change.
- New Rift helpers guard world availability, GUI state, and the Rift area. Preserve the existing `NukerUtils` compatibility export and Minecraft 26.1.2/26.2 packet constructors.
- Keep the independent Mining Rotation Speed setting and its saved values. `Use Global Rotation Speed` is opt-in and defaults off.
- Migrate an old enabled Auto-Perspective boolean to Third Person Back. Restore the original camera perspective when a macro stops, including after a temporary Freecam/Freelook session; stop only Freelook enabled by the controller.
- Copy the Loader's freshly generated typings without manual changes. Install both `dev` updates together because the StructureFinder API changed.

## Deferred or already covered

- Keep Tree ESP enabled as before; do not copy upstream's blanket disablement.
- Living Metal remains deferred because upstream leaves its import disabled. MusicOverlay/Discord changes remain inapplicable to the offline fork.
- Skip upstream version-only changes, broad formatting/renaming, and wholesale Commission/SunGecko rewrites. Preserve the existing 26.1.2/26.2 particle API instead of copying 26.3-specific helpers.

## Validation

- All changed JavaScript passed Prettier 3.6.2 formatting checks. Reviewed imports, lifecycle cancellation, legacy settings, and retained offline behavior.
- Verified the new Creeper, AABB distance, and block-breaking APIs in both Minecraft target JARs. The companion Loader builds for both targets and generates the matching typings.
- The existing `.github/scripts/build-package.py` produced a 211-file script ZIP including both new Rift modules and the updated Structure ESP/Nuker APIs.
- This repository has no automated test runner; none was added or run. Rift interactions, Vanilla mining, combat targeting, chest handling, camera transitions, and Structure ESP still require in-game validation.

---

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
