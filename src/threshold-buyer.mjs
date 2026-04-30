import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { OrderType, Side } from "@polymarket/clob-client-v2";
import { createAuthenticatedClient } from "./polymarket-client.mjs";
import { startHeartbeatLoop } from "./heartbeat.mjs";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const DATA_API_BASE_URL = "https://data-api.polymarket.com";
const OPEN_METEO_BASE_URL = "https://api.open-meteo.com";
const DEFAULT_CONFIG_PATH = "config.markets.json";
const NO_ORDERBOOK_LOG_INTERVAL_MS = 30 * 60 * 1000;
const TRANSIENT_ORDERBOOK_LOG_INTERVAL_MS = 5 * 60 * 1000;
const THIN_LIQUIDITY_SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
const EVENT_EXPOSURE_SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
const RELATIVE_VALUE_SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
const POSITION_SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
const DOMINANT_EVENT_SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;
const INSUFFICIENT_COLLATERAL_LOG_INTERVAL_MS = 60 * 1000;
const TAKE_PROFIT_WAIT_LOG_INTERVAL_MS = 30 * 60 * 1000;
const FETCH_JSON_MAX_ATTEMPTS = 4;
const FETCH_JSON_RETRY_BASE_DELAY_MS = 750;
const ORDERBOOK_MAX_ATTEMPTS = 3;
const ORDERBOOK_RETRY_BASE_DELAY_MS = 500;
const USDC_MICROS_PER_UNIT = 1_000_000n;
const DEFAULT_ALLOWED_CITIES = ["Shenzhen", "Shanghai", "Beijing", "Hong Kong", "Guangzhou", "Taipei"];
const DEFAULT_MIN_TEMPERATURE_BY_CITY = {
  Shenzhen: 29,
  "Hong Kong": 29,
};
const DEFAULT_WEATHER_FORECAST_PROVIDER = "open-meteo";
const DEFAULT_WEATHER_FORECAST_TIMEZONE = "Asia/Shanghai";
const DEFAULT_WEATHER_FORECAST_WINDOW_C = 1;
const DEFAULT_TAIL_NO_TRIGGER_PRICE = 0.98;
const DEFAULT_TAIL_NO_REARM_PRICE = 0.95;
const DEFAULT_TAIL_NO_MAX_ORDER_PRICE = 0.999;
const DEFAULT_TAIL_NO_MIN_BUCKET_GAP_C = 2;
const DEFAULT_TAIL_NO_MAX_DAYS_AHEAD = 0;
const DEFAULT_TAIL_NO_DOMINANT_YES_THRESHOLD = 0.93;
const DEFAULT_WEATHER_FORECAST_CITY_COORDINATES = {
  shenzhen: { latitude: 22.5431, longitude: 114.0579 },
  shanghai: { latitude: 31.2304, longitude: 121.4737 },
  beijing: { latitude: 39.9042, longitude: 116.4074 },
  "hong-kong": { latitude: 22.3193, longitude: 114.1694 },
  guangzhou: { latitude: 23.1291, longitude: 113.2644 },
  taipei: { latitude: 25.033, longitude: 121.5654 },
};
const MONTH_INDEX = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};
const CITY_DEFINITIONS = [
  {
    key: "shenzhen",
    label: "Shenzhen",
    zhLabel: "深圳",
    aliases: ["shenzhen", "\u6df1\u5733"],
  },
  {
    key: "shanghai",
    label: "Shanghai",
    zhLabel: "上海",
    aliases: ["shanghai", "\u4e0a\u6d77"],
  },
  {
    key: "beijing",
    label: "Beijing",
    zhLabel: "北京",
    aliases: ["beijing", "\u5317\u4eac"],
  },
  {
    key: "hong-kong",
    label: "Hong Kong",
    zhLabel: "香港",
    aliases: ["hong kong", "hongkong", "\u9999\u6e2f"],
  },
  {
    key: "guangzhou",
    label: "Guangzhou",
    zhLabel: "广州",
    aliases: ["guangzhou", "\u5e7f\u5dde"],
  },
  {
    key: "taipei",
    label: "Taipei",
    zhLabel: "台北",
    aliases: ["taipei", "taipei city", "\u53f0\u5317", "\u81fa\u5317"],
  },
];
const WEATHER_CATEGORY_SEARCH_TERMS = {
  highestTemperature: ["highest temperature", "max temperature"],
  lowestTemperature: ["lowest temperature", "min temperature"],
  any: ["temperature", "weather"],
};

function printHelp() {
  console.log(`
Monitor Polymarket weather markets and buy YES when price drops below a threshold.

Usage:
  npm run threshold-buyer
  npm run threshold-buyer -- --config config.markets.json
  npm run threshold-buyer -- --dry-run

Config file:
  By default the script reads ./config.markets.json

Live mode automatically sends Polymarket heartbeat requests to keep resting orders alive.

Top-level config fields:
  pollIntervalMs             Loop interval in milliseconds
  triggerYesPrice            Trigger threshold, e.g. 0.10
  orderYesPrice              Limit price to post when triggered
  rearmYesPrice              Price above which a token becomes eligible again
  orderSize                  Shares to buy for each trigger
  minTriggerLiquidityShares  Minimum best-ask displayed size to allow a BUY trigger
  minTakeProfitLiquidityShares Minimum best-bid displayed size to allow take-profit
  maxStrategyTokensPerEvent  Max number of strategy tokens active in the same event
  relativeMispricingFilterEnabled true | false
  relativeMispricingMinDiscount Minimum event-relative discount versus monitored median
  relativeMispricingMaxPriceRank Maximum event-relative ask rank allowed to trigger
  takeProfitEnabled          true | false
  takeProfitTargetPrice      Fixed YES exit price for full take-profit, e.g. 0.8
  orderType                  GTC | GTD
  postOnly                   true | false
  dryRun                     true | false
  stateFile                  Local JSON state file for deduping
  autoDiscoverWeatherMarkets true | false
  allowedCities              Cities to auto-discover
  weatherCategory            highestTemperature | lowestTemperature | any
  dominantYesSkipThreshold   Skip whole event when any YES outcome reaches this probability
  weatherForecastFilterEnabled true | false, filter buckets by forecast high/low temperature window
  weatherForecastWindowC     Degrees around forecast high/low to monitor, e.g. 1
  weatherForecastTimezone    Forecast timezone, e.g. Asia/Shanghai
  tailNoStrategyEnabled      true | false, optionally buy high-confidence NO buckets
  tailNoOrderSize            Shares to buy for each Tail-NO trigger
  tailNoMaxStrategyTokensPerEvent Max Tail-NO tokens active in the same event
  tailNoAllowedCities        Cities allowed for the Tail-NO branch
  tailNoTriggerPrice         Minimum NO ask/reference price required to trigger
  tailNoRearmPrice           Price below which a NO token becomes eligible again
  tailNoMaxOrderPrice        Cap for the posted BUY NO limit price
  tailNoMinBucketGapC        Minimum forecast-window gap in C required for BUY NO
  tailNoMaxDaysAhead         Maximum whole days ahead allowed for BUY NO
  tailNoRequireDominantYes   true | false, require another bucket to already dominate
  tailNoDominantYesThreshold Minimum YES price required for dominant-bucket confirmation
  minTemperatureByCity       Optional per-city temperature floor
  targets                    Optional array of { url } or { name } or { slug }
`);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    dryRunOverride: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--config") {
      options.configPath = argv[++index] ?? DEFAULT_CONFIG_PATH;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRunOverride = true;
      continue;
    }

    if (arg === "--live") {
      options.dryRunOverride = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToTick(value, tickSize) {
  const scaled = value / tickSize;
  return Number((Math.round(scaled) * tickSize).toFixed(10));
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toBigInt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function formatCollateralFromMicros(value) {
  const micros = toBigInt(value);
  if (micros === null) {
    return "n/a";
  }

  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / USDC_MICROS_PER_UNIT;
  const fraction = String(absolute % USDC_MICROS_PER_UNIT).padStart(6, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
}

function getWatchItemDateLabel(watchItem) {
  return watchItem.parsedDate instanceof Date && !Number.isNaN(watchItem.parsedDate.getTime())
    ? formatDateKey(watchItem.parsedDate)
    : "unknown";
}

function getWatchItemLogPrefix(watchItem) {
  const outcomeLabel = String(watchItem.outcomeLabel || "yes").toUpperCase();
  return `${getCityLogLabel(watchItem.cityKey || watchItem.cityLabel)} ${getWatchItemDateLabel(watchItem)} ${formatTemperatureBucket(watchItem.temperatureBucket)} ${outcomeLabel}`;
}

function extractErrorMessage(error) {
  return error?.data?.error ?? error?.response?.data?.error ?? error?.message ?? "未知错误";
}

function isClobRequestErrorLog(args) {
  const combined = args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");

  return combined.includes("[CLOB Client] request error");
}

function isInsufficientBalanceAllowanceError(error) {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("not enough balance / allowance") ||
    message.includes("balance is not enough") ||
    message.includes("insufficient allowance")
  );
}

function buildKnownErrorSummary(error) {
  if (isInsufficientBalanceAllowanceError(error)) {
    return "余额或授权不足";
  }

  return extractErrorMessage(error);
}

function isTransientOrderbookError(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timedout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("socket disconnected") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout")
  );
}

function getRequiredOrderAmountMicros(orderPrice, orderSize) {
  return BigInt(Math.round(orderPrice * orderSize * Number(USDC_MICROS_PER_UNIT)));
}

function buildCollateralStatus(response) {
  const balanceMicros = toBigInt(response?.balance);
  const allowanceValues = [
    toBigInt(response?.allowance),
    ...Object.values(response?.allowances && typeof response.allowances === "object" ? response.allowances : {}).map(
      (value) => toBigInt(value),
    ),
  ].filter((value) => value !== null);

  const maxAllowanceMicros =
    allowanceValues.length === 0
      ? null
      : allowanceValues.reduce((currentMax, value) => (value > currentMax ? value : currentMax));

  return {
    balanceMicros,
    maxAllowanceMicros,
    raw: response,
  };
}

function buildTradeBlockReason(collateralStatus, config, watchItem, referencePrice) {
  if (!collateralStatus) {
    return null;
  }

  const orderPrice = getEntryOrderPrice(config, watchItem, referencePrice);
  const orderSize = getEntryOrderSize(config, watchItem);
  const requiredMicros = getRequiredOrderAmountMicros(orderPrice, orderSize);
  const balanceMicros = collateralStatus.balanceMicros ?? 0n;
  const maxAllowanceMicros = collateralStatus.maxAllowanceMicros ?? 0n;

  if (balanceMicros >= requiredMicros && maxAllowanceMicros >= requiredMicros) {
    return null;
  }

  return {
    requiredMicros,
    balanceMicros,
    maxAllowanceMicros,
    message:
      `余额/授权不足（pUSD/collateral 余额 ${formatCollateralFromMicros(balanceMicros)}，` +
      `授权 ${formatCollateralFromMicros(maxAllowanceMicros)}，` +
      `本单需 ${formatCollateralFromMicros(requiredMicros)}）`,
  };
}

let lastInsufficientCollateralLogAt = null;

function roundShareSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Number(parsed.toFixed(4));
}

function buildTakeProfitPlan(config, entryPrice) {
  if (!config.takeProfitEnabled) {
    return null;
  }

  const normalizedEntryPrice = Number(entryPrice);
  const targetPrice = Number(config.takeProfitTargetPrice.toFixed(10));

  return {
    entryPrice: normalizedEntryPrice,
    targetPrice,
    sellFraction: 1,
    sellSize: null,
    orderId: null,
    triggeredAt: null,
    lastWaitLogAt: null,
  };
}

function positiveNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }

  return parsed;
}

function zeroToOneNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${fieldName} must be greater than 0 and less than or equal to 1.`);
  }

  return parsed;
}

function positiveInteger(value, fieldName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

function nonNegativeInteger(value, fieldName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }

  return parsed;
}

function nonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }

  return parsed;
}

function findCityDefinition(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  return (
    CITY_DEFINITIONS.find((definition) => {
      if (normalizeText(definition.key) === normalized) {
        return true;
      }
      if (normalizeText(definition.label) === normalized) {
        return true;
      }
      return definition.aliases.some((alias) => normalizeText(alias) === normalized);
    }) ?? null
  );
}

function getCityDisplayLabel(cityKey) {
  return findCityDefinition(cityKey)?.label ?? String(cityKey || "");
}

function getCityLogLabel(cityKey) {
  const definition = findCityDefinition(cityKey);
  return definition?.zhLabel ?? definition?.label ?? String(cityKey || "");
}

function getCityAliases(cityKey) {
  const definition = findCityDefinition(cityKey);
  if (!definition) {
    return [String(cityKey || "")];
  }

  return [definition.key, definition.label, ...definition.aliases];
}

function getCitySearchAlias(cityKey) {
  const definition = findCityDefinition(cityKey);
  if (!definition) {
    return String(cityKey || "");
  }

  return definition.aliases.find((alias) => /^[a-z ]+$/i.test(alias)) ?? definition.aliases[0];
}

function normalizeAllowedCities(value, fieldName = "allowedCities") {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array.`);
  }

  const normalizedCities = [];
  const seen = new Set();

  for (const city of value) {
    const cityValue = String(city || "").trim();
    if (!cityValue) {
      throw new Error(`${fieldName} entries must be non-empty strings.`);
    }

    const definition = findCityDefinition(cityValue);
    const canonicalKey = definition?.key ?? cityValue;
    if (!seen.has(canonicalKey)) {
      seen.add(canonicalKey);
      normalizedCities.push(canonicalKey);
    }
  }

  return normalizedCities;
}

function mergeUniqueCities(...cityGroups) {
  const merged = [];
  const seen = new Set();

  for (const group of cityGroups) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const cityKey of group) {
      if (seen.has(cityKey)) {
        continue;
      }

      seen.add(cityKey);
      merged.push(cityKey);
    }
  }

  return merged;
}

function normalizeWeatherCategory(value) {
  const normalized = String(value || "").trim();
  const supported = new Set(["highestTemperature", "lowestTemperature", "any"]);
  if (!supported.has(normalized)) {
    throw new Error("weatherCategory must be highestTemperature, lowestTemperature, or any.");
  }

  return normalized;
}

function normalizeWeatherForecastProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized !== "open-meteo") {
    throw new Error("weatherForecastProvider currently supports only open-meteo.");
  }

  return normalized;
}

function normalizeWeatherForecastTimezone(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("weatherForecastTimezone must be a non-empty string.");
  }

  return normalized;
}

function normalizeTarget(target, index) {
  if (!target || typeof target !== "object") {
    throw new Error(`Target at index ${index} must be an object.`);
  }

  if (typeof target.url === "string" && target.url.trim() !== "") {
    return { url: target.url.trim() };
  }

  if (typeof target.slug === "string" && target.slug.trim() !== "") {
    return { slug: target.slug.trim() };
  }

  if (typeof target.name === "string" && target.name.trim() !== "") {
    return { name: target.name.trim() };
  }

  throw new Error(`Target at index ${index} must include url, slug, or name.`);
}

function normalizeMinTemperatureByCity(value, allowedCities) {
  const shouldUseDefaults = value === undefined || value === null;

  if (value === undefined || value === null) {
    value = DEFAULT_MIN_TEMPERATURE_BY_CITY;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("minTemperatureByCity must be an object when provided.");
  }

  const normalized = {};
  for (const [rawCity, rawTemperature] of Object.entries(value)) {
    const definition = findCityDefinition(rawCity);
    const canonicalKey = definition?.key ?? rawCity;
    const parsedTemperature = Number.parseInt(rawTemperature, 10);
    if (!Number.isInteger(parsedTemperature) || parsedTemperature <= 0) {
      throw new Error(`minTemperatureByCity.${rawCity} must be a positive integer.`);
    }

    normalized[canonicalKey] = parsedTemperature;
  }

  if (shouldUseDefaults) {
    for (const city of allowedCities) {
      if (normalized[city] === undefined && DEFAULT_MIN_TEMPERATURE_BY_CITY[getCitySearchAlias(city)]) {
        normalized[city] = DEFAULT_MIN_TEMPERATURE_BY_CITY[getCitySearchAlias(city)];
      }
    }

    const defaultKeys = Object.keys(DEFAULT_MIN_TEMPERATURE_BY_CITY);
    for (const [rawCity, rawTemperature] of Object.entries(DEFAULT_MIN_TEMPERATURE_BY_CITY)) {
      const definition = findCityDefinition(rawCity);
      const canonicalKey = definition?.key ?? rawCity;
      if (allowedCities.includes(canonicalKey) && normalized[canonicalKey] === undefined) {
        normalized[canonicalKey] = rawTemperature;
      }
    }

    void defaultKeys;
  }

  return normalized;
}

function normalizeWeatherForecastCityCoordinates(value, allowedCities) {
  const normalized = {};

  for (const cityKey of allowedCities) {
    const defaults = DEFAULT_WEATHER_FORECAST_CITY_COORDINATES[cityKey];
    if (defaults) {
      normalized[cityKey] = { ...defaults };
    }
  }

  if (value === undefined || value === null) {
    return normalized;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("weatherForecastCityCoordinates must be an object when provided.");
  }

  for (const [rawCity, rawCoordinates] of Object.entries(value)) {
    const definition = findCityDefinition(rawCity);
    const canonicalKey = definition?.key ?? rawCity;
    if (!allowedCities.includes(canonicalKey)) {
      continue;
    }

    if (!rawCoordinates || typeof rawCoordinates !== "object" || Array.isArray(rawCoordinates)) {
      throw new Error(`weatherForecastCityCoordinates.${rawCity} must be an object.`);
    }

    const latitude = toNumber(rawCoordinates.latitude ?? rawCoordinates.lat);
    const longitude = toNumber(rawCoordinates.longitude ?? rawCoordinates.lon ?? rawCoordinates.lng);
    if (latitude === null || longitude === null) {
      throw new Error(`weatherForecastCityCoordinates.${rawCity} must include latitude and longitude.`);
    }

    normalized[canonicalKey] = { latitude, longitude };
  }

  return normalized;
}

function normalizeConfig(rawConfig, cliOptions) {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Config file must contain a JSON object.");
  }

  const allowedCities = normalizeAllowedCities(rawConfig.allowedCities ?? DEFAULT_ALLOWED_CITIES, "allowedCities");
  const tailNoAllowedCities = normalizeAllowedCities(
    rawConfig.tailNoAllowedCities ?? rawConfig.allowedCities ?? DEFAULT_ALLOWED_CITIES,
    "tailNoAllowedCities",
  );
  const monitoredCities = mergeUniqueCities(
    allowedCities,
    rawConfig.tailNoStrategyEnabled ?? false ? tailNoAllowedCities : [],
  );

  const config = {
    pollIntervalMs: positiveInteger(rawConfig.pollIntervalMs ?? 10000, "pollIntervalMs"),
    triggerYesPrice: positiveNumber(rawConfig.triggerYesPrice ?? 0.1, "triggerYesPrice"),
    orderYesPrice: positiveNumber(rawConfig.orderYesPrice ?? 0.1, "orderYesPrice"),
    rearmYesPrice: positiveNumber(rawConfig.rearmYesPrice ?? 0.11, "rearmYesPrice"),
    orderSize: positiveNumber(rawConfig.orderSize ?? 20, "orderSize"),
    minTriggerLiquidityShares: positiveNumber(
      rawConfig.minTriggerLiquidityShares ?? 5,
      "minTriggerLiquidityShares",
    ),
    minTakeProfitLiquidityShares: positiveNumber(
      rawConfig.minTakeProfitLiquidityShares ?? 5,
      "minTakeProfitLiquidityShares",
    ),
    maxStrategyTokensPerEvent: positiveInteger(
      rawConfig.maxStrategyTokensPerEvent ?? 2,
      "maxStrategyTokensPerEvent",
    ),
    relativeMispricingFilterEnabled: Boolean(rawConfig.relativeMispricingFilterEnabled ?? true),
    relativeMispricingMinDiscount: nonNegativeNumber(
      rawConfig.relativeMispricingMinDiscount ?? 0.03,
      "relativeMispricingMinDiscount",
    ),
    relativeMispricingMaxPriceRank: positiveInteger(
      rawConfig.relativeMispricingMaxPriceRank ?? 2,
      "relativeMispricingMaxPriceRank",
    ),
    takeProfitEnabled: Boolean(rawConfig.takeProfitEnabled ?? true),
    takeProfitTargetPrice: zeroToOneNumber(
      rawConfig.takeProfitTargetPrice ?? 0.8,
      "takeProfitTargetPrice",
    ),
    orderType: parseOrderType(rawConfig.orderType ?? "GTC"),
    postOnly: Boolean(rawConfig.postOnly ?? false),
    dryRun: cliOptions.dryRunOverride ?? Boolean(rawConfig.dryRun ?? false),
    stateFile: String(rawConfig.stateFile ?? ".polymarket-threshold-state.json"),
    autoDiscoverWeatherMarkets: rawConfig.autoDiscoverWeatherMarkets ?? true,
    allowedCities,
    tailNoAllowedCities,
    monitoredCities,
    weatherCategory: normalizeWeatherCategory(rawConfig.weatherCategory ?? "highestTemperature"),
    dominantYesSkipThreshold: positiveNumber(
      rawConfig.dominantYesSkipThreshold ?? 0.9,
      "dominantYesSkipThreshold",
    ),
    weatherForecastFilterEnabled: Boolean(rawConfig.weatherForecastFilterEnabled ?? true),
    weatherForecastProvider: normalizeWeatherForecastProvider(
      rawConfig.weatherForecastProvider ?? DEFAULT_WEATHER_FORECAST_PROVIDER,
    ),
    weatherForecastWindowC: positiveNumber(
      rawConfig.weatherForecastWindowC ?? DEFAULT_WEATHER_FORECAST_WINDOW_C,
      "weatherForecastWindowC",
    ),
    weatherForecastTimezone: normalizeWeatherForecastTimezone(
      rawConfig.weatherForecastTimezone ?? DEFAULT_WEATHER_FORECAST_TIMEZONE,
    ),
    tailNoStrategyEnabled: Boolean(rawConfig.tailNoStrategyEnabled ?? false),
    tailNoOrderSize: positiveNumber(
      rawConfig.tailNoOrderSize ?? rawConfig.orderSize ?? 20,
      "tailNoOrderSize",
    ),
    tailNoMaxStrategyTokensPerEvent: positiveInteger(
      rawConfig.tailNoMaxStrategyTokensPerEvent ?? rawConfig.maxStrategyTokensPerEvent ?? 2,
      "tailNoMaxStrategyTokensPerEvent",
    ),
    tailNoTriggerPrice: zeroToOneNumber(
      rawConfig.tailNoTriggerPrice ?? DEFAULT_TAIL_NO_TRIGGER_PRICE,
      "tailNoTriggerPrice",
    ),
    tailNoRearmPrice: zeroToOneNumber(
      rawConfig.tailNoRearmPrice ?? DEFAULT_TAIL_NO_REARM_PRICE,
      "tailNoRearmPrice",
    ),
    tailNoMaxOrderPrice: zeroToOneNumber(
      rawConfig.tailNoMaxOrderPrice ?? DEFAULT_TAIL_NO_MAX_ORDER_PRICE,
      "tailNoMaxOrderPrice",
    ),
    tailNoMinBucketGapC: nonNegativeNumber(
      rawConfig.tailNoMinBucketGapC ?? DEFAULT_TAIL_NO_MIN_BUCKET_GAP_C,
      "tailNoMinBucketGapC",
    ),
    tailNoMaxDaysAhead: nonNegativeInteger(
      rawConfig.tailNoMaxDaysAhead ?? DEFAULT_TAIL_NO_MAX_DAYS_AHEAD,
      "tailNoMaxDaysAhead",
    ),
    tailNoRequireDominantYes: Boolean(rawConfig.tailNoRequireDominantYes ?? true),
    tailNoDominantYesThreshold: zeroToOneNumber(
      rawConfig.tailNoDominantYesThreshold ?? DEFAULT_TAIL_NO_DOMINANT_YES_THRESHOLD,
      "tailNoDominantYesThreshold",
    ),
    weatherForecastCityCoordinates: normalizeWeatherForecastCityCoordinates(
      rawConfig.weatherForecastCityCoordinates,
      monitoredCities,
    ),
    minTemperatureByCity: normalizeMinTemperatureByCity(rawConfig.minTemperatureByCity, allowedCities),
    targets: Array.isArray(rawConfig.targets) ? rawConfig.targets.map(normalizeTarget) : [],
  };

  if (config.tailNoRearmPrice >= config.tailNoTriggerPrice) {
    throw new Error("tailNoRearmPrice must be lower than tailNoTriggerPrice.");
  }

  if (config.tailNoMaxOrderPrice < config.tailNoTriggerPrice) {
    throw new Error("tailNoMaxOrderPrice must be greater than or equal to tailNoTriggerPrice.");
  }

  return config;
}

function parseOrderType(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === OrderType.GTC || normalized === OrderType.GTD) {
    return normalized;
  }

  throw new Error(`Unsupported order type: ${value}`);
}

function buildFetchJsonError(error, url) {
  if (error.response) {
    const requestError = new Error(
      `Request failed: ${error.response.status} ${error.response.statusText} for ${url}\n${JSON.stringify(error.response.data)}`,
    );
    requestError.status = error.response.status;
    requestError.statusText = error.response.statusText;
    requestError.data = error.response.data;
    return requestError;
  }

  return new Error(`Request failed for ${url}\n${error.message}`);
}

function isRetryableFetchJsonError(error) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status))) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timedout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("socket disconnected") ||
    message.includes("bad gateway")
  );
}

async function fetchJson(url, options = {}) {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    null;

  const requestConfig = {
    headers: {
      Accept: "application/json",
      "User-Agent": "polymarket-threshold-buyer/0.2",
    },
    timeout: 30000,
  };

  if (proxyUrl) {
    const parsedProxyUrl = new URL(proxyUrl);
    requestConfig.proxy = {
      protocol: parsedProxyUrl.protocol.replace(":", ""),
      host: parsedProxyUrl.hostname,
      port: parsedProxyUrl.port ? Number(parsedProxyUrl.port) : undefined,
    };

    if (parsedProxyUrl.username || parsedProxyUrl.password) {
      requestConfig.proxy.auth = {
        username: decodeURIComponent(parsedProxyUrl.username),
        password: decodeURIComponent(parsedProxyUrl.password),
      };
    }
  }

  const maxAttempts = options.maxAttempts ?? FETCH_JSON_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(url.toString(), requestConfig);
      return response.data;
    } catch (error) {
      const requestError = buildFetchJsonError(error, url);
      if (attempt < maxAttempts && isRetryableFetchJsonError(requestError)) {
        await sleep(FETCH_JSON_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      throw requestError;
    }
  }

  throw new Error(`Request failed for ${url}`);
}

function buildGammaUrl(pathname, params = {}) {
  const url = new URL(pathname, GAMMA_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildDataApiUrl(pathname, params = {}) {
  const url = new URL(pathname, DATA_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildOpenMeteoUrl(pathname, params = {}) {
  const url = new URL(pathname, OPEN_METEO_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function extractSlugFromUrl(urlString) {
  const parsed = new URL(urlString);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Cannot extract event slug from URL: ${urlString}`);
  }

  const eventIndex = segments.findIndex((segment) => segment === "event");
  if (eventIndex >= 0 && segments[eventIndex + 1]) {
    return segments[eventIndex + 1];
  }

  return segments[segments.length - 1];
}

async function resolveEventFromTarget(target) {
  if (target.slug) {
    return fetchJson(buildGammaUrl(`/events/slug/${encodeURIComponent(target.slug)}`));
  }

  if (target.url) {
    const slug = extractSlugFromUrl(target.url);
    return fetchJson(buildGammaUrl(`/events/slug/${encodeURIComponent(slug)}`));
  }

  const searchResults = await fetchJson(buildGammaUrl("/public-search", { q: target.name }));
  const eventMatches = Array.isArray(searchResults?.events) ? searchResults.events : [];
  const preferredEvent =
    eventMatches.find((event) => event?.active && !event?.closed && sameText(event?.title, target.name)) ||
    eventMatches.find((event) => event?.active && !event?.closed) ||
    eventMatches[0];

  if (!preferredEvent?.slug) {
    throw new Error(`No event found for target name: ${target.name}`);
  }

  return fetchJson(buildGammaUrl(`/events/slug/${encodeURIComponent(preferredEvent.slug)}`));
}

function sameText(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function parseWeatherDate(value) {
  const source = String(value || "");
  const slugMatch = source.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})-(\d{4})\b/i,
  );
  if (slugMatch) {
    const month = MONTH_INDEX[slugMatch[1].toLowerCase()];
    const day = Number.parseInt(slugMatch[2], 10);
    const year = Number.parseInt(slugMatch[3], 10);
    return new Date(year, month, day);
  }

  const zhMatch = source.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u);
  if (zhMatch) {
    const today = new Date();
    const year = zhMatch[1] ? Number.parseInt(zhMatch[1], 10) : today.getFullYear();
    const month = Number.parseInt(zhMatch[2], 10) - 1;
    const day = Number.parseInt(zhMatch[3], 10);
    return new Date(year, month, day);
  }

  const isoMatch = source.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return new Date(
      Number.parseInt(isoMatch[1], 10),
      Number.parseInt(isoMatch[2], 10) - 1,
      Number.parseInt(isoMatch[3], 10),
    );
  }

  return null;
}

function isWeatherSeriesEvent(event) {
  const combined = normalizeText(`${event?.title || ""} ${event?.slug || ""}`);
  return (
    combined.includes("temperature") ||
    combined.includes("\u6c14\u6e29") ||
    combined.includes("\u6700\u9ad8\u6c14\u6e29") ||
    combined.includes("\u6700\u4f4e\u6c14\u6e29") ||
    combined.includes("weather") ||
    combined.includes("rain") ||
    combined.includes("\u964d\u96e8")
  );
}

function matchesWeatherCategory(event, weatherCategory) {
  if (weatherCategory === "any") {
    return true;
  }

  const combined = normalizeText(`${event?.title || ""} ${event?.slug || ""}`);
  if (weatherCategory === "highestTemperature") {
    return (
      combined.includes("highest temperature") ||
      combined.includes("max temperature") ||
      combined.includes("\u6700\u9ad8\u6c14\u6e29")
    );
  }

  if (weatherCategory === "lowestTemperature") {
    return (
      combined.includes("lowest temperature") ||
      combined.includes("min temperature") ||
      combined.includes("\u6700\u4f4e\u6c14\u6e29")
    );
  }

  return false;
}

function inferCityKeyFromText(value) {
  const combined = normalizeText(value);
  for (const definition of CITY_DEFINITIONS) {
    if (
      [definition.key, definition.label, ...definition.aliases].some((alias) => {
        const normalizedAlias = normalizeText(alias);
        return normalizedAlias ? combined.includes(normalizedAlias) : false;
      })
    ) {
      return definition.key;
    }
  }

  return null;
}

function matchesAllowedCity(event, allowedCities) {
  const cityKey = inferCityKeyFromText(`${event?.title || ""} ${event?.slug || ""}`);
  return cityKey ? allowedCities.includes(cityKey) : false;
}

function parseTemperatureBucketFromText(value) {
  const rawValue = String(value || "");
  const normalized = normalizeText(rawValue);

  let match = normalized.match(/\b(\d{1,2})\s*c\s*or\s*below\b/);
  if (match) {
    return { kind: "lte", value: Number.parseInt(match[1], 10) };
  }

  match = normalized.match(/\b(\d{1,2})\s*c\s*or\s*higher\b/);
  if (match) {
    return { kind: "gte", value: Number.parseInt(match[1], 10) };
  }

  match = normalized.match(/\b(\d{1,2})\s*c\b/);
  if (match) {
    return { kind: "exact", value: Number.parseInt(match[1], 10) };
  }

  match = rawValue.match(/(\d{1,2})\s*(?:°|º|˚)?\s*C\s*or\s*below/i);
  if (match) {
    return { kind: "lte", value: Number.parseInt(match[1], 10) };
  }

  match = rawValue.match(/(\d{1,2})\s*(?:°|º|˚)?\s*C\s*or\s*higher/i);
  if (match) {
    return { kind: "gte", value: Number.parseInt(match[1], 10) };
  }

  match = rawValue.match(/(\d{1,2})\s*(?:°|º|˚)?\s*C/i);
  if (match) {
    return { kind: "exact", value: Number.parseInt(match[1], 10) };
  }

  return null;
}

function parseTemperatureBucket(market) {
  const candidates = [market?.question, market?.slug];

  for (const candidate of candidates) {
    const parsed = parseTemperatureBucketFromText(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const slug = String(market?.slug || "");
  let match = slug.match(/-(\d{1,2})corbelow$/i);
  if (match) {
    return { kind: "lte", value: Number.parseInt(match[1], 10) };
  }

  match = slug.match(/-(\d{1,2})corhigher$/i);
  if (match) {
    return { kind: "gte", value: Number.parseInt(match[1], 10) };
  }

  match = slug.match(/-(\d{1,2})c$/i);
  if (match) {
    return { kind: "exact", value: Number.parseInt(match[1], 10) };
  }

  return null;
}

function passesTemperatureRule(cityKey, bucket, config) {
  if (config.weatherForecastFilterEnabled) {
    return true;
  }

  const minimumTemperature = config.minTemperatureByCity[cityKey];
  if (minimumTemperature === undefined) {
    return true;
  }

  if (!bucket) {
    return false;
  }

  if (bucket.kind === "exact" || bucket.kind === "gte") {
    return bucket.value >= minimumTemperature;
  }

  return false;
}

function formatTemperatureRuleSummary(config) {
  if (config.weatherForecastFilterEnabled) {
    return "由气象预报窗口接管（静态规则仅在关闭气象过滤时使用）";
  }

  const entries = Object.entries(config.minTemperatureByCity);
  if (entries.length === 0) {
    return "none";
  }

  return entries
    .map(([cityKey, minimumTemperature]) => `${getCityLogLabel(cityKey)}>=${minimumTemperature}\u00b0C`)
    .join(", ");
}

function getOutcomePriceByLabel(market, label) {
  const outcomes = parseMaybeJsonArray(market.outcomes);
  const prices = parseMaybeJsonArray(market.outcomePrices);
  const outcomeIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === label.toLowerCase());
  if (outcomeIndex === -1) {
    return null;
  }

  return toNumber(prices[outcomeIndex]);
}

function getOutcomeTokenIdByLabel(market, label) {
  const outcomes = parseMaybeJsonArray(market.outcomes);
  const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
  if (outcomes.length === 0 || tokenIds.length === 0) {
    return null;
  }

  const outcomeIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === label.toLowerCase());
  if (outcomeIndex === -1) {
    return null;
  }

  return tokenIds[outcomeIndex] ?? null;
}

function extractMarketsFromEvent(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return markets.filter(Boolean);
}

function buildMarketWatchItem(event, market, config) {
  const yesTokenId = getOutcomeTokenIdByLabel(market, "yes");
  if (!yesTokenId) {
    return null;
  }

  const noTokenId = getOutcomeTokenIdByLabel(market, "no");

  const cityKey =
    inferCityKeyFromText(`${event?.title || ""} ${event?.slug || ""}`) ||
    inferCityKeyFromText(`${market?.question || ""} ${market?.slug || ""}`);
  if (!cityKey || !config.monitoredCities.includes(cityKey)) {
    return null;
  }

  const temperatureBucket = parseTemperatureBucket(market);
  if (!passesTemperatureRule(cityKey, temperatureBucket, config)) {
    return null;
  }

  return {
    eventSlug: event.slug,
    eventTitle: event.title,
    marketId: market.id,
    marketSlug: market.slug,
    question: market.question,
    yesTokenId,
    noTokenId,
    tokenId: yesTokenId,
    outcomeLabel: "yes",
    strategyType: "threshold-yes",
    cityKey,
    cityLabel: getCityDisplayLabel(cityKey),
    parsedDate: parseWeatherDate(event.title) || parseWeatherDate(event.slug),
    temperatureBucket,
    yesOutcomePrice: getOutcomePriceByLabel(market, "yes"),
    noOutcomePrice: getOutcomePriceByLabel(market, "no"),
    outcomePrice: getOutcomePriceByLabel(market, "yes"),
  };
}

function formatTemperatureBucket(bucket) {
  if (!bucket) {
    return "unknown";
  }

  if (bucket.kind === "exact") {
    return `${bucket.value}\u00b0C`;
  }
  if (bucket.kind === "gte") {
    return `${bucket.value}\u00b0C+`;
  }
  if (bucket.kind === "lte") {
    return `<=${bucket.value}\u00b0C`;
  }

  return "unknown";
}

function getForecastBasisTemperature(forecast, weatherCategory) {
  if (weatherCategory === "lowestTemperature") {
    return forecast.lowC ?? forecast.highC;
  }

  return forecast.highC ?? forecast.lowC;
}

function buildForecastWindow(forecast, config) {
  const basisC = getForecastBasisTemperature(forecast, config.weatherCategory);
  if (basisC === null || basisC === undefined) {
    return null;
  }

  const centerC = Math.round(basisC);
  const lowerC = centerC - config.weatherForecastWindowC;
  const upperC = centerC + config.weatherForecastWindowC;

  return {
    ...forecast,
    basisC,
    centerC,
    lowerC,
    upperC,
    windowC: config.weatherForecastWindowC,
    windowMode: "symmetric",
  };
}

function bucketPassesForecastWindow(bucket, forecastWindow) {
  if (!bucket || !forecastWindow) {
    return false;
  }

  return bucket.value >= forecastWindow.lowerC && bucket.value <= forecastWindow.upperC;
}

function getBucketGapFromForecastWindow(bucket, forecastWindow) {
  if (!bucket || !forecastWindow) {
    return null;
  }

  if (bucket.kind === "exact") {
    if (bucket.value < forecastWindow.lowerC) {
      return forecastWindow.lowerC - bucket.value;
    }
    if (bucket.value > forecastWindow.upperC) {
      return bucket.value - forecastWindow.upperC;
    }
    return 0;
  }

  if (bucket.kind === "gte") {
    return bucket.value > forecastWindow.upperC ? bucket.value - forecastWindow.upperC : 0;
  }

  if (bucket.kind === "lte") {
    return bucket.value < forecastWindow.lowerC ? forecastWindow.lowerC - bucket.value : 0;
  }

  return null;
}

function getDaysUntilWatchItemDate(watchItem) {
  if (!(watchItem?.parsedDate instanceof Date) || Number.isNaN(watchItem.parsedDate.getTime())) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.round(
    (startOfDay(watchItem.parsedDate).getTime() - startOfDay(new Date()).getTime()) / (24 * 60 * 60 * 1000),
  );
}

function buildTailNoWatchItem(watchItem) {
  if (!watchItem?.noTokenId) {
    return null;
  }

  return {
    ...watchItem,
    tokenId: watchItem.noTokenId,
    outcomeLabel: "no",
    strategyType: "tail-no",
    outcomePrice: watchItem.noOutcomePrice,
  };
}

function shouldCreateTailNoWatchItem(watchItem, config) {
  if (!config.tailNoStrategyEnabled) {
    return false;
  }

  if (!watchItem?.weatherForecast || !watchItem?.noTokenId) {
    return false;
  }

  const forecastGapC = toNumber(watchItem.forecastGapC);
  if (forecastGapC === null || forecastGapC < config.tailNoMinBucketGapC) {
    return false;
  }

  if (!config.tailNoAllowedCities.includes(watchItem.cityKey)) {
    return false;
  }

  return getDaysUntilWatchItemDate(watchItem) <= config.tailNoMaxDaysAhead;
}

function formatTemperatureValue(value) {
  const parsed = toNumber(value);
  return parsed === null ? "n/a" : `${Number(parsed.toFixed(1))}\u00b0C`;
}

function formatForecastWindow(forecastWindow) {
  if (!forecastWindow) {
    return "无预报";
  }

  return `预报 ${formatTemperatureValue(forecastWindow.lowC)}~${formatTemperatureValue(forecastWindow.highC)}，监控 ${formatTemperatureValue(forecastWindow.lowerC)}~${formatTemperatureValue(forecastWindow.upperC)}`;
}

async function fetchWeatherForecast(cityKey, dateKey, config) {
  if (config.weatherForecastProvider !== "open-meteo") {
    throw new Error(`Unsupported weather forecast provider: ${config.weatherForecastProvider}`);
  }

  const coordinates = config.weatherForecastCityCoordinates[cityKey];
  if (!coordinates) {
    throw new Error(`No weather forecast coordinates configured for ${getCityLogLabel(cityKey)}.`);
  }

  const data = await fetchJson(
    buildOpenMeteoUrl("/v1/forecast", {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      daily: "temperature_2m_max,temperature_2m_min",
      timezone: config.weatherForecastTimezone,
      start_date: dateKey,
      end_date: dateKey,
    }),
  );

  const daily = data?.daily ?? {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const index = times.findIndex((time) => String(time) === dateKey);
  if (index === -1) {
    throw new Error(`No weather forecast returned for ${getCityLogLabel(cityKey)} ${dateKey}.`);
  }

  const highC = toNumber(daily.temperature_2m_max?.[index]);
  const lowC = toNumber(daily.temperature_2m_min?.[index]);
  if (highC === null && lowC === null) {
    throw new Error(`Weather forecast has no temperature range for ${getCityLogLabel(cityKey)} ${dateKey}.`);
  }

  return {
    provider: config.weatherForecastProvider,
    cityKey,
    dateKey,
    highC,
    lowC,
  };
}

async function applyWeatherForecastFilter(watchItems, config) {
  if (!config.weatherForecastFilterEnabled && !config.tailNoStrategyEnabled) {
    return watchItems;
  }

  const groups = new Map();
  for (const item of watchItems) {
    const dateKey = getWatchItemDateLabel(item);
    const groupKey = `${item.cityKey}::${dateKey}`;
    const existing = groups.get(groupKey) ?? {
      cityKey: item.cityKey,
      dateKey,
      items: [],
    };
    existing.items.push(item);
    groups.set(groupKey, existing);
  }

  const filteredItems = [];
  for (const group of groups.values()) {
    if (!group.cityKey || group.dateKey === "unknown") {
      if (!config.weatherForecastFilterEnabled) {
        filteredItems.push(...group.items);
      }
      continue;
    }

    let forecastWindow;
    try {
      const forecast = await fetchWeatherForecast(group.cityKey, group.dateKey, config);
      forecastWindow = buildForecastWindow(forecast, config);
    } catch (error) {
      if (!config.weatherForecastFilterEnabled) {
        filteredItems.push(...group.items);
      }
      continue;
    }

    if (!forecastWindow) {
      if (!config.weatherForecastFilterEnabled) {
        filteredItems.push(...group.items);
      }
      continue;
    }

    const annotatedItems = group.items.map((item) => {
      const forecastWindowMatch = bucketPassesForecastWindow(item.temperatureBucket, forecastWindow);
      const forecastGapC = getBucketGapFromForecastWindow(item.temperatureBucket, forecastWindow);
      return {
        ...item,
        weatherForecast: forecastWindow,
        forecastWindowMatch,
        forecastGapC,
      };
    });

    const yesItems = annotatedItems.filter((item) => isStrategyCityAllowed(config, item));
    const passedItems = config.weatherForecastFilterEnabled
      ? yesItems.filter((item) => item.forecastWindowMatch)
      : yesItems;

    filteredItems.push(...passedItems);

    if (config.tailNoStrategyEnabled) {
      const tailNoItems = annotatedItems
        .filter((item) => !item.forecastWindowMatch && shouldCreateTailNoWatchItem(item, config))
        .map((item) => buildTailNoWatchItem(item))
        .filter(Boolean);

      filteredItems.push(...tailNoItems);
    }
  }

  return filteredItems;
}

function isEligibleDiscoveredEvent(event, cityKey, config) {
  if (!event?.slug || !event?.active || event?.closed) {
    return false;
  }
  if (!isWeatherSeriesEvent(event)) {
    return false;
  }
  if (!matchesWeatherCategory(event, config.weatherCategory)) {
    return false;
  }
  if (!matchesAllowedCity(event, [cityKey])) {
    return false;
  }

  const parsedDate = parseWeatherDate(event.title) || parseWeatherDate(event.slug);
  if (parsedDate && startOfDay(parsedDate).getTime() < startOfDay(new Date()).getTime()) {
    return false;
  }

  return true;
}

async function discoverWeatherEventsForCity(cityKey, config) {
  const eventMap = new Map();
  const citySearchAlias = getCitySearchAlias(cityKey);
  const searchTerms = WEATHER_CATEGORY_SEARCH_TERMS[config.weatherCategory] ?? WEATHER_CATEGORY_SEARCH_TERMS.any;

  for (const categoryTerm of searchTerms) {
    const query = `${categoryTerm} ${citySearchAlias}`;
    let searchResults;
    try {
      searchResults = await fetchJson(buildGammaUrl("/public-search", { q: query }));
    } catch (error) {
      void error;
      continue;
    }

    const eventMatches = Array.isArray(searchResults?.events) ? searchResults.events : [];

    for (const event of eventMatches) {
      if (isEligibleDiscoveredEvent(event, cityKey, config)) {
        eventMap.set(event.slug, event);
      }
    }
  }

  return [...eventMap.values()];
}

async function discoverWeatherEvents(config) {
  const uniqueEvents = new Map();

  for (const cityKey of config.monitoredCities) {
    const cityEvents = await discoverWeatherEventsForCity(cityKey, config);
    for (const event of cityEvents) {
      uniqueEvents.set(event.slug, event);
    }
  }

  return [...uniqueEvents.values()].sort((left, right) => {
    const leftDate = parseWeatherDate(left?.title) || parseWeatherDate(left?.slug);
    const rightDate = parseWeatherDate(right?.title) || parseWeatherDate(right?.slug);
    return (leftDate?.getTime() ?? Number.MAX_SAFE_INTEGER) - (rightDate?.getTime() ?? Number.MAX_SAFE_INTEGER);
  });
}

async function resolveConfiguredEvents(config) {
  const uniqueEvents = new Map();

  if (config.autoDiscoverWeatherMarkets) {
    const discoveredEvents = await discoverWeatherEvents(config);
    for (const event of discoveredEvents) {
      uniqueEvents.set(event.slug, event);
    }
  }

  for (const target of config.targets) {
    const resolvedEvent = await resolveEventFromTarget(target);
    if (resolvedEvent?.slug) {
      uniqueEvents.set(resolvedEvent.slug, resolvedEvent);
    }
  }

  return [...uniqueEvents.values()];
}

async function resolveConfiguredMarkets(config) {
  const resolvedItems = [];
  const events = await resolveConfiguredEvents(config);

  for (const event of events) {
    let hydratedEvent;
    try {
      hydratedEvent =
        Array.isArray(event?.markets) && event.markets.length > 0
          ? event
          : await fetchJson(buildGammaUrl(`/events/slug/${encodeURIComponent(event.slug)}`));
    } catch (error) {
      void error;
      continue;
    }

    const markets = extractMarketsFromEvent(hydratedEvent);

    for (const market of markets) {
      const item = buildMarketWatchItem(hydratedEvent, market, config);
      if (item) {
        resolvedItems.push(item);
      }
    }
  }

  const unique = new Map();
  for (const item of resolvedItems) {
    unique.set(item.tokenId, item);
  }

  const forecastFilteredItems = await applyWeatherForecastFilter([...unique.values()], config);

  return forecastFilteredItems.sort((left, right) => {
    const leftDate = left.parsedDate instanceof Date ? left.parsedDate.getTime() : Number.MAX_SAFE_INTEGER;
    const rightDate = right.parsedDate instanceof Date ? right.parsedDate.getTime() : Number.MAX_SAFE_INTEGER;
    if (leftDate !== rightDate) {
      return leftDate - rightDate;
    }

    return left.marketSlug.localeCompare(right.marketSlug);
  });
}

function getPositionTokenId(position) {
  const candidate =
    position?.asset ??
    position?.asset_id ??
    position?.tokenId ??
    position?.token_id ??
    null;

  return candidate === null || candidate === undefined ? null : String(candidate);
}

function getPositionSize(position) {
  const numericFields = ["size", "shares", "amount", "balance"];
  for (const field of numericFields) {
    const parsed = toNumber(position?.[field]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return 0;
}

function getOpenOrderTokenId(order) {
  const candidate =
    order?.asset_id ??
    order?.assetId ??
    order?.asset ??
    order?.tokenID ??
    order?.tokenId ??
    order?.token_id ??
    null;

  return candidate === null || candidate === undefined ? null : String(candidate);
}

function buildOpenBuyOrdersIndex(openOrders) {
  const index = new Map();

  for (const order of openOrders) {
    if (order?.side !== Side.BUY) {
      continue;
    }

    const tokenId = getOpenOrderTokenId(order);
    if (!tokenId) {
      continue;
    }

    const existing = index.get(tokenId) ?? [];
    existing.push(order);
    index.set(tokenId, existing);
  }

  return index;
}

function buildActiveStrategyTokenCountByEvent(watchItems, positionsByTokenId, openBuyOrdersByTokenId) {
  const eventTokens = new Map();

  for (const item of watchItems) {
    const tokenId = String(item.tokenId);
    const hasPosition = (positionsByTokenId.get(tokenId) ?? 0) > 0;
    const hasOpenBuyOrder = (openBuyOrdersByTokenId.get(tokenId) ?? []).length > 0;
    if (!hasPosition && !hasOpenBuyOrder) {
      continue;
    }

    const exposureKey = getEventExposureKey(item);
    const existing = eventTokens.get(exposureKey) ?? new Set();
    existing.add(tokenId);
    eventTokens.set(exposureKey, existing);
  }

  const counts = new Map();
  for (const [exposureKey, tokenIds] of eventTokens.entries()) {
    counts.set(exposureKey, tokenIds.size);
  }

  return counts;
}

function buildEventRelativeStatsByEvent(watchItems) {
  const groupedPrices = new Map();

  for (const item of watchItems) {
    if (item.outcomeLabel !== "yes") {
      continue;
    }

    const price = toNumber(item.outcomePrice);
    if (price === null) {
      continue;
    }

    const existing = groupedPrices.get(item.eventSlug) ?? [];
    existing.push(price);
    groupedPrices.set(item.eventSlug, existing);
  }

  const stats = new Map();
  for (const [eventSlug, prices] of groupedPrices.entries()) {
    const sortedPrices = [...prices].sort((left, right) => left - right);
    if (sortedPrices.length === 0) {
      continue;
    }

    const middleIndex = Math.floor(sortedPrices.length / 2);
    const medianPrice =
      sortedPrices.length % 2 === 0
        ? Number(((sortedPrices[middleIndex - 1] + sortedPrices[middleIndex]) / 2).toFixed(10))
        : sortedPrices[middleIndex];

    stats.set(eventSlug, {
      peerPrices: sortedPrices,
      medianPrice,
      count: sortedPrices.length,
    });
  }

  return stats;
}

async function fetchCurrentPositionsForUser(userAddress) {
  const limit = 500;
  const positions = [];
  let offset = 0;

  while (true) {
    const page = await fetchJson(
      buildDataApiUrl("/positions", {
        user: userAddress,
        sizeThreshold: 0,
        limit,
        offset,
      }),
    );

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    positions.push(...page);
    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return positions;
}

function buildPositionIndex(positions) {
  const index = new Map();

  for (const position of positions) {
    const tokenId = getPositionTokenId(position);
    const size = getPositionSize(position);
    if (!tokenId || size <= 0) {
      continue;
    }

    index.set(tokenId, size);
  }

  return index;
}

async function refreshEventSnapshots(watchItems, config) {
  const eventSlugs = [...new Set(watchItems.map((item) => item.eventSlug))];
  const snapshots = new Map();

  for (const eventSlug of eventSlugs) {
    try {
      const event = await fetchJson(buildGammaUrl(`/events/slug/${encodeURIComponent(eventSlug)}`));
      const markets = extractMarketsFromEvent(event);
      const marketIndex = new Map();
      let highestYesPrice = 0;

      for (const market of markets) {
        const yesPrice = getOutcomePriceByLabel(market, "yes");
        if (yesPrice !== null) {
          highestYesPrice = Math.max(highestYesPrice, yesPrice);
        }

        if (market?.id !== undefined && market?.id !== null) {
          marketIndex.set(String(market.id), market);
        }
        if (market?.slug) {
          marketIndex.set(String(market.slug), market);
        }
      }

      snapshots.set(eventSlug, {
        eventTitle: event?.title ?? eventSlug,
        highestYesPrice,
        hasDominantYes: highestYesPrice >= config.dominantYesSkipThreshold,
        marketIndex,
      });
    } catch (error) {
      void error;
    }
  }

  return snapshots;
}

async function fetchCollateralSnapshot(client) {
  const response = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
  return buildCollateralStatus(response);
}

function applyEventSnapshotsToWatchItems(watchItems, eventSnapshots) {
  for (const watchItem of watchItems) {
    const snapshot = eventSnapshots.get(watchItem.eventSlug);
    if (!snapshot) {
      continue;
    }

    const market =
      snapshot.marketIndex.get(String(watchItem.marketId)) ??
      snapshot.marketIndex.get(String(watchItem.marketSlug));

    if (!market) {
      continue;
    }

    watchItem.yesOutcomePrice = getOutcomePriceByLabel(market, "yes");
    watchItem.noOutcomePrice = getOutcomePriceByLabel(market, "no");
    watchItem.outcomePrice = getOutcomePriceByLabel(market, watchItem.outcomeLabel ?? "yes");
  }
}

async function buildRuntimeContext(clientContext, watchItems, config) {
  const promises = [
    fetchCurrentPositionsForUser(clientContext.funderAddress),
    refreshEventSnapshots(watchItems, config),
    clientContext.client.getOpenOrders(),
    config.dryRun ? Promise.resolve(null) : fetchCollateralSnapshot(clientContext.client),
  ];
  const [positionsResult, eventSnapshotsResult, openOrdersResult, collateralResult] = await Promise.allSettled(promises);

  const positions =
    positionsResult.status === "fulfilled"
      ? positionsResult.value
      : [];
  const eventSnapshots =
    eventSnapshotsResult.status === "fulfilled"
      ? eventSnapshotsResult.value
      : new Map();
  const openOrders =
    openOrdersResult.status === "fulfilled" && Array.isArray(openOrdersResult.value)
      ? openOrdersResult.value
      : [];
  const collateralStatus =
    collateralResult?.status === "fulfilled"
      ? collateralResult.value
      : null;
  const positionsByTokenId = buildPositionIndex(positions);
  const openBuyOrdersByTokenId = buildOpenBuyOrdersIndex(openOrders);

  applyEventSnapshotsToWatchItems(watchItems, eventSnapshots);

  return {
    positionsByTokenId,
    openBuyOrdersByTokenId,
    activeStrategyTokenCountByEvent: buildActiveStrategyTokenCountByEvent(
      watchItems,
      positionsByTokenId,
      openBuyOrdersByTokenId,
    ),
    eventRelativeStatsByEvent: buildEventRelativeStatsByEvent(watchItems),
    eventSnapshots,
    collateralStatus,
  };
}

async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.tokens !== "object") {
      return { tokens: {} };
    }
    return { tokens: parsed.tokens };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { tokens: {} };
    }
    throw error;
  }
}

async function saveState(statePath, state) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function getTokenState(state, tokenId) {
  const existingState = state.tokens[tokenId] ?? {};
  const existingTakeProfit =
    existingState.takeProfit && typeof existingState.takeProfit === "object"
      ? existingState.takeProfit
      : {};

  state.tokens[tokenId] = {
    armed: true,
    lastSeenPrice: null,
    lastTriggeredPrice: null,
    lastOrderId: null,
    lastTriggerAt: null,
    eventSlug: null,
    marketSlug: null,
    question: null,
    lastNoOrderbookLogAt: null,
    lastTransientOrderbookErrorLogAt: null,
    lastThinLiquiditySkipLogAt: null,
    lastEventExposureSkipLogAt: null,
    lastRelativeValueSkipLogAt: null,
    lastExecutionMode: null,
    lastPositionSkipLogAt: null,
    lastDominantEventSkipLogAt: null,
    ...existingState,
    takeProfit: {
      entryPrice: null,
      targetPrice: null,
      sellFraction: null,
      sellSize: null,
      orderId: null,
      triggeredAt: null,
      lastWaitLogAt: null,
      ...existingTakeProfit,
    },
  };

  return state.tokens[tokenId];
}

function chooseReferencePrice(book, watchItem) {
  const bestAsk = toNumber(book?.asks?.[0]?.price);
  const bestBid = toNumber(book?.bids?.[0]?.price);
  const lastTrade = toNumber(book?.last_trade_price);

  return bestAsk ?? watchItem.outcomePrice ?? lastTrade ?? bestBid;
}

function chooseTakeProfitReferencePrice(book, watchItem) {
  const bestAsk = toNumber(book?.asks?.[0]?.price);
  const bestBid = toNumber(book?.bids?.[0]?.price);
  const lastTrade = toNumber(book?.last_trade_price);

  return bestBid ?? lastTrade ?? bestAsk ?? watchItem.outcomePrice;
}

function getBookLevelSize(level) {
  const candidates = [
    level?.size,
    level?.amount,
    level?.shares,
    level?.quantity,
    level?.original_size,
  ];

  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function getBestAskSize(book) {
  return getBookLevelSize(book?.asks?.[0]);
}

function getBestBidSize(book) {
  return getBookLevelSize(book?.bids?.[0]);
}

function formatPrice(value) {
  const parsed = toNumber(value);
  return parsed === null ? "n/a" : parsed.toFixed(4);
}

function shouldLogAt(timestampValue, intervalMs) {
  const lastLoggedAt = timestampValue ? Date.parse(timestampValue) : Number.NaN;
  if (!Number.isFinite(lastLoggedAt)) {
    return true;
  }

  return Date.now() - lastLoggedAt >= intervalMs;
}

function shouldLogNoOrderbook(tokenState) {
  return shouldLogAt(tokenState.lastNoOrderbookLogAt, NO_ORDERBOOK_LOG_INTERVAL_MS);
}

function isSuppressedClobOrderbookLog(args) {
  const combined = args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");

  return (
    combined.includes("[CLOB Client] request error") &&
    (
      combined.includes("No orderbook exists for the requested token id") ||
      combined.includes("timeout of 30000ms exceeded") ||
      combined.includes("Request failed with status code 502") ||
      combined.includes("Request failed with status code 503") ||
      combined.includes("\"status\":502") ||
      combined.includes("\"status\":503") ||
      combined.includes("Bad Gateway") ||
      combined.includes("Gateway Timeout")
    )
  );
}

function isSuppressedClobOrderPlacementLog(args) {
  return isClobRequestErrorLog(args);
}

async function withSuppressedClobLogs(shouldSuppress, callback) {
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (shouldSuppress(args)) {
      return;
    }
    originalConsoleError(...args);
  };

  try {
    return await callback();
  } finally {
    console.error = originalConsoleError;
  }
}

async function getOrderBookQuietly(client, tokenId) {
  let lastError;

  for (let attempt = 1; attempt <= ORDERBOOK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withSuppressedClobLogs(
        (args) => isSuppressedClobOrderbookLog(args),
        () => client.getOrderBook(tokenId),
      );
    } catch (error) {
      lastError = error;
      if (attempt >= ORDERBOOK_MAX_ATTEMPTS || !isTransientOrderbookError(error)) {
        throw error;
      }

      await sleep(ORDERBOOK_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw lastError ?? new Error(`Failed to fetch orderbook for token ${tokenId}.`);
}

function logTransientOrderbookError(tokenState, watchItem, error) {
  if (!shouldLogAt(tokenState.lastTransientOrderbookErrorLogAt, TRANSIENT_ORDERBOOK_LOG_INTERVAL_MS)) {
    return false;
  }

  const loggedAt = now();
  tokenState.lastTransientOrderbookErrorLogAt = loggedAt;
  console.log(
    `[${loggedAt}] Orderbook temporary error | ${getWatchItemLogPrefix(watchItem)} | ${buildKnownErrorSummary(error)}`,
  );
  return true;
}

function logThinLiquiditySkip(tokenState, watchItem, label, observedSize, minimumSize) {
  if (!shouldLogAt(tokenState.lastThinLiquiditySkipLogAt, THIN_LIQUIDITY_SKIP_LOG_INTERVAL_MS)) {
    return false;
  }

  const loggedAt = now();
  tokenState.lastThinLiquiditySkipLogAt = loggedAt;
  console.log(
    `[${loggedAt}] Thin liquidity skip | ${getWatchItemLogPrefix(watchItem)} | ${label} depth ${observedSize} < min ${minimumSize}`,
  );
  return true;
}

function logEventExposureSkip(tokenState, watchItem, activeCount, maxCount) {
  if (!shouldLogAt(tokenState.lastEventExposureSkipLogAt, EVENT_EXPOSURE_SKIP_LOG_INTERVAL_MS)) {
    return false;
  }

  const loggedAt = now();
  tokenState.lastEventExposureSkipLogAt = loggedAt;
  console.log(
    `[${loggedAt}] Event exposure skip | ${getWatchItemLogPrefix(watchItem)} | active strategy tokens ${activeCount}/${maxCount} in ${watchItem.eventSlug}`,
  );
  return true;
}

function assessRelativeMispricing(stats, referencePrice) {
  if (!stats || !Array.isArray(stats.peerPrices) || stats.peerPrices.length === 0) {
    return null;
  }

  const priceRank = stats.peerPrices.filter((price) => price < referencePrice).length + 1;
  const relativeDiscount = Number((stats.medianPrice - referencePrice).toFixed(10));

  return {
    priceRank,
    relativeDiscount,
    medianPrice: stats.medianPrice,
    peerCount: stats.peerPrices.length,
  };
}

function logRelativeValueSkip(tokenState, watchItem, assessment, config, referencePrice) {
  if (!shouldLogAt(tokenState.lastRelativeValueSkipLogAt, RELATIVE_VALUE_SKIP_LOG_INTERVAL_MS)) {
    return false;
  }

  const loggedAt = now();
  tokenState.lastRelativeValueSkipLogAt = loggedAt;
  console.log(
    `[${loggedAt}] Relative value skip | ${getWatchItemLogPrefix(watchItem)} | ask ${formatPrice(referencePrice)} | median ${formatPrice(assessment?.medianPrice)} | discount ${formatPrice(assessment?.relativeDiscount)} | rank ${assessment?.priceRank}/${assessment?.peerCount} | minDiscount ${formatPrice(config.relativeMispricingMinDiscount)} | maxRank ${config.relativeMispricingMaxPriceRank}`,
  );
  return true;
}

function printConfigSummary(config, watchItems, statePath, clientContext) {
  console.log("策略配置");
  console.log("========");
  console.log(`节点: ${clientContext.host}`);
  console.log(`链: ${clientContext.chainId}`);
  console.log(`签名类型: ${clientContext.signatureType}`);
  console.log(`签名地址: ${clientContext.signer.address}`);
  console.log(`资金地址: ${clientContext.funderAddress}`);
  console.log(`轮询间隔: ${config.pollIntervalMs} ms`);
  console.log(`触发阈值: ${config.triggerYesPrice}`);
  console.log(`挂单价格: ${config.orderYesPrice}`);
  console.log(`重新激活阈值: ${config.rearmYesPrice}`);
  console.log(`下单份额: ${config.orderSize}`);
  console.log(`最小 BUY 深度: ${config.minTriggerLiquidityShares}`);
  console.log(`最小 SELL 深度: ${config.minTakeProfitLiquidityShares}`);
  console.log(`单事件最多策略标的: ${config.maxStrategyTokensPerEvent}`);
  console.log(`相对错价过滤: ${config.relativeMispricingFilterEnabled}`);
  console.log(`相对错价最小折价: ${config.relativeMispricingMinDiscount}`);
  console.log(`相对错价最大排名: ${config.relativeMispricingMaxPriceRank}`);
  console.log(`启用止盈: ${config.takeProfitEnabled}`);
  console.log(`固定止盈价格: ${config.takeProfitTargetPrice}`);
  console.log(`订单类型: ${config.orderType}`);
  console.log(`仅挂单: ${config.postOnly}`);
  console.log(`模拟模式: ${config.dryRun}`);
  console.log(`自动发现天气市场: ${config.autoDiscoverWeatherMarkets}`);
  console.log(`城市: ${config.allowedCities.map(getCityLogLabel).join("、")}`);
  console.log(`天气类别: ${config.weatherCategory}`);
  console.log(`主导结果跳过阈值: ${config.dominantYesSkipThreshold}`);
  console.log(`气象预报过滤: ${config.weatherForecastFilterEnabled}`);
  console.log(`气象来源: ${config.weatherForecastProvider}`);
  console.log(`气象窗口: 预报高/低温上下 ${config.weatherForecastWindowC}\u00b0C`);
  console.log(`气象时区: ${config.weatherForecastTimezone}`);
  console.log(`温度规则: ${formatTemperatureRuleSummary(config)}`);
  console.log(`状态文件: ${statePath}`);
  console.log(`监控 YES 数量: ${watchItems.length}`);
  console.log(`Tail-NO strategy: ${config.tailNoStrategyEnabled}`);
  console.log(`Tail-NO order size: ${config.tailNoOrderSize}`);
  console.log(`Tail-NO max tokens per event: ${config.tailNoMaxStrategyTokensPerEvent}`);
  console.log(`Tail-NO cities: ${config.tailNoAllowedCities.map(getCityLogLabel).join("、")}`);
  console.log(`Tail-NO trigger price: ${config.tailNoTriggerPrice}`);
  console.log(`Tail-NO rearm price: ${config.tailNoRearmPrice}`);
  console.log(`Tail-NO max order price: ${config.tailNoMaxOrderPrice}`);
  console.log(`Tail-NO min bucket gap: ${config.tailNoMinBucketGapC}°C`);
  console.log(`Tail-NO max days ahead: ${config.tailNoMaxDaysAhead}`);
  console.log(`Tail-NO require dominant YES: ${config.tailNoRequireDominantYes}`);
  console.log(`Tail-NO dominant YES threshold: ${config.tailNoDominantYesThreshold}`);
}

function summarizeForecastWindows(watchItems) {
  const forecastWindows = new Map();

  for (const item of watchItems) {
    if (!item.weatherForecast) {
      continue;
    }

    const key = `${item.cityKey}::${getWatchItemDateLabel(item)}`;
    if (!forecastWindows.has(key)) {
      forecastWindows.set(key, item.weatherForecast);
    }
  }

  if (forecastWindows.size === 0) {
    return;
  }

  console.log("\n气象过滤");
  console.log("========");
  [...forecastWindows.values()]
    .sort((left, right) => `${left.dateKey}:${left.cityKey}`.localeCompare(`${right.dateKey}:${right.cityKey}`))
    .forEach((forecastWindow, index) => {
      console.log(
        `${index + 1}. ${getCityLogLabel(forecastWindow.cityKey)} | ${forecastWindow.dateKey} | ${formatForecastWindow(forecastWindow)}`,
      );
    });
}

function summarizeMonitoringRanges(watchItems) {
  const ranges = new Map();

  for (const item of watchItems) {
    const key = `${item.cityKey}::${getWatchItemDateLabel(item)}`;
    const existing = ranges.get(key) ?? {
      cityKey: item.cityKey,
      dateKey: getWatchItemDateLabel(item),
      weatherForecast: item.weatherForecast,
      buckets: [],
    };
    existing.buckets.push(`${String(item.outcomeLabel || "yes").toUpperCase()} ${formatTemperatureBucket(item.temperatureBucket)}`);
    ranges.set(key, existing);
  }

  console.log("监控范围");
  console.log("========");
  [...ranges.values()]
    .sort((left, right) => `${left.dateKey}:${left.cityKey}`.localeCompare(`${right.dateKey}:${right.cityKey}`))
    .forEach((range, index) => {
      const forecastText = range.weatherForecast
        ? ` | ${formatForecastWindow(range.weatherForecast)}`
        : "";
      console.log(
        `${index + 1}. ${getCityLogLabel(range.cityKey)} | ${range.dateKey}${forecastText} | 选项 ${range.buckets.join(", ")}`,
      );
    });
}

function summarizeWatchItems(watchItems) {
  console.log("\n已解析市场");
  console.log("=========");
  watchItems.forEach((item, index) => {
    const forecastText = item.weatherForecast ? ` | ${formatForecastWindow(item.weatherForecast)}` : "";
    console.log(
      `${index + 1}. ${getCityLogLabel(item.cityKey || item.cityLabel)} | ${getWatchItemDateLabel(item)} | ${String(item.outcomeLabel || "yes").toUpperCase()} ${formatTemperatureBucket(item.temperatureBucket)}${forecastText} | ${item.marketSlug}`,
    );
  });
}

function summarizeMonitoringPlan(watchItems) {
  console.log("\n监控计划");
  console.log("========");

  watchItems.forEach((item, index) => {
    const forecastText = item.weatherForecast ? ` | ${formatForecastWindow(item.weatherForecast)}` : "";
    console.log(
      `${index + 1}. ${getCityLogLabel(item.cityKey || item.cityLabel)} | ${getWatchItemDateLabel(item)} | ${String(item.outcomeLabel || "yes").toUpperCase()} ${formatTemperatureBucket(item.temperatureBucket)}${forecastText} | ${item.marketSlug}`,
    );
  });
}

async function cancelExistingBuyOrders(client, tokenId, dryRun) {
  const openOrders = await client.getOpenOrders({ asset_id: tokenId });
  const existingBuyOrders = openOrders.filter((order) => order.side === Side.BUY);
  if (existingBuyOrders.length === 0) {
    return;
  }

  const orderIds = existingBuyOrders.map((order) => order.id);

  if (dryRun) {
    return;
  }

  if (orderIds.length === 1) {
    await client.cancelOrder({ orderID: orderIds[0] });
    return;
  }

  await client.cancelOrders(orderIds);
}

async function getOpenOrdersForSide(client, tokenId, side) {
  const openOrders = await client.getOpenOrders({ asset_id: tokenId });
  return openOrders.filter((order) => order.side === side);
}

function summarizeOrderResponse(response, config, watchItem) {
  const prefix = getWatchItemLogPrefix(watchItem);
  if (config.dryRun) {
    return `[${now()}] 模拟挂单成功 | ${prefix} | BUY YES @ ${formatPrice(config.orderYesPrice)} | ${config.orderSize} 份`;
  }

  const orderId = response?.orderID ?? response?.orderId ?? response?.id ?? null;
  if (orderId) {
    return `[${now()}] 挂单成功 | ${prefix} | BUY YES @ ${formatPrice(config.orderYesPrice)} | ${config.orderSize} 份 | 订单号 ${orderId}`;
  }

  return `[${now()}] 挂单成功 | ${prefix} | BUY YES @ ${formatPrice(config.orderYesPrice)} | ${config.orderSize} 份`;
}

function isTailNoWatchItem(watchItem) {
  return watchItem?.strategyType === "tail-no";
}

function getEntryOrderSize(config, watchItem) {
  return isTailNoWatchItem(watchItem) ? config.tailNoOrderSize : config.orderSize;
}

function getStrategyMaxTokensPerEvent(config, watchItem) {
  return isTailNoWatchItem(watchItem)
    ? config.tailNoMaxStrategyTokensPerEvent
    : config.maxStrategyTokensPerEvent;
}

function getStrategyAllowedCities(config, watchItem) {
  return isTailNoWatchItem(watchItem) ? config.tailNoAllowedCities : config.allowedCities;
}

function isStrategyCityAllowed(config, watchItem) {
  return getStrategyAllowedCities(config, watchItem).includes(watchItem.cityKey);
}

function getEventExposureKey(watchItem) {
  return `${watchItem.eventSlug}::${watchItem.strategyType ?? "threshold-yes"}`;
}

function supportsTakeProfit(watchItem, config) {
  return !isTailNoWatchItem(watchItem) && config.takeProfitEnabled;
}

function getEntryTriggerPrice(config, watchItem) {
  return isTailNoWatchItem(watchItem) ? config.tailNoTriggerPrice : config.triggerYesPrice;
}

function getRearmPrice(config, watchItem) {
  return isTailNoWatchItem(watchItem) ? config.tailNoRearmPrice : config.rearmYesPrice;
}

function shouldRearmEntry(referencePrice, config, watchItem) {
  if (referencePrice === null) {
    return false;
  }

  return isTailNoWatchItem(watchItem)
    ? referencePrice <= config.tailNoRearmPrice
    : referencePrice >= config.rearmYesPrice;
}

function shouldTriggerEntry(referencePrice, config, watchItem) {
  if (referencePrice === null) {
    return false;
  }

  return isTailNoWatchItem(watchItem)
    ? referencePrice >= config.tailNoTriggerPrice
    : referencePrice < config.triggerYesPrice;
}

function getEntryOrderPrice(config, watchItem, referencePrice) {
  if (!isTailNoWatchItem(watchItem)) {
    return config.orderYesPrice;
  }

  const boundedReferencePrice = toNumber(referencePrice);
  if (boundedReferencePrice === null) {
    return config.tailNoTriggerPrice;
  }

  return Math.min(config.tailNoMaxOrderPrice, boundedReferencePrice);
}

function requiresRelativeMispricingFilter(config, watchItem) {
  return !isTailNoWatchItem(watchItem) && config.relativeMispricingFilterEnabled;
}

function passesTailNoDominantYesCheck(config, watchItem, eventSnapshot) {
  if (!isTailNoWatchItem(watchItem) || !config.tailNoRequireDominantYes) {
    return true;
  }

  return (eventSnapshot?.highestYesPrice ?? 0) >= config.tailNoDominantYesThreshold;
}

function summarizeEntryOrderResponse(response, config, watchItem) {
  const prefix = getWatchItemLogPrefix(watchItem);
  const outcomeLabel = String(watchItem.outcomeLabel || "yes").toUpperCase();
  const orderPrice = formatPrice(response?.desiredPrice ?? getEntryOrderPrice(config, watchItem, watchItem.outcomePrice));
  const orderSize = getEntryOrderSize(config, watchItem);
  if (config.dryRun) {
    return `[${now()}] Simulated entry | ${prefix} | BUY ${outcomeLabel} @ ${orderPrice} | ${orderSize} shares`;
  }

  const orderId = response?.orderID ?? response?.orderId ?? response?.id ?? null;
  if (orderId) {
    return `[${now()}] Entry placed | ${prefix} | BUY ${outcomeLabel} @ ${orderPrice} | ${orderSize} shares | order ${orderId}`;
  }

  return `[${now()}] Entry placed | ${prefix} | BUY ${outcomeLabel} @ ${orderPrice} | ${orderSize} shares`;
}

function summarizeTakeProfitOrderResponse(response, sellPrice, sellSize, config, watchItem) {
  const prefix = getWatchItemLogPrefix(watchItem);
  if (config.dryRun) {
    return `[${now()}] 模拟止盈挂单成功 | ${prefix} | SELL YES @ ${formatPrice(sellPrice)} | ${sellSize} 份`;
  }

  const orderId = response?.orderID ?? response?.orderId ?? response?.id ?? null;
  if (orderId) {
    return `[${now()}] 止盈挂单成功 | ${prefix} | SELL YES @ ${formatPrice(sellPrice)} | ${sellSize} 份 | 订单号 ${orderId}`;
  }

  return `[${now()}] 止盈挂单成功 | ${prefix} | SELL YES @ ${formatPrice(sellPrice)} | ${sellSize} 份`;
}

async function placeThresholdOrder(client, watchItem, tickSize, negRisk, config, referencePrice) {
  const desiredPrice = roundToTick(getEntryOrderPrice(config, watchItem, referencePrice), Number(tickSize));
  const desiredOrder = {
    tokenID: watchItem.tokenId,
    side: Side.BUY,
    price: desiredPrice,
    size: getEntryOrderSize(config, watchItem),
  };

  if (config.dryRun) {
    return { success: true, dryRun: true, orderID: null, desiredPrice };
  }

  const response = await withSuppressedClobLogs(
    (args) => isSuppressedClobOrderPlacementLog(args),
    () =>
      client.createAndPostOrder(
        desiredOrder,
        { tickSize, negRisk },
        config.orderType,
        config.postOnly,
      ),
  );

  return {
    ...response,
    desiredPrice,
  };
}

async function placeTakeProfitOrder(client, watchItem, tickSize, negRisk, config, targetPrice, sellSize) {
  const desiredOrder = {
    tokenID: watchItem.tokenId,
    side: Side.SELL,
    price: roundToTick(targetPrice, Number(tickSize)),
    size: sellSize,
  };

  if (config.dryRun) {
    return { success: true, dryRun: true, orderID: null };
  }

  return withSuppressedClobLogs(
    (args) => isSuppressedClobOrderPlacementLog(args),
    () =>
      client.createAndPostOrder(
        desiredOrder,
        { tickSize, negRisk },
        config.orderType,
        config.postOnly,
      ),
  );
}

async function handleExistingPosition(client, config, tokenState, watchItem, existingPositionSize) {
  const takeProfitState = tokenState.takeProfit;

  if (
    !supportsTakeProfit(watchItem, config) ||
    takeProfitState.entryPrice === null ||
    takeProfitState.targetPrice === null
  ) {
    if (shouldLogAt(tokenState.lastPositionSkipLogAt, POSITION_SKIP_LOG_INTERVAL_MS)) {
      tokenState.lastPositionSkipLogAt = now();
      return true;
    }
    return false;
  }

  if (takeProfitState.orderId) {
    if (shouldLogAt(takeProfitState.lastWaitLogAt, TAKE_PROFIT_WAIT_LOG_INTERVAL_MS)) {
      takeProfitState.lastWaitLogAt = now();
      return true;
    }
    return false;
  }

  let book;
  try {
    book = await getOrderBookQuietly(client, watchItem.tokenId);
  } catch (error) {
    if (error?.status === 404) {
      if (shouldLogNoOrderbook(tokenState)) {
        tokenState.lastNoOrderbookLogAt = now();
        return true;
      }
      return false;
    }

    if (isTransientOrderbookError(error)) {
      return logTransientOrderbookError(tokenState, watchItem, error);
    }

    throw error;
  }

  tokenState.lastNoOrderbookLogAt = null;

  const bestBidSize = getBestBidSize(book);
  if (bestBidSize !== null && bestBidSize < config.minTakeProfitLiquidityShares) {
    return logThinLiquiditySkip(
      tokenState,
      watchItem,
      "SELL",
      Number(bestBidSize.toFixed(4)),
      config.minTakeProfitLiquidityShares,
    );
  }

  const referencePrice = chooseTakeProfitReferencePrice(book, watchItem);

  if (referencePrice === null) {
    return false;
  }

  if (referencePrice < takeProfitState.targetPrice) {
    if (shouldLogAt(takeProfitState.lastWaitLogAt, TAKE_PROFIT_WAIT_LOG_INTERVAL_MS)) {
      takeProfitState.lastWaitLogAt = now();
      return true;
    }
    return false;
  }

  const existingSellOrders = await getOpenOrdersForSide(client, watchItem.tokenId, Side.SELL);
  if (existingSellOrders.length > 0) {
    takeProfitState.orderId = existingSellOrders[0]?.id ?? "existing-sell-order";
    takeProfitState.sellSize =
      takeProfitState.sellSize ?? roundShareSize(existingPositionSize * takeProfitState.sellFraction);
    takeProfitState.lastWaitLogAt = now();
    return true;
  }

  const sellSize =
    takeProfitState.sellSize ??
    roundShareSize(existingPositionSize * (takeProfitState.sellFraction ?? 1));

  if (sellSize <= 0) {
    return false;
  }

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(watchItem.tokenId),
    client.getNegRisk(watchItem.tokenId),
  ]);

  const response = await placeTakeProfitOrder(
    client,
    watchItem,
    tickSize,
    negRisk,
    config,
    takeProfitState.targetPrice,
    sellSize,
  );

  takeProfitState.sellSize = sellSize;
  takeProfitState.orderId = response?.orderID ?? (config.dryRun ? "dry-run-take-profit" : null);
  takeProfitState.triggeredAt = now();
  takeProfitState.lastWaitLogAt = null;

  console.log(summarizeTakeProfitOrderResponse(response, takeProfitState.targetPrice, sellSize, config, watchItem));
  return true;
}

async function evaluateWatchItem(client, config, state, watchItem, runtimeContext) {
  const tokenState = getTokenState(state, watchItem.tokenId);
  tokenState.eventSlug = watchItem.eventSlug;
  tokenState.marketSlug = watchItem.marketSlug;
  tokenState.question = watchItem.question;

  if (!config.dryRun && !tokenState.armed && tokenState.lastOrderId === null) {
    tokenState.armed = true;
    tokenState.lastExecutionMode = null;
  }

  const existingPositionSize = runtimeContext.positionsByTokenId.get(String(watchItem.tokenId)) ?? 0;
  if (
    existingPositionSize > 0 &&
    supportsTakeProfit(watchItem, config) &&
    tokenState.lastExecutionMode === "live" &&
    (
      tokenState.takeProfit.entryPrice === null ||
      tokenState.takeProfit.targetPrice !== config.takeProfitTargetPrice ||
      tokenState.takeProfit.sellFraction !== 1
    )
  ) {
    tokenState.takeProfit =
      buildTakeProfitPlan(config, tokenState.takeProfit.entryPrice ?? config.orderYesPrice) ?? tokenState.takeProfit;
  }

  if (existingPositionSize > 0) {
    const changed = await handleExistingPosition(
      client,
      config,
      tokenState,
      watchItem,
      existingPositionSize,
    );
    return changed;
  }

  const eventSnapshot = runtimeContext.eventSnapshots.get(watchItem.eventSlug);
  if (!isTailNoWatchItem(watchItem) && eventSnapshot?.hasDominantYes) {
    if (shouldLogAt(tokenState.lastDominantEventSkipLogAt, DOMINANT_EVENT_SKIP_LOG_INTERVAL_MS)) {
      tokenState.lastDominantEventSkipLogAt = now();
      return true;
    }
    return false;
  }

  tokenState.lastPositionSkipLogAt = null;
  tokenState.lastDominantEventSkipLogAt = null;

  if (!passesTailNoDominantYesCheck(config, watchItem, eventSnapshot)) {
    return false;
  }

  const tokenId = String(watchItem.tokenId);
  const hasOpenBuyOrder = (runtimeContext.openBuyOrdersByTokenId.get(tokenId) ?? []).length > 0;
  const eventExposureKey = getEventExposureKey(watchItem);
  const activeStrategyTokenCount = runtimeContext.activeStrategyTokenCountByEvent.get(eventExposureKey) ?? 0;
  const maxStrategyTokensPerEvent = getStrategyMaxTokensPerEvent(config, watchItem);
  if (!hasOpenBuyOrder && activeStrategyTokenCount >= maxStrategyTokensPerEvent) {
    return logEventExposureSkip(
      tokenState,
      watchItem,
      activeStrategyTokenCount,
      maxStrategyTokensPerEvent,
    );
  }

  let book;
  try {
    book = await getOrderBookQuietly(client, watchItem.tokenId);
  } catch (error) {
    if (error?.status === 404) {
      if (shouldLogNoOrderbook(tokenState)) {
        tokenState.lastNoOrderbookLogAt = now();
        return true;
      }
      return false;
    }

    if (isTransientOrderbookError(error)) {
      return logTransientOrderbookError(tokenState, watchItem, error);
    }
    throw error;
  }

  tokenState.lastNoOrderbookLogAt = null;

  const bestAskSize = getBestAskSize(book);
  if (bestAskSize !== null && bestAskSize < config.minTriggerLiquidityShares) {
    return logThinLiquiditySkip(
      tokenState,
      watchItem,
      "BUY",
      Number(bestAskSize.toFixed(4)),
      config.minTriggerLiquidityShares,
    );
  }

  const referencePrice = chooseReferencePrice(book, watchItem);
  tokenState.lastSeenPrice = referencePrice;

  if (referencePrice === null) {
    return false;
  }

  if (!tokenState.armed && shouldRearmEntry(referencePrice, config, watchItem)) {
    tokenState.armed = true;
    return true;
  }

  if (!tokenState.armed) {
    return false;
  }

  if (!shouldTriggerEntry(referencePrice, config, watchItem)) {
    return false;
  }

  const relativeStats = runtimeContext.eventRelativeStatsByEvent.get(watchItem.eventSlug);
  const relativeAssessment = assessRelativeMispricing(relativeStats, referencePrice);
  if (
    requiresRelativeMispricingFilter(config, watchItem) &&
    relativeAssessment &&
    (
      relativeAssessment.relativeDiscount < config.relativeMispricingMinDiscount ||
      relativeAssessment.priceRank > config.relativeMispricingMaxPriceRank
    )
  ) {
    return logRelativeValueSkip(tokenState, watchItem, relativeAssessment, config, referencePrice);
  }

  const tradeBlockReason = buildTradeBlockReason(
    runtimeContext.collateralStatus,
    config,
    watchItem,
    referencePrice,
  );
  if (tradeBlockReason) {
    if (shouldLogAt(lastInsufficientCollateralLogAt, INSUFFICIENT_COLLATERAL_LOG_INTERVAL_MS)) {
      lastInsufficientCollateralLogAt = now();
    }
    return false;
  }

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(watchItem.tokenId),
    client.getNegRisk(watchItem.tokenId),
  ]);

  await cancelExistingBuyOrders(client, watchItem.tokenId, config.dryRun);

  let response;
  try {
    response = await placeThresholdOrder(client, watchItem, tickSize, negRisk, config, referencePrice);
  } catch (error) {
    if (isInsufficientBalanceAllowanceError(error)) {
      if (shouldLogAt(lastInsufficientCollateralLogAt, INSUFFICIENT_COLLATERAL_LOG_INTERVAL_MS)) {
        lastInsufficientCollateralLogAt = now();
      }
      return false;
    }

    return false;
  }

  tokenState.armed = false;
  tokenState.lastTriggeredPrice = referencePrice;
  tokenState.lastTriggerAt = now();
  tokenState.lastOrderId = response?.orderID ?? null;
  tokenState.lastExecutionMode = config.dryRun ? "dry-run" : "live";
  runtimeContext.activeStrategyTokenCountByEvent.set(
    eventExposureKey,
    Math.max(activeStrategyTokenCount, hasOpenBuyOrder ? activeStrategyTokenCount : activeStrategyTokenCount + 1),
  );
  if (supportsTakeProfit(watchItem, config)) {
    tokenState.takeProfit =
      buildTakeProfitPlan(config, roundToTick(getEntryOrderPrice(config, watchItem, referencePrice), Number(tickSize))) ?? {
        entryPrice: null,
        targetPrice: null,
        sellFraction: null,
        sellSize: null,
        orderId: null,
        triggeredAt: null,
        lastWaitLogAt: null,
      };
  }

  console.log(summarizeEntryOrderResponse(response, config, watchItem));
  return true;
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(process.cwd(), cliOptions.configPath);
  console.log(`Loading config: ${configPath}`);
  const rawConfig = await loadConfig(configPath);
  const config = normalizeConfig(rawConfig, cliOptions);
  const statePath = path.resolve(process.cwd(), config.stateFile);
  const state = await loadState(statePath);
  console.log(`Execution mode: ${config.dryRun ? "dry-run" : "live"}`);
  console.log("Authenticating Polymarket client...");
  process.env.POLYMARKET_QUIET_AUTH = "1";
  const clientContext = await createAuthenticatedClient();
  const stopHeartbeat = config.dryRun ? null : startHeartbeatLoop(clientContext.client, { label: "threshold-buyer" });
  console.log("Resolving configured markets...");
  try {
    const watchItems = await resolveConfiguredMarkets(config);

    if (watchItems.length === 0) {
      throw new Error("没有解析到可监控的 YES 市场，请检查配置或自动发现规则。");
    }

    console.log(`Resolved ${watchItems.length} YES markets.`);
    summarizeMonitoringRanges(watchItems);

    while (true) {
      let stateChanged = false;
      const runtimeContext = await buildRuntimeContext(clientContext, watchItems, config);

      for (const watchItem of watchItems) {
        try {
          const changed = await evaluateWatchItem(
            clientContext.client,
            config,
            state,
            watchItem,
            runtimeContext,
          );
          stateChanged = stateChanged || changed;
        } catch (error) {
          void error;
        }
      }

      if (stateChanged && !config.dryRun) {
        await saveState(statePath, state);
      }

      await sleep(config.pollIntervalMs);
    }
  } finally {
    stopHeartbeat?.();
  }
}

main().catch((error) => {
  console.error("\n策略启动失败");
  console.error(buildKnownErrorSummary(error));

  if (error?.status) {
    console.error(`状态码: ${error.status}`);
  }

  if (error?.data) {
    console.error(JSON.stringify(error.data, null, 2));
  }

  process.exit(1);
});
