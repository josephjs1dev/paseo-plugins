import { COMMAND_LIMITS } from "./limits";

/** Shared by the emitted CLI and the host-launched stdio MCP bridge. */
export const COMMAND_REQUEST_SOURCE =
  `const commandLimits = ${JSON.stringify(COMMAND_LIMITS)};\n` +
  String.raw`
async function requestCommand(agentId, socketPath, command) {
  const body = JSON.stringify({ agentId, command });
  if (Buffer.byteLength(body) > commandLimits.inputBytes) throw new Error("Command input exceeds 256 KiB.");
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/command", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data) > commandLimits.responseBytes) { response.destroy(); reject(new Error("Command response exceeds its limit.")); }
      });
      response.on("error", () => reject(new Error("Command acknowledgement is uncertain. Inspect the symphony before retrying with the same attempt identity.")));
      response.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { reject(new Error("Conductor returned an invalid response.")); return; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Conductor returned an invalid response.")); return;
        }
        if (response.statusCode !== 200) reject(new Error(typeof parsed.error === "string" ? parsed.error : "Conductor command failed."));
        else resolve(parsed);
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Command acknowledgement is uncertain. Inspect the symphony before retrying; reuse its start key/attempt identity.")), commandLimits.clientTimeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => reject(new Error(error.code ? "Conductor command connection failed (" + error.code + "). Check the plugin or refresh the agent session." : error.message)));
    request.end(body);
  });
}
`;
