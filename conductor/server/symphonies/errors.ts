/** An expected symphony failure whose message is safe to show to agents and the UI. */
export class SymphonyError extends Error {}

/** Paseo or policy refused a task agent launch; no agent was created. */
export class LaunchRejectedError extends SymphonyError {}
