// Agent acknowledgements expose the stored symphony id under a stable key.
export function symphonyAck(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { symphony, symphonies, ...rest } = value as Record<string, unknown>;
  const id =
    symphony && typeof symphony === "object" && "id" in symphony
      ? symphony.id
      : undefined;
  return {
    ...rest,
    ...(symphony === undefined ? {} : { symphonyId: id, symphony: symphony }),
    ...(symphonies === undefined ? {} : { symphonies: symphonies }),
  };
}
