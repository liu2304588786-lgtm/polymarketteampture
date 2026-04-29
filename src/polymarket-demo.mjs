import axios from "axios";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const CLOB_BASE_URL = "https://clob.polymarket.com";

function parseArgs(argv) {
  const options = {
    limit: 5,
    depth: 5,
    slug: null,
    marketId: null,
    tokenId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--limit") {
      options.limit = parsePositiveInt(argv[++index], "--limit");
      continue;
    }

    if (arg === "--depth") {
      options.depth = parsePositiveInt(argv[++index], "--depth");
      continue;
    }

    if (arg === "--slug") {
      options.slug = argv[++index] ?? null;
      continue;
    }

    if (arg === "--market-id") {
      options.marketId = argv[++index] ?? null;
      continue;
    }

    if (arg === "--token-id") {
      options.tokenId = argv[++index] ?? null;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }

  return parsed;
}

function printHelp() {
  console.log(`
Polymarket minimal demo

Usage:
  npm run demo -- [--limit 5] [--depth 5]
  npm run demo -- --slug <market-slug>
  npm run demo -- --market-id <market-id>
  npm run demo -- --token-id <token-id>

Examples:
  npm run demo
  npm run demo -- --limit 3 --depth 10
  npm run demo -- --slug will-bitcoin-hit-150k-in-2026
  npm run demo -- --token-id 1234567890
`);
}

async function fetchJson(url) {
  const requestConfig = {
    headers: {
      Accept: "application/json",
      "User-Agent": "polymarket-demo/0.1",
    },
    timeout: 30000,
  };

  const proxyConfig = buildProxyConfig();
  if (proxyConfig) {
    requestConfig.proxy = proxyConfig;
  }

  try {
    const response = await axios.get(url.toString(), requestConfig);
    return response.data;
  } catch (error) {
    if (error.response) {
      const body =
        typeof error.response.data === "string"
          ? error.response.data
          : JSON.stringify(error.response.data);
      throw new Error(`Request failed: ${error.response.status} ${error.response.statusText}\n${body}`);
    }

    const cause = error?.cause?.message || error?.message;
    const causeMessage = cause ? `\nCause: ${cause}` : "";
    throw new Error(`Network request failed for ${url}.${causeMessage}`);
  }
}

function buildProxyConfig() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    null;

  if (!proxyUrl) {
    return null;
  }

  const parsedProxyUrl = new URL(proxyUrl);
  const proxyConfig = {
    protocol: parsedProxyUrl.protocol.replace(":", ""),
    host: parsedProxyUrl.hostname,
    port: parsedProxyUrl.port ? Number(parsedProxyUrl.port) : undefined,
  };

  if (parsedProxyUrl.username || parsedProxyUrl.password) {
    proxyConfig.auth = {
      username: decodeURIComponent(parsedProxyUrl.username),
      password: decodeURIComponent(parsedProxyUrl.password),
    };
  }

  return proxyConfig;
}

function buildMarketsUrl(options) {
  const url = new URL("/markets", GAMMA_BASE_URL);
  url.searchParams.set("limit", String(options.limit));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  return url;
}

function buildMarketBySlugUrl(slug) {
  return new URL(`/markets/slug/${slug}`, GAMMA_BASE_URL);
}

function buildMarketByIdUrl(marketId) {
  return new URL(`/markets/${marketId}`, GAMMA_BASE_URL);
}

function buildOrderBookUrl(tokenId) {
  const url = new URL("/book", CLOB_BASE_URL);
  url.searchParams.set("token_id", tokenId);
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

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPrice(value) {
  const parsed = safeNumber(value);
  return parsed === null ? "n/a" : parsed.toFixed(3);
}

function formatVolume(value) {
  const parsed = safeNumber(value);
  return parsed === null ? "n/a" : parsed.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortQuestion(question, maxLength = 88) {
  if (!question) {
    return "Untitled market";
  }

  return question.length > maxLength ? `${question.slice(0, maxLength - 1)}...` : question;
}

function printMarketList(markets) {
  console.log("\nActive markets");
  console.log("==============");

  markets.forEach((market, index) => {
    const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
    const yesToken = tokenIds[0] ?? "n/a";
    const noToken = tokenIds[1] ?? "n/a";
    const bestBid = formatPrice(market.bestBid);
    const bestAsk = formatPrice(market.bestAsk);

    console.log(`${index + 1}. ${shortQuestion(market.question)}`);
    console.log(`   id: ${market.id} | slug: ${market.slug}`);
    console.log(`   best bid/ask: ${bestBid} / ${bestAsk} | volume: ${formatVolume(market.volume ?? market.volumeNum)}`);
    console.log(`   yes token: ${yesToken}`);
    console.log(`   no token:  ${noToken}`);
  });
}

function printOrderBook(orderBook, label, depth) {
  console.log(`\n${label} orderbook`);
  console.log("--------------");
  console.log(`asset: ${orderBook.asset_id}`);
  console.log(`market: ${orderBook.market}`);
  console.log(`last trade: ${formatPrice(orderBook.last_trade_price)} | tick: ${orderBook.tick_size} | min size: ${orderBook.min_order_size}`);

  const asks = Array.isArray(orderBook.asks) ? orderBook.asks.slice(0, depth) : [];
  const bids = Array.isArray(orderBook.bids) ? orderBook.bids.slice(0, depth) : [];

  console.log("asks:");
  if (asks.length === 0) {
    console.log("  (empty)");
  } else {
    asks.forEach((level, index) => {
      console.log(`  ${index + 1}. price=${formatPrice(level.price)} size=${level.size}`);
    });
  }

  console.log("bids:");
  if (bids.length === 0) {
    console.log("  (empty)");
  } else {
    bids.forEach((level, index) => {
      console.log(`  ${index + 1}. price=${formatPrice(level.price)} size=${level.size}`);
    });
  }
}

async function resolveMarket(options) {
  if (options.tokenId) {
    return {
      market: null,
      tokenIds: [options.tokenId],
    };
  }

  let market;

  if (options.slug) {
    market = await fetchJson(buildMarketBySlugUrl(options.slug));
  } else if (options.marketId) {
    market = await fetchJson(buildMarketByIdUrl(options.marketId));
  } else {
    const markets = await fetchJson(buildMarketsUrl(options));
    if (!Array.isArray(markets) || markets.length === 0) {
      throw new Error("No active markets returned from Gamma API.");
    }

    printMarketList(markets);
    market = markets[0];
  }

  const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
  if (tokenIds.length === 0) {
    throw new Error("Selected market does not expose clobTokenIds.");
  }

  return { market, tokenIds };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { market, tokenIds } = await resolveMarket(options);

  if (market) {
    console.log("\nSelected market");
    console.log("===============");
    console.log(shortQuestion(market.question, 140));
    console.log(`id: ${market.id}`);
    console.log(`slug: ${market.slug}`);
    console.log(`tokens: ${tokenIds.join(", ")}`);
  } else {
    console.log(`Using token id: ${tokenIds[0]}`);
  }

  const labels = tokenIds.length >= 2 ? ["YES", "NO"] : ["TOKEN"];

  for (let index = 0; index < tokenIds.length; index += 1) {
    const tokenId = tokenIds[index];
    const orderBook = await fetchJson(buildOrderBookUrl(tokenId));
    printOrderBook(orderBook, labels[index] ?? `TOKEN ${index + 1}`, options.depth);
  }
}

main().catch((error) => {
  console.error("\nDemo failed.");
  console.error(error.message);

  if (error.stack) {
    const stackLines = error.stack.split("\n").slice(1, 3);
    if (stackLines.length > 0) {
      console.error(stackLines.join("\n"));
    }
  }

  process.exit(1);
});
