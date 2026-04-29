import "dotenv/config";
import axios from "axios";
import { Wallet } from "ethers";
import { Chain, ClobClient } from "@polymarket/clob-client-v2";

export const DEFAULT_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
export const DEFAULT_CHAIN = Number(process.env.POLYMARKET_CHAIN_ID || Chain.POLYGON);
export const DEFAULT_SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 0);
export const DEFAULT_CLOB_HTTP_TIMEOUT_MS = parsePositiveIntegerEnv("CLOB_HTTP_TIMEOUT_MS", 30000);

axios.defaults.timeout = DEFAULT_CLOB_HTTP_TIMEOUT_MS;

function parsePositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function buildApiCredsFromEnv() {
  const key = process.env.CLOB_API_KEY;
  const secret = process.env.CLOB_SECRET;
  const passphrase = process.env.CLOB_PASS_PHRASE;

  if (key && secret && passphrase) {
    return { key, secret, passphrase };
  }

  return null;
}

export function maskSecret(value, visible = 6) {
  if (!value) {
    return "n/a";
  }
  if (value.length <= visible * 2) {
    return `${value.slice(0, visible)}...`;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function isSuppressedClobAuthLog(args) {
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
    combined.includes("Could not create api key")
  );
}

async function withSuppressedExpectedClobLogs(callback) {
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (isSuppressedClobAuthLog(args)) {
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

function summarizeAuthFailure(result) {
  if (!result) {
    return null;
  }

  if (typeof result.error === "string") {
    return result.status ? `${result.error} (status ${result.status})` : result.error;
  }

  if (result.error) {
    try {
      const serialized = JSON.stringify(result.error);
      return result.status ? `${serialized} (status ${result.status})` : serialized;
    } catch {
      return String(result.error);
    }
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function buildCredentialError(result) {
  const detail = summarizeAuthFailure(result);
  const detailMessage = detail ? `\nCLOB auth detail: ${detail}` : "";
  return new Error(
    `Failed to create or derive Polymarket API credentials. Check your wallet, signature type, and account status.${detailMessage}`,
  );
}

export async function createAuthenticatedClient() {
  const privateKey = getRequiredEnv("PRIVATE_KEY");
  const signer = new Wallet(privateKey);
  const signatureType = DEFAULT_SIGNATURE_TYPE;
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || signer.address;

  if (signatureType !== 0 && !process.env.POLYMARKET_FUNDER_ADDRESS) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS is required for proxy or smart-contract wallet setups.");
  }

  const existingCreds = buildApiCredsFromEnv();
  const l1Client = new ClobClient({
    host: DEFAULT_HOST,
    chain: DEFAULT_CHAIN,
    signer,
    signatureType,
    funderAddress,
    // Keep L1 auth non-throwing so createOrDeriveApiKey can fall back to derive
    // when the API refuses to create a fresh key for an account that already has one.
    throwOnError: false,
  });

  let creds = existingCreds;
  if (!creds) {
    creds = await withSuppressedExpectedClobLogs(() => l1Client.createOrDeriveApiKey());
    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
      throw buildCredentialError(creds);
    }
    if (process.env.POLYMARKET_QUIET_AUTH !== "1") {
      console.log("\nDerived API credentials from wallet signature.");
      console.log("Store these if you want to skip derivation on future runs:");
      console.log(`CLOB_API_KEY=${creds.key}`);
      console.log(`CLOB_SECRET=${maskSecret(creds.secret)}`);
      console.log(`CLOB_PASS_PHRASE=${maskSecret(creds.passphrase)}`);
    }
  }

  const client = new ClobClient({
    host: DEFAULT_HOST,
    chain: DEFAULT_CHAIN,
    signer,
    creds,
    signatureType,
    funderAddress,
    throwOnError: true,
  });

  return {
    client,
    signer,
    creds,
    host: DEFAULT_HOST,
    chainId: DEFAULT_CHAIN,
    signatureType,
    funderAddress,
  };
}
