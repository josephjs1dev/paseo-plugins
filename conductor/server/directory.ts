import type { Directory } from "./runtime";

export async function pages<T>(
  fetch: (cursor?: string) => Promise<Directory<T>>,
): Promise<{ entries: T[]; incomplete: boolean }> {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 10; index++) {
    const page = await fetch(cursor);
    entries.push(...page.entries);
    if (!page.next) {
      return { entries, incomplete: false };
    }
    if (cursors.has(page.next)) {
      return { entries, incomplete: true };
    }
    cursors.add(page.next);
    cursor = page.next;
  }
  return { entries, incomplete: true };
}
