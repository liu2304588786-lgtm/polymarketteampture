# Polymarket Scripts

This repo contains several small Node.js scripts:

- `npm run demo`: read public market data and order books
- `npm run place-limit`: place a Polymarket limit order through the official CLOB SDK
- `npm run auto-quote`: keep one maker order refreshed automatically
- `npm run threshold-buyer`: auto-discover weather markets and buy low-priced YES outcomes
- `npm run backtest-weather`: compare Open-Meteo archive temperatures with Polymarket's settled weather buckets

For machines that need to go through the local Clash HTTP proxy on `127.0.0.1:7897`, matching `:clash` commands are also available:

- `npm run demo:clash`
- `npm run place-limit:clash`
- `npm run auto-quote:clash`
- `npm run threshold-buyer:clash`
- `npm run backtest-weather:clash`

If your Clash HTTP or mixed proxy uses a different port, set `CLASH_PROXY_URL` before running:

```powershell
$env:CLASH_PROXY_URL="http://127.0.0.1:7890"
npm run threshold-buyer:clash -- --config config.markets.example.json --dry-run
```

## 1. Public market demo

```bash
npm run demo
```

If you want the request to explicitly use Clash local proxy:

```bash
npm run demo:clash -- --limit 3
```

Useful options:

```bash
npm run demo -- --limit 3 --depth 10
npm run demo -- --slug <market-slug>
npm run demo -- --market-id <market-id>
npm run demo -- --token-id <token-id>
```

## 2. Place a limit order

Copy `.env.example` to `.env`, then fill in your wallet values.

```bash
npm run place-limit -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25
```

With Clash local proxy:

```bash
npm run place-limit:clash -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25
```

Dry run without posting:

```bash
npm run place-limit -- --token-id <TOKEN_ID> --side BUY --price 0.42 --size 25 --dry-run
```

### Important env vars

- `PRIVATE_KEY`: signer private key
- `POLYMARKET_SIGNATURE_TYPE`: `0`, `1`, `2`, or `3`
- `POLYMARKET_FUNDER_ADDRESS`: required for proxy wallet setups
- `CLOB_API_KEY`, `CLOB_SECRET`, `CLOB_PASS_PHRASE`: optional, auto-derived if omitted

### Notes

- The script resolves `tickSize` and `negRisk` automatically from the SDK before posting.
- It defaults to `postOnly=true` so the order behaves like a resting maker order.
- Polymarket docs say:
  `0` = EOA
  `1` = POLY_PROXY
  `2` = GNOSIS_SAFE
  `3` = POLY_1271
- For Polymarket.com accounts, funds are usually in a proxy wallet, so the signer and funder are often not the same address.

## 3. Auto quote strategy

This is a simple requoter for one `token_id + side`.

It does this in a loop:

1. read the current order book
2. compute a target maker price
3. look up your open orders on that token and side
4. cancel stale orders
5. place one new resting order if needed

Example:

```bash
npm run auto-quote -- --token-id <TOKEN_ID> --side BUY --size 25 --max-price 0.44
```

With Clash local proxy:

```bash
npm run auto-quote:clash -- --token-id <TOKEN_ID> --side BUY --size 25 --max-price 0.44
```

Useful knobs:

```bash
npm run auto-quote -- --token-id <TOKEN_ID> --side BUY --size 25 --improve-ticks 1 --min-spread-ticks 2 --replace-threshold-ticks 1 --poll-ms 5000
```

Strategy behavior:

- `improve-ticks`: how aggressively to step ahead of the current same-side best price
- `min-spread-ticks`: minimum distance kept from the opposite side to reduce accidental taking
- `replace-threshold-ticks`: only cancel/repost when target price drifts enough
- `max-price`: BUY ceiling
- `min-price`: SELL floor

Important:

- This version intentionally manages only one active order per `token_id + side`.
- It cancels extra same-side orders for that token before quoting.
- Start with `--dry-run` first to verify the target prices and replacement logic on your market.

## 4. Threshold buyer

This script can auto-discover active weather markets for selected cities at startup.

The default strategy is:

- auto-discover active `highestTemperature` weather events for `Shenzhen`, `Shanghai`, `Beijing`, `Hong Kong`, `Guangzhou`, and `Taipei`
- monitor every YES market under those events
- when the observed YES probability drops below `0.10`, place a `BUY YES` limit order at `0.10`
- use a fixed size of `20` shares
- after a successful buy order is posted, the script remembers a take-profit plan for that token
- when YES reaches `2x` the buy order price, it automatically posts one `SELL YES` order for `50%` of the held position
- when `weatherForecastFilterEnabled=true`, fetch the forecast temperature range and only monitor buckets around the forecast high/low
- all cities use the same symmetric rule: round the forecast high, then monitor `±1°C`
- for example, a forecast high of `28.6°C` rounds to `29°C`, so the script keeps only `28°C`, `29°C`, `30°C`

This strategy also has an optional high-confidence `NO` branch. When enabled, it uses the same weather forecast window to identify buckets that look excluded, then waits for another bucket in the same event to dominate before buying expensive `NO` near settlement.

### Config

Copy `config.markets.example.json` to `config.markets.json` and edit it.

Example:

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

### Run

Dry run:

```bash
npm run threshold-buyer
```

If your network only works reliably through Clash local proxy instead of direct/TUN routing, use:

```bash
npm run threshold-buyer:clash -- --config config.markets.example.json --dry-run
```

Force live mode even if config has `dryRun: true`:

```bash
npm run threshold-buyer -- --live
```

Use another config file:

```bash
npm run threshold-buyer -- --config my-markets.json
```

### Notes

- The script places a `BUY YES` order, not a `NO` order.
- If `tailNoStrategyEnabled=true`, the script may also place `BUY NO` orders on forecast-excluded buckets that are already close to certainty.
- It keeps local trigger state in `stateFile` so the same token is not bought every poll while it remains under the threshold.
- A token is re-armed only after its observed YES price rises back above `rearmYesPrice`.
- `tailNoRearmPrice` is the mirror rule for the optional `NO` branch: after one `BUY NO`, the token must cool back below this level before it can trigger again.
- `tailNoOrderSize` lets the optional `NO` branch use its own position size instead of sharing the YES branch sizing.
- `takeProfitEnabled=true` means the script will watch held YES positions for take-profit after a buy is posted.
- `takeProfitTargetPrice=0.8` means the script will place one full-position SELL order when YES reaches `0.80`.
- `minTriggerLiquidityShares=5` means a BUY trigger only fires when the current best ask shows at least 5 shares of displayed depth.
- `minTakeProfitLiquidityShares=5` means take-profit only fires when the current best bid shows at least 5 shares of displayed depth.
- `maxStrategyTokensPerEvent=2` limits the strategy to at most 2 active YES tokens per weather event, which reduces non-atomic execution risk across mutually exclusive buckets.
- `tailNoMaxStrategyTokensPerEvent` is the separate event-level cap for the optional `NO` branch, so high-certainty sweeps do not consume the YES branch budget.
- `relativeMispricingFilterEnabled=true` means a BUY trigger must also look cheap relative to the other monitored buckets in the same event.
- `relativeMispricingMinDiscount=0.03` means the current best ask must be at least `0.03` below the monitored event median price.
- `relativeMispricingMaxPriceRank=2` means the current best ask must rank among the 2 cheapest monitored buckets in the same event.
- If there are existing open `BUY` orders on the same YES token, the script cancels them before placing the new threshold order.
- `autoDiscoverWeatherMarkets=true` means the script searches active weather events for your configured cities at startup without needing event URLs.
- `allowedCities` lets you restrict monitoring to selected cities such as `Shenzhen`, `Shanghai`, `Beijing`, `Hong Kong`, `Guangzhou`, `Taipei`.
- `tailNoAllowedCities` is the separate city whitelist for the optional `NO` branch; if omitted in your own config, you can keep it identical to `allowedCities` or narrow it to only the cities where near-settlement NO sweeps make sense.
- `weatherCategory=highestTemperature` restricts the monitor to highest-temperature markets.
- `weatherForecastFilterEnabled=true` means the script uses Open-Meteo forecast data to filter temperature buckets before trading.
- `weatherForecastWindowC=1` means every city keeps only buckets within rounded forecast high/low `± 1°C`; for highest-temperature markets it uses the forecast daily high.
- `weatherForecastTimezone=Asia/Shanghai` keeps the forecast date aligned with China/Hong Kong local dates.
- `tailNoMinBucketGapC=2` means the optional `NO` branch only considers buckets that sit at least `2掳C` outside the forecast window.
- `tailNoMaxDaysAhead=0` keeps the optional `NO` branch focused on same-day markets, closer to a near-resolution certainty sweep than a long-dated opinion trade.
- `tailNoRequireDominantYes=true` plus `tailNoDominantYesThreshold=0.93` means the optional `NO` branch only fires after another bucket in the same event is already trading like the likely winner.
- `tailNoTriggerPrice=0.98` means the optional `NO` branch only buys when the observed `NO` price is already at `98%+`.
- `tailNoMaxOrderPrice=0.999` caps the optional `BUY NO` limit price so the script lifts only near-certain offers and does not chase past your ceiling.
- `orderYesPrice` is the limit price the script posts when triggered. With the default config, it buys when YES is below `0.10` and still posts the order at exactly `0.10`.
- BUY decisions now require both an absolute trigger and an event-relative cheapness signal, instead of relying on the absolute `0.10` rule alone.
- Trigger and take-profit decisions now prefer actionable orderbook prices (`best ask` for BUY checks, `best bid` for SELL checks) instead of leaning on stale last-trade snapshots.
- `dominantYesSkipThreshold=0.9` means that if any option inside the same weather event already reaches `90%+`, the script skips that whole event and does not place more orders there.
- `minTemperatureByCity` lets you apply per-city bucket filters only when weather forecast filtering is disabled.
- If a YES token already has a real position in your account, the script skips that token and will not place a duplicate order for the same option.
- Tokens without a CLOB orderbook are skipped quietly so long-running sessions stay readable.
- On startup, the script prints only the final monitoring ranges grouped by `city + date`.
- During the loop, normal skips are quiet; the script only prints successful BUY orders and successful take-profit SELL orders.

## 5. Weather backtest

This script compares two things for already-closed weather events:

- the settled Polymarket winning bucket for a city/date
- the bucket you would derive from Open-Meteo archive data

This first version is a validation/reporting tool only. It does not place orders.

Examples:

```bash
npm run backtest-weather -- --date 2026-04-24 --cities Shanghai
npm run backtest-weather -- --from 2026-04-20 --to 2026-04-24 --cities Shanghai,Beijing
```

With Clash local proxy:

```bash
npm run backtest-weather:clash -- --from 2026-04-20 --to 2026-04-24 --cities Shanghai,Beijing
```

Useful options:

- `--weather-category highestTemperature|lowestTemperature`
- `--bucket-mode round|floor|ceil`
- `--format table|json`
- `--config config.markets.json` to reuse `allowedCities`, `weatherCategory`, `weatherForecastTimezone`, and `weatherForecastCityCoordinates`

Notes:

- The script fetches closed weather events from Gamma and reads the winning bucket from settled `outcomePrices`.
- The weather side uses Open-Meteo archive data from `archive-api.open-meteo.com`, not Polymarket's own resolution source.
- `--bucket-mode round` means a historical temperature like `20.2°C` is mapped to bucket `20°C`; `floor` and `ceil` are available for sensitivity checks.
