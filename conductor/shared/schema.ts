import { z } from "zod";

/** Bounded opaque identifier shared by the Agents and Concerts contracts. */
export const identifier = z.string().min(1).max(512);
