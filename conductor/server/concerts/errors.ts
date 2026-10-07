/** An expected concert failure whose message is safe to show to agents and the UI. */
export class ConcertError extends Error {}

/** Paseo or policy refused a worker launch; no agent was created. */
export class LaunchRejectedError extends ConcertError {}
