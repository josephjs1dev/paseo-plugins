import type { ConcertEntry } from "../../shared/concert";
import type {
  SymphonyListEntry,
  SymphonySummary,
} from "../../shared/symphonies/models";

/** The group for a symphony whose source concert is not in the directory. */
export const OTHER_SYMPHONIES = "Other symphonies";

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
