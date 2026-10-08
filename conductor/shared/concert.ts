/**
 * A Paseo workspace, as Conductor sees it. Only the Paseo adapter knows the
 * Paseo workspace identity behind `id`.
 */
export interface Concert {
  /** Opaque Conductor id; the adapter maps it to a Paseo workspace ID. */
  id: string;
  name: string;
  directory: string | null;
}

/** One concert as the Podium's Agents section lists it, with its project. */
export interface ConcertEntry {
  id: string;
  name: string;
  projectName: string;
}
