import { OrderType, Side } from "@polymarket/clob-client-v2";
import { createAuthenticatedClient } from "./polymarket-client.mjs";
import { startHeartbeatLoop } from "./heartbeat.mjs";

function printHelp() {
  console.log(`
Place a Polymarket resting limit order

Usage:
  npm run place-limit -- --token-id <id> --side BUY|SELL --price <0-1> --size <shares> [options]

Required env:
  PRIVATE_KEY

Optional env:
  POLYMARKET_SIGNATURE_TYPE   0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=POLY_1271
  POLYMARKET_FUNDER_ADDRESS   defaults to signer address for type 0
  CLOB_API_KEY
  CLOB_SECRET
  CLOB_PASS_PHRASE

Options:
  --token-id <id>         Outcome token ID to trade
  --side <BUY|SELL>       Order side
  --price <number>        Limit price, usually between 0 and 1
  --size <number>         Order size in shares
  --expiration <unix>     Optional expiration timestamp
  --order-type <GTC|GTD>  Default: GTC
  --post-only <true|false> Default: true
  --keep-alive            Keep sending heartbeats so a resting order can stay live
  --heartbeat-ms <n>      Heartbeat interval in milliseconds. Default: 5000
  --dry-run               Create and sign the order, but do not post it
  --help                  Show this message

Examples:
  npm run place-limit -- --token-id 123 --side BUY --price 0.42 --size 25
  npm run place-limit -- --token-id 123 --side SELL --price 0.67 --size 10 --post-only false
  npm run place-limit -- --token-id 123 --side BUY --price 0.42 --size 25 --keep-alive
  npm run place-limit -- --token-id 123 --side BUY --price 0.39 --size 50 --dry-run
`);
}

function parseArgs(argv) {
  const options = {
    tokenId: null,
    side: null,
    price: null,
    size: null,
    expiration: undefined,
    orderType: OrderType.GTC,
    postOnly: true,
    keepAlive: false,
    heartbeatMs: 5000,
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

    if (arg === "--price") {
      options.price = parsePositiveNumber(argv[++index], "--price");
      continue;
    }

    if (arg === "--size") {
      options.size = parsePositiveNumber(argv[++index], "--size");
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

    if (arg === "--keep-alive") {
      options.keepAlive = true;
      continue;
    }

    if (arg === "--heartbeat-ms") {
      options.heartbeatMs = parsePositiveInteger(argv[++index], "--heartbeat-ms");
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
  if (options.price === null) {
    throw new Error("--price is required.");
  }
  if (options.size === null) {
    throw new Error("--size is required.");
  }

  if (options.price <= 0 || options.price >= 1) {
    console.warn("Warning: price is usually between 0 and 1 for Polymarket binary outcomes.");
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

function printConfigSummary(config) {
  console.log("Order config");
  console.log("============");
  console.log(`host: ${config.host}`);
  console.log(`chain: ${config.chainId}`);
  console.log(`signature type: ${config.signatureType}`);
  console.log(`signer: ${config.signerAddress}`);
  console.log(`funder: ${config.funderAddress}`);
  console.log(`token id: ${config.order.tokenID}`);
  console.log(`side: ${config.order.side}`);
  console.log(`price: ${config.order.price}`);
  console.log(`size: ${config.order.size}`);
  console.log(`order type: ${config.orderType}`);
  console.log(`post only: ${config.postOnly}`);
  console.log(`keep alive: ${config.keepAlive}`);
  console.log(`heartbeat ms: ${config.heartbeatMs}`);
  console.log(`expiration: ${config.order.expiration ?? 0}`);
}

function waitForTerminationSignal() {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (signal) => {
      if (resolved) {
        return;
      }
      resolved = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { client, signer, host, chainId, signatureType, funderAddress } = await createAuthenticatedClient();

  const order = {
    tokenID: args.tokenId,
    side: args.side,
    price: args.price,
    size: args.size,
    ...(args.expiration ? { expiration: args.expiration } : {}),
  };

  printConfigSummary({
    host,
    chainId,
    signatureType,
    signerAddress: signer.address,
    funderAddress,
    order,
    orderType: args.orderType,
    postOnly: args.postOnly,
    keepAlive: args.keepAlive,
    heartbeatMs: args.heartbeatMs,
  });

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(args.tokenId),
    client.getNegRisk(args.tokenId),
  ]);

  console.log("\nResolved market settings");
  console.log("========================");
  console.log(`tick size: ${tickSize}`);
  console.log(`neg risk: ${negRisk}`);

  if (args.dryRun) {
    const signedOrder = await client.createOrder(order, { tickSize, negRisk });
    console.log("\nDry run only. Signed order created but not posted.");
    console.log(JSON.stringify(signedOrder, null, 2));
    return;
  }

  const response = await client.createAndPostOrder(
    order,
    { tickSize, negRisk },
    args.orderType,
    args.postOnly,
  );

  console.log("\nOrder response");
  console.log("==============");
  console.log(JSON.stringify(response, null, 2));

  if (response?.success === false) {
    process.exitCode = 1;
    return;
  }

  if (!args.keepAlive) {
    console.warn(
      "\nWarning: latest Polymarket docs say resting orders require ongoing heartbeat requests. " +
      "Use --keep-alive if you want this one-shot script to keep the order live after posting.",
    );
    return;
  }

  const stopHeartbeat = startHeartbeatLoop(client, {
    intervalMs: args.heartbeatMs,
    label: "place-limit",
  });

  console.log("\nHeartbeat keep-alive started. Press Ctrl+C to stop and let the script exit.");
  try {
    await waitForTerminationSignal();
  } finally {
    stopHeartbeat();
  }
}

main().catch((error) => {
  console.error("\nPlace limit order failed.");
  console.error(error.message);

  if (error?.status) {
    console.error(`status: ${error.status}`);
  }

  if (error?.data) {
    console.error(JSON.stringify(error.data, null, 2));
  }

  process.exit(1);
});
