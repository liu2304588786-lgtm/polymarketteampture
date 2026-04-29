# Polymarket 脚本集

这个仓库包含几组基于 Node.js 的小工具脚本：

- `npm run demo`：读取公开市场数据和订单簿
- `npm run place-limit`：通过官方 CLOB SDK 提交一笔 Polymarket 限价单
- `npm run auto-quote`：自动维护一笔 maker 挂单
- `npm run threshold-buyer`：自动发现天气市场，并在低价时买入 YES
- `npm run backtest-weather`：用 Open-Meteo 历史温度对比 Polymarket 已结算天气桶

如果你的机器需要通过本地 Clash HTTP 代理 `127.0.0.1:7897` 访问网络，也提供了对应的 `:clash` 命令：

- `npm run demo:clash`
- `npm run place-limit:clash`
- `npm run auto-quote:clash`
- `npm run threshold-buyer:clash`
- `npm run backtest-weather:clash`

如果你的 Clash HTTP 或 mixed 代理使用了其他端口，运行前先设置 `CLASH_PROXY_URL`：

```powershell
$env:CLASH_PROXY_URL="http://127.0.0.1:7890"
npm run threshold-buyer:clash -- --config config.markets.example.json --dry-run
```

## 1. 公开市场演示

```bash
npm run demo
```

如果你希望请求显式走 Clash 本地代理：

```bash
npm run demo:clash -- --limit 3
```

常用参数：

```bash
npm run demo -- --limit 3 --depth 10
npm run demo -- --slug <market-slug>
npm run demo -- --market-id <market-id>
npm run demo -- --token-id <token-id>
```

## 2. 提交限价单

先把 `.env.example` 复制为 `.env`，然后填入你的钱包参数。

```bash
npm run place-limit -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25
```

如果需要走 Clash 本地代理：

```bash
npm run place-limit:clash -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25
```

只做 dry run、不真正发单：

```bash
npm run place-limit -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25 --dry-run
```

### 关键环境变量

- `PRIVATE_KEY`：签名私钥
- `POLYMARKET_SIGNATURE_TYPE`：`0`、`1`、`2` 或 `3`
- `POLYMARKET_FUNDER_ADDRESS`：代理钱包结构下必填
- `CLOB_API_KEY`、`CLOB_SECRET`、`CLOB_PASS_PHRASE`：可选；如果不填会自动推导

### 说明

- 脚本会在发单前通过 SDK 自动解析 `tickSize` 和 `negRisk`。
- 默认使用 `postOnly=true`，因此订单行为更接近静态 maker 挂单。
- Polymarket 文档中这几个签名类型含义如下：
  `0` = EOA
  `1` = POLY_PROXY
  `2` = GNOSIS_SAFE
  `3` = POLY_1271
- 对于 Polymarket.com 账户，资金通常放在代理钱包里，所以 signer 地址和 funder 地址往往不是同一个。

## 3. Auto quote 策略

这是一个针对单个 `token_id + side` 的简单自动改价器。

它会循环执行下面几步：

1. 读取当前订单簿
2. 计算目标 maker 价格
3. 查询你在该 token 和 side 上的未成交订单
4. 取消已经过时的订单
5. 如有需要，重新挂出一笔新的静态订单

示例：

```bash
npm run auto-quote -- --token-id <TOKEN_ID> --side BUY --size 25 --max-price 0.44
```

如果需要走 Clash 本地代理：

```bash
npm run auto-quote:clash -- --token-id <TOKEN_ID> --side BUY --size 25 --max-price 0.44
```

常用调节参数：

```bash
npm run auto-quote -- --token-id <TOKEN_ID> --side BUY --size 25 --improve-ticks 1 --min-spread-ticks 2 --replace-threshold-ticks 1 --poll-ms 5000
```

策略行为说明：

- `improve-ticks`：相对当前同侧最优价，向前提升多少个 tick
- `min-spread-ticks`：与对手盘之间至少保留多少个 tick，降低误吃单概率
- `replace-threshold-ticks`：只有目标价偏移足够大时，才会取消并重挂
- `max-price`：BUY 的最高价
- `min-price`：SELL 的最低价

重要说明：

- 当前版本刻意只管理每个 `token_id + side` 下的一笔活跃订单。
- 在重新报价前，它会先取消该 token 同侧多余的订单。
- 建议先从 `--dry-run` 开始，确认目标价格和换单逻辑符合预期。

## 4. Threshold buyer

这个脚本启动时可以自动发现指定城市的活跃天气市场。

默认策略如下：

- 自动发现 `Shenzhen`、`Shanghai`、`Beijing`、`Hong Kong`、`Guangzhou`、`Taipei` 的活跃 `highestTemperature` 天气事件
- 监控这些事件下面的所有 YES 市场
- 当观察到的 YES 概率低于 `0.10` 时，以 `0.10` 挂一笔 `BUY YES` 限价单
- 固定下单数量为 `20` 份
- 成功挂出买单后，脚本会为该 token 记录一份止盈计划
- 当 YES 涨到买入价的 `2x` 时，自动对持仓的 `50%` 挂出一笔 `SELL YES`
- 当 `weatherForecastFilterEnabled=true` 时，会拉取天气预报区间，只监控靠近预报高温或低温的桶
- 所有城市都使用同一套对称规则：先把预报高温四舍五入，再监控 `±1°C`
- 例如，预报高温是 `28.6°C`，四舍五入后为 `29°C`，那么脚本只会保留 `28°C`、`29°C`、`30°C`

这套策略还包含一个可选的高确定性 `NO` 分支。开启后，它会使用同一套天气预报窗口找出看起来被排除的桶，然后等待同事件中的另一个桶明显占优，再在接近结算时买入高价 `NO`。

### 配置

把 `config.markets.example.json` 复制为 `config.markets.json`，然后按需修改。

示例：

```json
{
  "pollIntervalMs": 10000,
  "triggerYesPrice": 0.1,
  "orderYesPrice": 0.1,
  "rearmYesPrice": 0.11,
  "orderSize": 20,
  "minTriggerLiquidityShares": 5,
  "minTakeProfitLiquidityShares": 5,
  "maxStrategyTokensPerEvent": 2,
  "relativeMispricingFilterEnabled": true,
  "relativeMispricingMinDiscount": 0.03,
  "relativeMispricingMaxPriceRank": 2,
  "takeProfitEnabled": true,
  "takeProfitTargetPrice": 0.8,
  "dominantYesSkipThreshold": 0.9,
  "orderType": "GTC",
  "postOnly": false,
  "dryRun": true,
  "autoDiscoverWeatherMarkets": true,
  "allowedCities": ["Shenzhen", "Shanghai", "Beijing", "Hong Kong", "Guangzhou", "Taipei"],
  "weatherCategory": "highestTemperature",
  "weatherForecastFilterEnabled": true,
  "weatherForecastProvider": "open-meteo",
  "weatherForecastWindowC": 1,
  "weatherForecastTimezone": "Asia/Shanghai",
  "tailNoStrategyEnabled": false,
  "tailNoOrderSize": 20,
  "tailNoMaxStrategyTokensPerEvent": 2,
  "tailNoAllowedCities": ["Shenzhen", "Shanghai", "Beijing", "Hong Kong", "Guangzhou", "Taipei"],
  "tailNoTriggerPrice": 0.98,
  "tailNoRearmPrice": 0.95,
  "tailNoMaxOrderPrice": 0.999,
  "tailNoMinBucketGapC": 2,
  "tailNoMaxDaysAhead": 0,
  "tailNoRequireDominantYes": true,
  "tailNoDominantYesThreshold": 0.93,
  "minTemperatureByCity": {},
  "stateFile": ".polymarket-threshold-state.json",
  "targets": []
}
```

### 运行

Dry run：

```bash
npm run threshold-buyer
```

如果你的网络通过 Clash 本地代理比直连或 TUN 更稳定，可以使用：

```bash
npm run threshold-buyer:clash -- --config config.markets.example.json --dry-run
```

即使配置里写了 `dryRun: true`，也可以强制切到实盘模式：

```bash
npm run threshold-buyer -- --live
```

使用其他配置文件：

```bash
npm run threshold-buyer -- --config my-markets.json
```

### 说明

- 这个脚本的主逻辑是挂 `BUY YES`，不是直接挂 `NO`。
- 如果 `tailNoStrategyEnabled=true`，脚本也可能会在已经接近确定性的“预报排除桶”上挂 `BUY NO`。
- 它会把本地触发状态保存在 `stateFile` 中，避免同一个 token 在持续低于阈值时每次轮询都重复买入。
- 只有当观察到的 YES 价格重新回升到 `rearmYesPrice` 以上，该 token 才会重新进入可触发状态。
- `tailNoRearmPrice` 是可选 `NO` 分支的镜像规则：一旦触发过一次 `BUY NO`，必须先回落到这个值以下，才允许再次触发。
- `tailNoOrderSize` 允许可选 `NO` 分支使用独立仓位大小，而不是与 YES 分支共用。
- `takeProfitEnabled=true` 表示在买单挂出后，脚本会继续监控已持有的 YES 仓位是否满足止盈条件。
- `takeProfitTargetPrice=0.8` 表示当 YES 到达 `0.80` 时，脚本会挂一笔整仓卖单。
- `minTriggerLiquidityShares=5` 表示只有在当前最优卖价至少展示 `5` 份深度时，才会触发 BUY。
- `minTakeProfitLiquidityShares=5` 表示只有在当前最优买价至少展示 `5` 份深度时，才会触发止盈。
- `maxStrategyTokensPerEvent=2` 表示每个天气事件最多同时持有 `2` 个活跃 YES token，用来降低互斥桶之间非原子执行的风险。
- `tailNoMaxStrategyTokensPerEvent` 是可选 `NO` 分支独立的事件级上限，因此高确定性扫尾不会占用 YES 分支的额度。
- `relativeMispricingFilterEnabled=true` 表示 BUY 触发除了满足绝对价格阈值外，还必须在同事件的监控桶里显得足够便宜。
- `relativeMispricingMinDiscount=0.03` 表示当前最优卖价必须至少比该事件监控桶的中位数低 `0.03`。
- `relativeMispricingMaxPriceRank=2` 表示当前最优卖价必须排在该事件最便宜的前 `2` 个监控桶之内。
- 如果同一个 YES token 已经存在未成交的 `BUY` 订单，脚本会先取消它们，再挂出新的阈值单。
- `autoDiscoverWeatherMarkets=true` 表示脚本启动时会自动扫描你配置城市下的活跃天气事件，不需要手动填写事件 URL。
- `allowedCities` 可以把监控范围限制在指定城市，例如 `Shenzhen`、`Shanghai`、`Beijing`、`Hong Kong`、`Guangzhou`、`Taipei`。
- `tailNoAllowedCities` 是可选 `NO` 分支独立的城市白名单；如果你自己的配置里不写，可以保持和 `allowedCities` 一样，或者只收窄到适合做近结算 NO 扫尾的城市。
- `weatherCategory=highestTemperature` 表示只监控最高温市场。
- `weatherForecastFilterEnabled=true` 表示脚本会在交易前使用 Open-Meteo 预报数据对温度桶做过滤。
- `weatherForecastWindowC=1` 表示每个城市只保留处于四舍五入后的预报高温或低温 `±1°C` 范围内的桶；对于最高温市场，使用的是每日预报最高温。
- `weatherForecastTimezone=Asia/Shanghai` 用来让预报日期与中国大陆或香港本地日期保持一致。
- `tailNoMinBucketGapC=2` 表示可选 `NO` 分支只考虑那些至少离预报窗口 `2°C` 之外的桶。
- `tailNoMaxDaysAhead=0` 表示可选 `NO` 分支只关注当天市场，更接近临近结算时的高确定性扫尾，而不是长周期观点单。
- `tailNoRequireDominantYes=true` 且 `tailNoDominantYesThreshold=0.93` 表示只有当同事件中另一个桶已经明显像胜出项时，可选 `NO` 分支才会触发。
- `tailNoTriggerPrice=0.98` 表示可选 `NO` 分支只有在观察到的 `NO` 价格已经达到 `98%+` 时才会买入。
- `tailNoMaxOrderPrice=0.999` 会给可选 `BUY NO` 限价设一个上限，避免脚本追得过高。
- `orderYesPrice` 是实际下单时挂出的限价。默认配置下，策略会在 YES 低于 `0.10` 时触发，但挂单价格仍然固定为 `0.10`。
- 现在的 BUY 决策同时要求绝对价格触发和事件内相对便宜信号，而不是只看绝对 `0.10` 这一条规则。
- 现在的触发和止盈判断会优先使用可成交的订单簿价格，也就是 BUY 看 `best ask`、SELL 看 `best bid`，而不是依赖可能滞后的 last trade。
- `dominantYesSkipThreshold=0.9` 表示如果同一个天气事件里已经有任意选项达到 `90%+`，脚本就会跳过整个事件，不再继续下单。
- `minTemperatureByCity` 允许你在关闭天气预报过滤时，按城市设置额外的温度桶下限。
- 如果某个 YES token 在你的账户里已经有真实持仓，脚本会跳过它，不会重复加仓。
- 没有 CLOB 订单簿的 token 会被静默跳过，让长期运行的日志保持可读。
- 启动时，脚本只会打印最终纳入监控范围的 `city + date` 分组。
- 轮询过程中，普通跳过不会刷屏；只有成功的 BUY 和成功的止盈 SELL 才会打印出来。

## 5. 天气回测

这个脚本会比较已经结算的天气事件中的两件事：

- Polymarket 最终结算出来的 winning bucket
- 根据 Open-Meteo 历史天气数据推导出来的 bucket

当前这个版本只是一个校验和报表工具，不会真实下单。

示例：

```bash
npm run backtest-weather -- --date 2026-04-24 --cities Shanghai
npm run backtest-weather -- --from 2026-04-20 --to 2026-04-24 --cities Shanghai,Beijing
```

如果需要走 Clash 本地代理：

```bash
npm run backtest-weather:clash -- --from 2026-04-20 --to 2026-04-24 --cities Shanghai,Beijing
```

常用参数：

- `--weather-category highestTemperature|lowestTemperature`
- `--bucket-mode round|floor|ceil`
- `--format table|json`
- `--config config.markets.json`：复用 `allowedCities`、`weatherCategory`、`weatherForecastTimezone` 和 `weatherForecastCityCoordinates`

说明：

- 脚本会从 Gamma 拉取已经关闭的天气事件，并从结算后的 `outcomePrices` 中读取 winning bucket。
- 天气数据来自 `archive-api.open-meteo.com` 的历史归档接口，不是 Polymarket 自己的结算源。
- `--bucket-mode round` 表示像 `20.2°C` 这样的历史温度会被映射到 `20°C` 桶；`floor` 和 `ceil` 可用于做敏感性对比。
