/** Command connection supplied by the entrypoint composition to task prompts. */
export interface SymphonyCommandAccess {
  available: boolean;
  commandPath: string | null;
  socketPath: string | null;
  message: string | null;
}
