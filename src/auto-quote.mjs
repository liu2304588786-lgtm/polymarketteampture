import { OrderType, Side } from "@polymarket/clob-client-v2";
import { createAuthenticatedClient } from "./polymarket-client.mjs";

function printHelp() {
  console.log(`
Automatically maintain one resting Polymarket limit order

Usage:
  npm run auto-quote -- --token-id <id> --side BUY|SELL --size <shares> [options]

Required:
  --token-id <id>
  --side BUY|SELL
  --size <shares>

Strategy options:
  --improve-ticks <n>      Improve the same-side best price by n ticks. Default: 1
  --min-spread-ticks <n>   Keep at least this many ticks from the opposite side. Default: 2
  --replace-threshold-ticks <n>  Requote only if target moved by at least n ticks. Default: 1
  --max-price <n>          BUY only. Do not quote above this price
  --min-price <n>          SELL only. Do not quote below this price
  --poll-ms <n>            Loop interval in milliseconds. Default: 5000
  --expiration <unix>      Optional order expiration timestamp
  --order-type <GTC|GTD>   Default: GTC
  --post-only <true|false> Default: true
  --dry-run                Observe and print actions, but do not cancel or place

Examples:
  npm run auto-quote -- --token-id 123 --side BUY --size 25
  npm run auto-quote -- --token-id 123 --side BUY --size 25 --max-price 0.44
  npm run auto-quote -- --token-id 123 --side SELL --size 10 --min-spread-ticks 3 --poll-ms 3000
`);
}

function parseArgs(argv) {
  const options = {
    tokenId: null,
    side: null,
    size: null,
    improveTicks: 1,
    minSpreadTicks: 2,
    replaceThresholdTicks: 1,
    maxPrice: null,
    minPrice: null,
    pollMs: 5000,
    expiration: undefined,
    orderType: OrderType.GTC,
    postOnly: true,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--token-id") {
      options.tokenId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--side") {
      options.side = parseSide(argv[++index]);
      continue;
    }
    if (arg === "--size") {
      options.size = parsePositiveNumber(argv[++index], "--size");
      continue;
    }
    if (arg === "--improve-ticks") {
      options.improveTicks = parseNonNegativeInteger(argv[++index], "--improve-ticks");
      continue;
    }
    if (arg === "--min-spread-ticks") {
      options.minSpreadTicks = parsePositiveInteger(argv[++index], "--min-spread-ticks");
      continue;
    }
    if (arg === "--replace-threshold-ticks") {
      options.replaceThresholdTicks = parsePositiveInteger(argv[++index], "--replace-threshold-ticks");
      continue;
    }
    if (arg === "--max-price") {
      options.maxPrice = parsePositiveNumber(argv[++index], "--max-price");
      continue;
    }
    if (arg === "--min-price") {
      options.minPrice = parsePositiveNumber(argv[++index], "--min-price");
      continue;
    }
    if (arg === "--poll-ms") {
      options.pollMs = parsePositiveInteger(argv[++index], "--poll-ms");
      continue;
    }
    if (arg === "--expiration") {
      options.expiration = parsePositiveInteger(argv[++index], "--expiration");
      continue;
    }
    if (arg === "--order-type") {
      options.orderType = parseOrderType(argv[++index]);
      continue;
    }
    if (arg === "--post-only") {
      options.postOnly = parseBoolean(argv[++index], "--post-only");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.tokenId) {
    throw new Error("--token-id is required.");
  }
  if (!options.side) {
    throw new Error("--side is required.");
  }
  if (options.size === null) {
    throw new Error("--size is required.");
  }

  return options;
}

function parseSide(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === Side.BUY || normalized === Side.SELL) {
    return normalized;
  }
  throw new Error("--side must be BUY or SELL.");
}

function parseOrderType(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === OrderType.GTC || normalized === OrderType.GTD) {
    return normalized;
  }
  throw new Error("--order-type must be GTC or GTD.");
}

function parseBoolean(value, flagName) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flagName} must be true or false.`);
}

function parsePositiveNumber(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToTick(value, tickSize, side) {
  const scaled = value / tickSize;
  const rounded = side === Side.BUY ? Math.floor(scaled) : Math.ceil(scaled);
  return Number((rounded * tickSize).toFixed(10));
}

function formatPrice(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function getBestBid(book) {
  return toNumber(book?.bids?.[0]?.price);
}

function getBestAsk(book) {
  return toNumber(book?.asks?.[0]?.price);
}

function calculateTargetPrice(book, tickSize, options) {
  const bestBid = getBestBid(book);
  const bestAsk = getBestAsk(book);
  const improve = options.improveTicks * tickSize;
  const edge = options.minSpreadTicks * tickSize;
  let target;

  if (options.side === Side.BUY) {
    if (bestBid !== null) {
      target = bestBid + improve;
    } else if (bestAsk !== null) {
      target = bestAsk - edge;
    } else {
      throw new Error("Order book is empty on both sides.");
    }

    if (bestAsk !== null) {
      target = Math.min(target, bestAsk - edge);
    }
    if (options.maxPrice !== null) {
      target = Math.min(target, options.maxPrice);
    }
    target = Math.max(target, tickSize);
    return roundToTick(target, tickSize, Side.BUY);
  }

  if (bestAsk !== null) {
    target = bestAsk - improve;
  } else if (bestBid !== null) {
    target = bestBid + edge;
  } else {
    throw new Error("Order book is empty on both sides.");
  }

  if (bestBid !== null) {
    target = Math.max(target, bestBid + edge);
  }
  if (options.minPrice !== null) {
    target = Math.max(target, options.minPrice);
  }
  target = Math.min(target, 1 - tickSize);
  return roundToTick(target, tickSize, Side.SELL);
}

function isReplaceNeeded(openOrder, targetPrice, targetSize, tickSize, thresholdTicks) {
  if (!openOrder) {
    return true;
  }

  const openPrice = toNumber(openOrder.price);
  const openSize = toNumber(openOrder.original_size);
  if (openPrice === null || openSize === null) {
    return true;
  }

  const priceDiffTicks = Math.abs(openPrice - targetPrice) / tickSize;
  const sizeMismatch = Math.abs(openSize - targetSize) > 1e-9;
  return priceDiffTicks >= thresholdTicks || sizeMismatch;
}

function summarizeOrder(order) {
  if (!order) {
    return "none";
  }
  return `id=${order.id} price=${order.price} size=${order.original_size} status=${order.status}`;
}

function buildDesiredOrder(options, targetPrice) {
  return {
    tokenID: options.tokenId,
    side: options.side,
    price: targetPrice,
    size: options.size,
    ...(options.expiration ? { expiration: options.expiration } : {}),
  };
}

function printConfig(config) {
  console.log("Auto quote config");
  console.log("=================");
  console.log(`host: ${config.host}`);
  console.log(`chain: ${config.chainId}`);
  console.log(`signature type: ${config.signatureType}`);
  console.log(`signer: ${config.signerAddress}`);
  console.log(`funder: ${config.funderAddress}`);
  console.log(`token id: ${config.options.tokenId}`);
  console.log(`side: ${config.options.side}`);
  console.log(`size: ${config.options.size}`);
  console.log(`improve ticks: ${config.options.improveTicks}`);
  console.log(`min spread ticks: ${config.options.minSpreadTicks}`);
  console.log(`replace threshold ticks: ${config.options.replaceThresholdTicks}`);
  console.log(`poll ms: ${config.options.pollMs}`);
  console.log(`order type: ${config.options.orderType}`);
  console.log(`post only: ${config.options.postOnly}`);
  console.log(`dry run: ${config.options.dryRun}`);
}

async function cancelOrders(client, orders, dryRun) {
  if (orders.length === 0) {
    return;
  }

  const ids = orders.map((order) => order.id);
  console.log(`[${now()}] cancel ${ids.length} order(s): ${ids.join(", ")}`);

  if (dryRun) {
    return;
  }

  if (ids.length === 1) {
    await client.cancelOrder({ orderID: ids[0] });
    return;
  }

  await client.cancelOrders(ids);
}

async function placeOrder(client, desiredOrder, tickSize, negRisk, options) {
  console.log(
    `[${now()}] place ${desiredOrder.side} ${desiredOrder.size} @ ${formatPrice(desiredOrder.price)} postOnly=${options.postOnly}`,
  );

  if (options.dryRun) {
    return;
  }

  const response = await client.createAndPostOrder(
    desiredOrder,
    { tickSize: String(tickSize), negRisk },
    options.orderType,
    options.postOnly,
  );

  console.log(JSON.stringify(response, null, 2));
}

async function runLoop(client, options) {
  const [tickSizeRaw, negRisk] = await Promise.all([
    client.getTickSize(options.tokenId),
    client.getNegRisk(options.tokenId),
  ]);
  const tickSize = Number(tickSizeRaw);

  console.log("\nResolved market settings");
  console.log("========================");
  console.log(`tick size: ${tickSizeRaw}`);
  console.log(`neg risk: ${negRisk}`);

  while (true) {
    const [book, openOrders] = await Promise.all([
      client.getOrderBook(options.tokenId),
      client.getOpenOrders({ asset_id: options.tokenId }),
    ]);

    const sameSideOrders = openOrders
      .filter((order) => order.side === options.side)
      .sort((left, right) => Number(left.created_at) - Number(right.created_at));

    const activeOrder = sameSideOrders[0] ?? null;
    const extraOrders = sameSideOrders.slice(1);
    const targetPrice = calculateTargetPrice(book, tickSize, options);
    const desiredOrder = buildDesiredOrder(options, targetPrice);
    const shouldReplace = isReplaceNeeded(
      activeOrder,
      targetPrice,
      options.size,
      tickSize,
      options.replaceThresholdTicks,
    );

    console.log(`\n[${now()}] market snapshot`);
    console.log(`best bid: ${book?.bids?.[0]?.price ?? "none"} | best ask: ${book?.asks?.[0]?.price ?? "none"}`);
    console.log(`current order: ${summarizeOrder(activeOrder)}`);
    console.log(`extra orders: ${extraOrders.length}`);
    console.log(`target price: ${formatPrice(targetPrice)} | replace: ${shouldReplace}`);

    if (extraOrders.length > 0) {
      await cancelOrders(client, extraOrders, options.dryRun);
    }

    if (shouldReplace) {
      if (activeOrder) {
        await cancelOrders(client, [activeOrder], options.dryRun);
      }
      await placeOrder(client, desiredOrder, tickSize, negRisk, options);
    }

    await sleep(options.pollMs);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { client, signer, host, chainId, signatureType, funderAddress } = await createAuthenticatedClient();

  printConfig({
    host,
    chainId,
    signatureType,
    signerAddress: signer.address,
    funderAddress,
    options,
  });

  await runLoop(client, options);
}

main().catch((error) => {
  console.error("\nAuto quote failed.");
  console.error(error.message);

  if (error?.status) {
    console.error(`status: ${error.status}`);
  }

  if (error?.data) {
    console.error(JSON.stringify(error.data, null, 2));
  }

  process.exit(1);
});
