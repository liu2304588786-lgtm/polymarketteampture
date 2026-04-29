import { access, readFile } from "node:fs/promises";
import path from "node:path";
import axios from "axios";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const OPEN_METEO_ARCHIVE_BASE_URL = "https://archive-api.open-meteo.com";
const DEFAULT_CONFIG_PATH = "config.markets.json";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_PAGE_LIMIT = 100;
const FETCH_JSON_MAX_ATTEMPTS = 4;
const FETCH_JSON_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_WEATHER_CATEGORY = "highestTemperature";
const DEFAULT_BUCKET_MODE = "round";
const DEFAULT_OUTPUT_FORMAT = "table";
const DEFAULT_WEATHER_TIMEZONE = "Asia/Shanghai";
const DEFAULT_ALLOWED_CITIES = ["Shenzhen", "Shanghai", "Beijing", "Hong Kong", "Guangzhou", "Taipei"];
const DEFAULT_WEATHER_FORECAST_CITY_COORDINATES = {
  shenzhen: { latitude: 22.5431, longitude: 114.0579 },
  shanghai: { latitude: 31.2304, longitude: 121.4737 },
  beijing: { latitude: 39.9042, longitude: 116.4074 },
  "hong-kong": { latitude: 22.3193, longitude: 114.1694 },
  guangzhou: { latitude: 23.1291, longitude: 113.2644 },
  taipei: { latitude: 25.033, longitude: 121.5654 },
};
const WEATHER_CATEGORY_TITLE_SEARCH = {
  highestTemperature: "Highest temperature in",
  lowestTemperature: "Lowest temperature in",
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
    aliases: ["shenzhen"],
  },
  {
    key: "shanghai",
    label: "Shanghai",
    aliases: ["shanghai"],
  },
  {
    key: "beijing",
    label: "Beijing",
    aliases: ["beijing"],
  },
  {
    key: "hong-kong",
    label: "Hong Kong",
    aliases: ["hong kong", "hongkong"],
  },
  {
    key: "guangzhou",
    label: "Guangzhou",
    aliases: ["guangzhou"],
  },
  {
    key: "taipei",
    label: "Taipei",
    aliases: ["taipei", "taipei city"],
  },
];

function printHelp() {
  console.log(`
Compare Open-Meteo historical temperatures against Polymarket's settled weather buckets.

Usage:
  npm run backtest-weather -- --date 2026-04-24 --cities Shanghai
  npm run backtest-weather -- --from 2026-04-20 --to 2026-04-24 --cities Shanghai,Beijing
  npm run backtest-weather:clash -- --from 2026-04-01 --to 2026-04-24

Options:
  --config <path>            Optional config file. Defaults to ./config.markets.json when present.
  --date <YYYY-MM-DD>        Shortcut for --from and --to using the same date.
  --from <YYYY-MM-DD>        Start date, inclusive.
  --to <YYYY-MM-DD>          End date, inclusive.
  --cities <list>            Comma-separated city list. Defaults to config.allowedCities or built-in cities.
  --weather-category <type>  highestTemperature | lowestTemperature
  --bucket-mode <mode>       round | floor | ceil
  --format <type>            table | json
  --help                     Show this help.

Notes:
  - This script compares Polymarket's settled winning bucket to a bucket derived from
    Open-Meteo archive data.
  - It does not use Polymarket's resolution source as the weather truth source.
  - When no date range is provided, it defaults to the last ${DEFAULT_LOOKBACK_DAYS} completed calendar days.
`);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    configExplicit: false,
    date: null,
    from: null,
    to: null,
    cities: null,
    weatherCategory: null,
    bucketMode: null,
    outputFormat: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--config") {
      options.configPath = argv[++index] ?? DEFAULT_CONFIG_PATH;
      options.configExplicit = true;
      continue;
    }

    if (arg === "--date") {
      options.date = argv[++index] ?? null;
      continue;
    }

    if (arg === "--from") {
      options.from = argv[++index] ?? null;
      continue;
    }

    if (arg === "--to") {
      options.to = argv[++index] ?? null;
      continue;
    }

    if (arg === "--cities") {
      options.cities = argv[++index] ?? null;
      continue;
    }

    if (arg === "--weather-category") {
      options.weatherCategory = argv[++index] ?? null;
      continue;
    }

    if (arg === "--bucket-mode") {
      options.bucketMode = argv[++index] ?? null;
      continue;
    }

    if (arg === "--format") {
      options.outputFormat = argv[++index] ?? null;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format.`);
  }

  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error(`${fieldName} must be a valid calendar date.`);
  }

  return parsed;
}

function formatDateRangeBoundary(dateKey, isStart) {
  return `${dateKey}T${isStart ? "00:00:00" : "23:59:59"}Z`;
}

function getCityDefinitionByKey(cityKey) {
  return CITY_DEFINITIONS.find((definition) => definition.key === cityKey) ?? null;
}

function getCityDisplayLabel(cityKey) {
  return getCityDefinitionByKey(cityKey)?.label ?? cityKey;
}

function inferCityKeyFromText(value) {
  const combined = normalizeText(value);
  for (const definition of CITY_DEFINITIONS) {
    const aliases = [definition.key, definition.label, ...definition.aliases];
    if (
      aliases.some((alias) => {
        const normalizedAlias = normalizeText(alias);
        return normalizedAlias ? combined.includes(normalizedAlias) : false;
      })
    ) {
      return definition.key;
    }
  }

  return null;
}

function normalizeCityList(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (rawItems.length === 0) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const rawItem of rawItems) {
    const cityKey = inferCityKeyFromText(rawItem);
    if (!cityKey) {
      throw new Error(`Unsupported city: ${rawItem}`);
    }

    if (!seen.has(cityKey)) {
      seen.add(cityKey);
      normalized.push(cityKey);
    }
  }

  return normalized;
}

function normalizeWeatherCategory(value) {
  const normalized = String(value || DEFAULT_WEATHER_CATEGORY).trim();
  if (normalized !== "highestTemperature" && normalized !== "lowestTemperature") {
    throw new Error("weatherCategory must be highestTemperature or lowestTemperature.");
  }
  return normalized;
}

function normalizeBucketMode(value) {
  const normalized = String(value || DEFAULT_BUCKET_MODE).trim().toLowerCase();
  if (!["round", "floor", "ceil"].includes(normalized)) {
    throw new Error("bucketMode must be round, floor, or ceil.");
  }
  return normalized;
}

function normalizeOutputFormat(value) {
  const normalized = String(value || DEFAULT_OUTPUT_FORMAT).trim().toLowerCase();
  if (!["table", "json"].includes(normalized)) {
    throw new Error("format must be table or json.");
  }
  return normalized;
}

function normalizeTimezone(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_WEATHER_TIMEZONE;
  }
  return value.trim();
}

function normalizeCoordinates(rawValue, allowedCities) {
  const normalized = {};

  for (const cityKey of allowedCities) {
    const defaults = DEFAULT_WEATHER_FORECAST_CITY_COORDINATES[cityKey];
    if (!defaults) {
      throw new Error(`No default coordinates configured for ${getCityDisplayLabel(cityKey)}.`);
    }
    normalized[cityKey] = { ...defaults };
  }

  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return normalized;
  }

  for (const [rawCity, rawCoordinates] of Object.entries(rawValue)) {
    const cityKey = inferCityKeyFromText(rawCity);
    if (!cityKey || !allowedCities.includes(cityKey)) {
      continue;
    }

    const latitude = toNumber(rawCoordinates?.latitude);
    const longitude = toNumber(rawCoordinates?.longitude);
    if (latitude === null || longitude === null) {
      throw new Error(`weatherForecastCityCoordinates.${rawCity} must include numeric latitude and longitude.`);
    }

    normalized[cityKey] = { latitude, longitude };
  }

  return normalized;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadOptionalConfig(configPath, explicit) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  const exists = await fileExists(resolvedPath);

  if (!exists) {
    if (explicit) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return {
      resolvedPath,
      rawConfig: null,
      loaded: false,
    };
  }

  const raw = await readFile(resolvedPath, "utf8");
  return {
    resolvedPath,
    rawConfig: JSON.parse(raw),
    loaded: true,
  };
}

function buildDefaultDateRange() {
  const today = new Date();
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (DEFAULT_LOOKBACK_DAYS - 1));
  return {
    fromDate: from,
    toDate: to,
  };
}

function resolveDateRange(cliOptions) {
  if (cliOptions.date) {
    const date = parseDateKey(cliOptions.date, "--date");
    return {
      fromDate: date,
      toDate: date,
    };
  }

  if (cliOptions.from && cliOptions.to) {
    return {
      fromDate: parseDateKey(cliOptions.from, "--from"),
      toDate: parseDateKey(cliOptions.to, "--to"),
    };
  }

  if (cliOptions.from) {
    const date = parseDateKey(cliOptions.from, "--from");
    return {
      fromDate: date,
      toDate: date,
    };
  }

  if (cliOptions.to) {
    const date = parseDateKey(cliOptions.to, "--to");
    return {
      fromDate: date,
      toDate: date,
    };
  }

  return buildDefaultDateRange();
}

function buildRuntimeConfig(rawConfig, cliOptions, configMeta) {
  const dateRange = resolveDateRange(cliOptions);
  if (dateRange.fromDate.getTime() > dateRange.toDate.getTime()) {
    throw new Error("--from must be earlier than or equal to --to.");
  }

  const allowedCities =
    cliOptions.cities !== null
      ? normalizeCityList(cliOptions.cities)
      : normalizeCityList(rawConfig?.allowedCities ?? DEFAULT_ALLOWED_CITIES);
  if (allowedCities.length === 0) {
    throw new Error("At least one city must be configured.");
  }

  const weatherCategory = normalizeWeatherCategory(
    cliOptions.weatherCategory ?? rawConfig?.weatherCategory ?? DEFAULT_WEATHER_CATEGORY,
  );
  const bucketMode = normalizeBucketMode(cliOptions.bucketMode ?? DEFAULT_BUCKET_MODE);
  const outputFormat = normalizeOutputFormat(cliOptions.outputFormat ?? DEFAULT_OUTPUT_FORMAT);
  const timezone = normalizeTimezone(rawConfig?.weatherForecastTimezone ?? DEFAULT_WEATHER_TIMEZONE);

  return {
    configPath: configMeta.resolvedPath,
    configLoaded: configMeta.loaded,
    allowedCities,
    weatherCategory,
    bucketMode,
    outputFormat,
    timezone,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    fromDateKey: formatDateKey(dateRange.fromDate),
    toDateKey: formatDateKey(dateRange.toDate),
    cityCoordinates: normalizeCoordinates(rawConfig?.weatherForecastCityCoordinates, allowedCities),
  };
}

function isRetryableFetchJsonError(error) {
  const status = error?.response?.status;
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = String(error?.code || "").toUpperCase();
  return ["ECONNABORTED", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT"].includes(code);
}

async function fetchJson(url, maxAttempts = FETCH_JSON_MAX_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(String(url), {
        timeout: 30000,
        headers: {
          "User-Agent": "polymarket-weather-backtest/0.1",
        },
      });
      return response.data;
    } catch (error) {
      if (attempt < maxAttempts && isRetryableFetchJsonError(error)) {
        await sleep(FETCH_JSON_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
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

function buildOpenMeteoArchiveUrl(pathname, params = {}) {
  const url = new URL(pathname, OPEN_METEO_ARCHIVE_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
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

function getEventDateKey(event) {
  const parsed = parseWeatherDate(event?.title) || parseWeatherDate(event?.slug);
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return formatDateKey(parsed);
  }

  const endDate = String(event?.endDate || "");
  const datePart = endDate.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function isWeatherSeriesEvent(event) {
  const combined = normalizeText(`${event?.title || ""} ${event?.slug || ""}`);
  return combined.includes("temperature") || combined.includes("weather");
}

function matchesWeatherCategory(event, weatherCategory) {
  const combined = normalizeText(`${event?.title || ""} ${event?.slug || ""}`);

  if (weatherCategory === "highestTemperature") {
    return combined.includes("highest temperature") || combined.includes("max temperature");
  }

  return combined.includes("lowest temperature") || combined.includes("min temperature");
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

function formatTemperatureBucket(bucket) {
  if (!bucket) {
    return "n/a";
  }

  if (bucket.kind === "exact") {
    return `${bucket.value}C`;
  }
  if (bucket.kind === "lte") {
    return `<=${bucket.value}C`;
  }
  if (bucket.kind === "gte") {
    return `${bucket.value}C+`;
  }
  return "n/a";
}

function formatTemperatureValue(value) {
  const parsed = toNumber(value);
  return parsed === null ? "n/a" : `${Number(parsed.toFixed(1))}C`;
}

function getOutcomePriceByLabel(market, label) {
  const outcomes = parseMaybeJsonArray(market?.outcomes);
  const prices = parseMaybeJsonArray(market?.outcomePrices);
  const outcomeIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === label.toLowerCase());
  if (outcomeIndex === -1) {
    return null;
  }

  return toNumber(prices[outcomeIndex]);
}

function selectWinningMarket(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const winningMarkets = markets.filter((market) => getOutcomePriceByLabel(market, "yes") === 1);
  if (winningMarkets.length === 1) {
    return winningMarkets[0];
  }
  return null;
}

function isEligibleHistoricalEvent(event, cityKey, config) {
  if (!event?.slug || event?.closed !== true) {
    return false;
  }
  if (!isWeatherSeriesEvent(event)) {
    return false;
  }
  if (!matchesWeatherCategory(event, config.weatherCategory)) {
    return false;
  }
  if (inferCityKeyFromText(`${event?.title || ""} ${event?.slug || ""}`) !== cityKey) {
    return false;
  }

  const eventDateKey = getEventDateKey(event);
  if (!eventDateKey) {
    return false;
  }

  return eventDateKey >= config.fromDateKey && eventDateKey <= config.toDateKey;
}

async function fetchClosedEventsForCity(cityKey, config) {
  const titleSearch = `${WEATHER_CATEGORY_TITLE_SEARCH[config.weatherCategory]} ${getCityDisplayLabel(cityKey)}`;
  const unique = new Map();
  let offset = 0;

  while (true) {
    const page = await fetchJson(
      buildGammaUrl("/events", {
        closed: true,
        title_search: titleSearch,
        limit: DEFAULT_PAGE_LIMIT,
        offset,
        order: "endDate",
        ascending: true,
        end_date_min: formatDateRangeBoundary(config.fromDateKey, true),
        end_date_max: formatDateRangeBoundary(config.toDateKey, false),
      }),
    );

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    for (const event of page) {
      if (isEligibleHistoricalEvent(event, cityKey, config)) {
        unique.set(event.slug, event);
      }
    }

    if (page.length < DEFAULT_PAGE_LIMIT) {
      break;
    }

    offset += DEFAULT_PAGE_LIMIT;
  }

  return [...unique.values()].sort((left, right) => {
    const leftDate = getEventDateKey(left) ?? "";
    const rightDate = getEventDateKey(right) ?? "";
    return leftDate.localeCompare(rightDate) || String(left.slug).localeCompare(String(right.slug));
  });
}

async function fetchHistoricalWeather(cityKey, dateKey, config) {
  const coordinates = config.cityCoordinates[cityKey];
  if (!coordinates) {
    throw new Error(`No coordinates configured for ${getCityDisplayLabel(cityKey)}.`);
  }

  const data = await fetchJson(
    buildOpenMeteoArchiveUrl("/v1/archive", {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      daily: "temperature_2m_max,temperature_2m_min",
      timezone: config.timezone,
      start_date: dateKey,
      end_date: dateKey,
    }),
  );

  const daily = data?.daily ?? {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const index = times.findIndex((time) => String(time) === dateKey);
  if (index === -1) {
    throw new Error(`No historical weather returned for ${getCityDisplayLabel(cityKey)} ${dateKey}.`);
  }

  const highC = toNumber(daily.temperature_2m_max?.[index]);
  const lowC = toNumber(daily.temperature_2m_min?.[index]);
  const actualTempC = config.weatherCategory === "lowestTemperature" ? lowC ?? highC : highC ?? lowC;

  if (actualTempC === null) {
    throw new Error(`Historical weather is missing a usable temperature for ${getCityDisplayLabel(cityKey)} ${dateKey}.`);
  }

  return {
    cityKey,
    dateKey,
    highC,
    lowC,
    actualTempC,
  };
}

function deriveReferenceInteger(actualTempC, bucketMode) {
  if (bucketMode === "floor") {
    return Math.floor(actualTempC);
  }
  if (bucketMode === "ceil") {
    return Math.ceil(actualTempC);
  }
  return Math.round(actualTempC);
}

function deriveBucketFromReferenceValue(referenceValue, buckets) {
  const exactBuckets = buckets.filter((bucket) => bucket.kind === "exact");
  const lteBuckets = buckets
    .filter((bucket) => bucket.kind === "lte")
    .sort((left, right) => left.value - right.value);
  const gteBuckets = buckets
    .filter((bucket) => bucket.kind === "gte")
    .sort((left, right) => left.value - right.value);

  const exactBucket = exactBuckets.find((bucket) => bucket.value === referenceValue);
  if (exactBucket) {
    return exactBucket;
  }

  const lteBucket = lteBuckets.find((bucket) => referenceValue <= bucket.value);
  if (lteBucket) {
    return lteBucket;
  }

  for (let index = gteBuckets.length - 1; index >= 0; index -= 1) {
    if (referenceValue >= gteBuckets[index].value) {
      return gteBuckets[index];
    }
  }

  return null;
}

function sameBucket(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

async function backtestEvent(cityKey, event, config) {
  const cityLabel = getCityDisplayLabel(cityKey);
  const dateKey = getEventDateKey(event);
  const winningMarket = selectWinningMarket(event);
  const winningBucket = winningMarket ? parseTemperatureBucket(winningMarket) : null;
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const candidateBuckets = markets
    .map((market) => parseTemperatureBucket(market))
    .filter(Boolean);

  let weather = null;
  let weatherError = null;
  try {
    weather = await fetchHistoricalWeather(cityKey, dateKey, config);
  } catch (error) {
    weatherError = error;
  }

  const actualTempC = weather?.actualTempC ?? null;
  const derivedReferenceValue = actualTempC === null ? null : deriveReferenceInteger(actualTempC, config.bucketMode);
  const archiveBucket =
    derivedReferenceValue === null ? null : deriveBucketFromReferenceValue(derivedReferenceValue, candidateBuckets);

  let status = "ok";
  if (!winningMarket || !winningBucket) {
    status = "missing-polymarket-settlement";
  } else if (weatherError) {
    status = "missing-historical-weather";
  } else if (!archiveBucket) {
    status = "missing-derived-bucket";
  }

  return {
    cityKey,
    cityLabel,
    dateKey,
    eventSlug: event.slug,
    eventTitle: event.title,
    resolutionSource: event?.resolutionSource ?? null,
    actualTempC,
    highC: weather?.highC ?? null,
    lowC: weather?.lowC ?? null,
    derivedReferenceValue,
    archiveBucket,
    polymarketBucket: winningBucket,
    polymarketQuestion: winningMarket?.question ?? null,
    match: status === "ok" ? sameBucket(archiveBucket, winningBucket) : null,
    status,
    weatherErrorMessage: weatherError?.message ?? null,
  };
}

function toPrintableMatch(value) {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "-";
}

function formatTable(rows) {
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => String(row[columnIndex]).length)),
  );

  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, columnIndex) => {
          const text = String(cell);
          return rowIndex === 0 ? text.padEnd(widths[columnIndex], " ") : text.padEnd(widths[columnIndex], " ");
        })
        .join("  "),
    )
    .join("\n");
}

function buildSummary(results) {
  const comparable = results.filter((result) => result.status === "ok");
  const matches = comparable.filter((result) => result.match === true).length;
  const mismatches = comparable.filter((result) => result.match === false).length;
  const skipped = results.length - comparable.length;

  return {
    total: results.length,
    comparable: comparable.length,
    matches,
    mismatches,
    skipped,
  };
}

function printTableResults(results, config) {
  const summary = buildSummary(results);

  console.log(`Config file: ${config.configLoaded ? config.configPath : "(not loaded)"}`);
  console.log(`Range: ${config.fromDateKey} -> ${config.toDateKey}`);
  console.log(`Cities: ${config.allowedCities.map((cityKey) => getCityDisplayLabel(cityKey)).join(", ")}`);
  console.log(`Category: ${config.weatherCategory}`);
  console.log(`Bucket mode: ${config.bucketMode}`);
  console.log(`Timezone: ${config.timezone}`);
  console.log(
    `Results: total=${summary.total}, comparable=${summary.comparable}, matches=${summary.matches}, mismatches=${summary.mismatches}, skipped=${summary.skipped}`,
  );
  console.log("");

  if (results.length === 0) {
    console.log("No closed weather events matched the requested range.");
    return;
  }

  const rows = [
    ["Date", "City", "Archive", "Derived", "Polymarket", "Match", "Status"],
    ...results.map((result) => [
      result.dateKey,
      result.cityLabel,
      formatTemperatureValue(result.actualTempC),
      result.archiveBucket ? `${formatTemperatureBucket(result.archiveBucket)} (${result.derivedReferenceValue})` : "n/a",
      formatTemperatureBucket(result.polymarketBucket),
      toPrintableMatch(result.match),
      result.status,
    ]),
  ];

  console.log(formatTable(rows));

  const mismatchRows = results.filter((result) => result.match === false);
  if (mismatchRows.length > 0) {
    console.log("");
    console.log("Mismatches");
    console.log("----------");
    mismatchRows.forEach((result, index) => {
      console.log(
        `${index + 1}. ${result.cityLabel} ${result.dateKey} | archive ${formatTemperatureValue(result.actualTempC)} -> ${formatTemperatureBucket(result.archiveBucket)} | Polymarket ${formatTemperatureBucket(result.polymarketBucket)} | ${result.eventSlug}`,
      );
    });
  }

  const skippedRows = results.filter((result) => result.status !== "ok");
  if (skippedRows.length > 0) {
    console.log("");
    console.log("Skipped");
    console.log("-------");
    skippedRows.forEach((result, index) => {
      const detail = result.weatherErrorMessage ? ` | ${result.weatherErrorMessage}` : "";
      console.log(`${index + 1}. ${result.cityLabel} ${result.dateKey} | ${result.status}${detail}`);
    });
  }
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const configMeta = await loadOptionalConfig(cliOptions.configPath, cliOptions.configExplicit);
  const config = buildRuntimeConfig(configMeta.rawConfig, cliOptions, configMeta);

  if (config.outputFormat !== "json") {
    console.log("Discovering closed Polymarket weather events...");
  }
  const results = [];
  for (const cityKey of config.allowedCities) {
    const events = await fetchClosedEventsForCity(cityKey, config);
    for (const event of events) {
      results.push(await backtestEvent(cityKey, event, config));
    }
  }

  results.sort((left, right) => {
    return left.dateKey.localeCompare(right.dateKey) || left.cityLabel.localeCompare(right.cityLabel);
  });

  if (config.outputFormat === "json") {
    console.log(
      JSON.stringify(
        {
          config: {
            configPath: config.configLoaded ? config.configPath : null,
            fromDateKey: config.fromDateKey,
            toDateKey: config.toDateKey,
            allowedCities: config.allowedCities.map((cityKey) => getCityDisplayLabel(cityKey)),
            weatherCategory: config.weatherCategory,
            bucketMode: config.bucketMode,
            timezone: config.timezone,
          },
          summary: buildSummary(results),
          results: results.map((result) => ({
            ...result,
            archiveBucket: result.archiveBucket ? formatTemperatureBucket(result.archiveBucket) : null,
            polymarketBucket: result.polymarketBucket ? formatTemperatureBucket(result.polymarketBucket) : null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  printTableResults(results, config);
}

main().catch((error) => {
  console.error("\nBacktest failed");
  console.error(error?.message ?? String(error));
  process.exit(1);
});
