import { spawn } from "node:child_process";
import { Socket } from "node:net";

const [, , targetScript, ...forwardedArgs] = process.argv;
const DEFAULT_PROXY_URL = "http://127.0.0.1:7897";
const PROXY_CHECK_TIMEOUT_MS = 1500;

if (!targetScript) {
  console.error("Missing target script path.");
  process.exit(1);
}

function getProxyUrl() {
  return process.env.CLASH_PROXY_URL || process.env.POLYMARKET_CLASH_PROXY_URL || DEFAULT_PROXY_URL;
}

function getProxyPort(proxyUrl) {
  if (proxyUrl.port) {
    return Number(proxyUrl.port);
  }

  if (proxyUrl.protocol === "http:") {
    return 80;
  }

  if (proxyUrl.protocol === "https:") {
    return 443;
  }

  throw new Error(`Proxy URL must include a port: ${proxyUrl.href}`);
}

function checkTcpConnection(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error(`connection timed out after ${timeoutMs} ms`)));
    socket.once("error", finish);
    socket.connect(port, host);
  });
}

function buildProxyError(proxyUrl, error) {
  return [
    `Cannot connect to Clash proxy at ${proxyUrl}.`,
    `Details: ${error.message}`,
    "",
    "Start Clash and make sure its HTTP or mixed proxy port matches this URL.",
    "If Clash uses a different port, set CLASH_PROXY_URL before running, for example:",
    '  $env:CLASH_PROXY_URL="http://127.0.0.1:7890"',
    "  npm run threshold-buyer:clash -- --config config.markets.example.json --live",
    "",
    "If your system/TUN proxy already handles Node traffic, run the non-:clash script instead.",
  ].join("\n");
}

async function ensureProxyIsReachable(proxyUrl) {
  if (process.env.CLASH_PROXY_SKIP_CHECK === "1") {
    return;
  }

  const parsedProxyUrl = new URL(proxyUrl);
  const host = parsedProxyUrl.hostname || "127.0.0.1";
  const port = getProxyPort(parsedProxyUrl);

  try {
    await checkTcpConnection(host, port, PROXY_CHECK_TIMEOUT_MS);
  } catch (error) {
    throw new Error(buildProxyError(proxyUrl, error));
  }
}

async function main() {
  const proxyUrl = getProxyUrl();
  await ensureProxyIsReachable(proxyUrl);

  const env = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
  };

  const child = spawn(process.execPath, [targetScript, ...forwardedArgs], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
