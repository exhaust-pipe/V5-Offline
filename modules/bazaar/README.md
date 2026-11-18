# Bazaar macros

这两个 macro 位于 Bazaar 分类，需要 Cookie Buff 的远程 Bazaar 权限、相应的 sacks，以及 `/viewstash material`。点击和输入分别使用随机延时，默认均为 250–450 ms。界面超时或发现物品栏 / sacks 已满时停止，不会自动重试下单。

获取 Hypixel Bazaar / 物品数据失败、返回数据无效或请求超过 25 秒时，采用与 Bazaar to NPC 相同的等待规则：每次随机等待 30–60 秒，最多重试 3 次，聊天和状态栏显示等待时间及次数。成功后继续取数前的流程，下次取数重新计算重试次数；连续 3 次重试仍失败才停止。等待期间保留订单、领取和清理状态，关闭 macro 会取消待执行的重试，过期请求的返回结果也不会恢复操作。

## Buy Order to Sacks

- 未完成的买单通过左键领取。物品栏收到该物品后，打开 `/sacks` 并点击 `Insert inventory`，确认转走后继续。
- 撤单时若 Bazaar 提示 `[Bazaar] You have goods to claim on this order!`，会重新打开订单列表，领取该单的新成交部分，再撤销剩余数量。只退还金币的买单会跳过 sacks 和 stash。
- 已完成的买单通过 `Order options` 中的 `Flip Order` 转成临时卖单，价格取 Hypixel Bazaar API 的 `buy_summary` 最低价的 120%，四舍五入到一位小数。撤销临时卖单时若已有成交，会先领取销售款。若物品栏已收到整笔卖单的物品，会直接存入 sacks。可能还有物品在 stash 时，先通过 `/viewstash material` 的 `Insert Into Sacks` 转移，再将实际进入物品栏的部分存入 sacks。中断后会继续尚未完成的转移。
- 只操作匹配名单的 BUY 订单；SELL 订单只会处理本次流程创建且按名称、价格、数量核对的临时卖单。已有完全相同的卖单时停止，避免无法区分。
- 白名单为空时领取所有订单；黑名单优先。GUI 名单使用逗号分隔的完整物品名或 SkyBlock ID，不区分大小写。
- 每个订单槽位独立扫描，同名订单不会合并或跳过。等待菜单和订单内容稳定后再操作，结束前重新打开订单菜单复查。数量、单价完整且没有领取提示的订单视为当前无可领取物品，包括只显示成交百分比或暂不显示成交数量的订单；明确的无物品可领取提示也会正常跳过。独立运行时复查无可领取订单后正常结束，由 Gemstone Flip 调用时继续检查和等待。其余无法确认领取状态的订单仍会报错停止。
- 中途停止后，在同一次脚本运行中保留未完成的物品栏、临时卖单和 stash 转移状态；重新启动时先恢复这些转移。恢复时名单必须包含相应物品。

其它 macro 可以调用导出的单例。调用方应暂停自己的 GUI 操作，并在关闭时取消它启动的领取任务：

```js
import { buyOrderToSacks } from './BuyOrderToSacks';

const started = buyOrderToSacks.start(
    {
        whitelist: ['FLAWED_AMETHYST_GEM', 'Fine Ruby Gemstone'],
        blacklist: [],
        filledOnly: true,
        cancelOrders: false,
        clickDelayRange: { low: 250, high: 450 },
        inputDelayRange: { low: 250, high: 450 },
    },
    (result) => {
        if (!result.success) {
            // A full sack or interrupted transfer must stop the caller too.
            this.fail(result.reason);
            return;
        }
        this.resume();
    }
);

if (!started) this.fail('Buy Order to Sacks is busy.');
```

接口中的 `whitelist: null` 或省略名单表示所有物品，`whitelist: []` 表示不领取任何物品。名单接受数组或 Set。`filledOnly` 默认为 `false`；`cancelOrders: true` 会领取并取消匹配的购买订单（优先于 `filledOnly`），用于清理或重挂。回调返回 `success`、失败时的 `reason`、最新 `orders`，以及成功时的 `cancelledOrders`（包含未成交数量 `remaining`）。`start` 在忙碌时返回 `false`，不会接管已有任务。`cancel()` 停止当前领取任务并回调失败。

重挂时可同时传入 `cancelBelowPrice`，只取消单价低于该价格的订单。配合 `filledOnly: true` 时，只领取完全成交订单和需要取消的低价订单，同名但未被超价的未满订单会保留。

## Gemstone Flip

支持 Amber、Amethyst、Jade、Jasper、Ruby、Sapphire、Topaz、Opal、Aquamarine、Citrine、Onyx、Peridot 共 12 种宝石；只包含 Rough、Flawed、Fine、Flawless。

- `Specify Gemstone Types` 默认关闭，允许全部种类；打开后通过二级 `Gemstone Types` 设置各类开关。
- Rough 默认关闭，其余三档默认开启；不包含 Perfect。
- `Minimum Profit (%)` 默认 5%，按 `(NPC 售价 − 买单单价) / NPC 售价` 计算，和 Bazaar to NPC 相同。
- `Order Limit` 默认 14，可设置 14–28，计入已有的其它买卖订单。`Maximum Order Spend (M)` 默认 5。单笔数量按近一周成交量折算的半小时成交量（`sellMovingWeek / (7 × 24 × 2)`，向下取整）估算，Flawless 上限为 256，Rough / Flawed / Fine 上限为 71680，并受预算和游戏菜单上限约束。重挂时还会限制为未成交的剩余数量。
- `Price Check Interval (s)` 可选 10–120 秒，默认在 30–60 秒之间随机。完成一轮检查和下单后开始等待下一轮。
- 预估 `Item Profit/hr = (NPC 售价 − 买单单价) × 订单数量 × 2`，使用与 Bazaar to NPC 相同的半小时成交量估计；按该值从高到低下单。
- 等待期间和定时检查开始时都只领取完全成交订单，并补充空出的订单位置。检查实际买单价格后，只有被更高买价超过的未满订单才会领取、取消并尝试重挂；同名订单逐笔比较价格，不因订单重复或进入 checking 阶段就领取未满订单。重挂仍受所选名单、利润、成交量和预算限制，下单和确认前再次校验价格及利润。
- 关闭后可点击聊天中的 `Clean up gemstone orders`，或输入 `/v5 bazaar gemstone cleanup`。它只清理关闭时选中或本轮管理过的宝石购买订单及本流程的临时卖单，并将物品转入 sacks。

Gemstone Flip 以 NPC 售价估算利润，物品最终留在 sacks，不自动出售给 NPC。

验证需要在游戏内覆盖部分成交、完全成交、同名已有卖单、满袋退出、定时重挂，以及中途停止后的清理；本仓库不提供自动化测试或独立构建步骤。
