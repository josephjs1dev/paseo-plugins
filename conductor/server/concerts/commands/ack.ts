// Agents see concert naming; stored records and UI RPCs keep run names.
export function concertAck(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { run, runs, ...rest } = value as Record<string, unknown>;
  const id = run && typeof run === "object" && "id" in run ? run.id : undefined;
  return {
    ...rest,
    ...(run === undefined ? {} : { concertId: id, concert: run }),
    ...(runs === undefined ? {} : { concerts: runs }),
  };
}
