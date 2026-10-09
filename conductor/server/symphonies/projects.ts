import type { ConcertEntry } from "../../shared/concert";
import type {
  SymphonyListEntry,
  SymphonySummary,
} from "../../shared/symphonies/models";

/** The group for a symphony whose source concert is not in the directory. */
export const OTHER_SYMPHONIES = "Other symphonies";

/** Storage's listing and its coverage metadata, before project annotation. */
export interface SymphonyListStorage {
  symphonies: SymphonySummary[];
  unavailable: number;
  incomplete: boolean;
}

/** The `symphonies.list` payload after project annotation. */
export interface SymphonyListResult {
  symphonies: SymphonyListEntry[];
  unavailable: number;
  incomplete: boolean;
}

function projectName(value: string | undefined): string {
  return (value ?? OTHER_SYMPHONIES).slice(0, 1000);
}

/**
 * Annotate symphony summaries with the current project of their source
 * concert. Grouping is cosmetic, so a concert that is missing from the
 * directory (or a directory that could not be read) falls back to
 * `OTHER_SYMPHONIES` instead of hiding the symphony.
 */
export function withProjectNames(
  symphonies: readonly SymphonySummary[],
  concerts: readonly ConcertEntry[],
): SymphonyListEntry[] {
  const byConcert = new Map(
    concerts.map((concert) => [concert.id, concert.projectName]),
  );
  return symphonies.map((symphony) => ({
    ...symphony,
    projectName: projectName(byConcert.get(symphony.source.concertId)),
  }));
}

/**
 * Compose the `symphonies.list` payload from storage and the concert
 * directory. Both loads run in parallel. A directory that cannot be read is
 * treated as empty: grouping is cosmetic and must not hide a symphony. The
 * storage coverage metadata is reported unchanged, and an optional
 * `concertId` narrows the listing before annotation. A storage rejection
 * propagates so the caller's error handling still reports it.
 */
export async function listWithProjects(
  list: () => Promise<SymphonyListStorage>,
  concerts: () => Promise<readonly ConcertEntry[]>,
  concertId?: string,
): Promise<SymphonyListResult> {
  const [stored, directory] = await Promise.all([
    list(),
    // Grouping is cosmetic; an unreadable directory must not hide symphonies.
    concerts().catch((): readonly ConcertEntry[] => []),
  ]);
  const visible = stored.symphonies.filter(
    (symphony) => !concertId || symphony.source.concertId === concertId,
  );
  return {
    symphonies: withProjectNames(visible, directory),
    unavailable: stored.unavailable,
    incomplete: stored.incomplete,
  };
}
