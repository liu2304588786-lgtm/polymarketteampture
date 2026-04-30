function extractHeartbeatId(payload) {
  const candidate =
    payload?.heartbeat_id ??
    payload?.heartbeatId ??
    payload?.data?.heartbeat_id ??
    payload?.data?.heartbeatId ??
    payload?.response?.data?.heartbeat_id ??
    payload?.response?.data?.heartbeatId ??
    null;

  return candidate === null || candidate === undefined || candidate === "" ? null : String(candidate);
}

function extractErrorMessage(error) {
  return error?.data?.error ?? error?.response?.data?.error ?? error?.message ?? "unknown heartbeat error";
}

export function startHeartbeatLoop(client, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 5000;
  const label = options.label ? String(options.label) : "heartbeat";
  const log = options.log ?? console;

  let stopped = false;
  let timer = null;
  let heartbeatId = "";

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    if (stopped) {
      return;
    }

    try {
      const response = await client.postHeartbeat(heartbeatId);
      const nextHeartbeatId = extractHeartbeatId(response);
      if (nextHeartbeatId) {
        heartbeatId = nextHeartbeatId;
      }
    } catch (error) {
      const nextHeartbeatId = extractHeartbeatId(error);
      if (nextHeartbeatId) {
        heartbeatId = nextHeartbeatId;

        try {
          const retryResponse = await client.postHeartbeat(heartbeatId);
          const retryHeartbeatId = extractHeartbeatId(retryResponse);
          if (retryHeartbeatId) {
            heartbeatId = retryHeartbeatId;
          }
        } catch (retryError) {
          log.warn?.(
            `[${new Date().toISOString()}] heartbeat warning (${label}): ${extractErrorMessage(retryError)}`,
          );
        }
      } else {
        log.warn?.(`[${new Date().toISOString()}] heartbeat warning (${label}): ${extractErrorMessage(error)}`);
      }
    } finally {
      scheduleNext();
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
