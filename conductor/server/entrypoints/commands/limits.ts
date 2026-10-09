/** Shared transport budgets for the daemon and emitted CLI/MCP clients. */
export const COMMAND_LIMITS = {
  inputBytes: 256 * 1024,
  responseBytes: 2_200_000,
  mcpMessageBytes: 300_000,
  serverTimeoutMs: 12_000,
  clientTimeoutMs: 15_000,
  inFlight: 16,
  connections: 32,
  socketPathBytes: 100,
} as const;
