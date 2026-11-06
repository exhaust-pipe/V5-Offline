# Failsafe macro callbacks

Macros can override `ModuleBase.onFailsafeTrigger(event)` to receive the reason for a failsafe detection. `FailsafeUtils.reportTrigger(...)` first applies the existing intensity update, then sends the event through `MacroState.notifyFailsafeTrigger(event)`.

The existing `onFailsafeIntensity(delta)` callback, intensity values, decay, and **Notify Macro Intensity** setting retain their behavior. Trigger events are delivered even when that setting is off or the event adds zero intensity. Do not add `event.intensity` to a counter already updated by `onFailsafeIntensity`, or the increase will be counted twice.

Both callbacks only reach enabled macros that do not set `ignoreFailsafes`. A failing callback is logged without interrupting delivery to other macros. The event and its flat `details` object are frozen so one macro cannot change the data received by another.

| Field       | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `type`      | Detector name from the table below; use this to select a handler.          |
| `reason`    | Human-readable reason without chat formatting.                             |
| `intensity` | Non-negative intensity added by this detection, not the accumulated total. |
| `timestamp` | Time the detection is reported, in Unix milliseconds.                      |
| `details`   | Detector-specific data captured for this detection.                        |

| `type`         | `details`                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Chat Mention` | `blockedWord`, `fullMessage`, `isHigh`                                                                               |
| `Player Grief` | `kind` (`inside` or `nearby`), `playerId` (UUID), `playerName`, `distance` in blocks                                 |
| `Rotation`     | `fromYaw`, `fromPitch`, `toYaw`, `toPitch`, `yawDiff`, `pitchDiff`, `totalRotation` in degrees                       |
| `Slot Change`  | `fromSlot`, `toSlot` (1-based hotbar slots)                                                                          |
| `TP`           | `isNullPacket`, `toX`, `toY`, `toZ`; ordinary teleports also include `fromX`, `fromY`, `fromZ`, `distance` in blocks |
| `Velocity`     | `speed` (the magnitude used by the detector)                                                                         |

Null teleport packets produce an informational `TP` event with `intensity: 0` and `details.isNullPacket: true`. They do not increase intensity or invoke `onFailsafeIntensity`.

For example, a macro can record the latest reason while keeping its existing intensity handler:

```js
class MyMacro extends ModuleBase {
    onFailsafeTrigger(event) {
        this.lastFailsafeTrigger = event;
    }
}
```
