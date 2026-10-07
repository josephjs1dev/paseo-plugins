import { join } from "node:path";
import { z } from "zod";
import {
  keySchema,
  receiptSchema,
  type Receipt,
} from "../../shared/agents/models";
import { atomicJson, claimJson, readJson } from "../files";

const annotationSchema = z.object({
  key: keySchema,
  until: z.number().nullable(),
  marked: z.boolean(),
});
export type Annotation = z.infer<typeof annotationSchema>;
export interface InboxStore {
  claim(receipt: Receipt): Promise<boolean>;
  receipt(key: string): Promise<Receipt | undefined>;
  complete(receipt: Receipt): Promise<void>;
  recent(): Promise<Receipt[]>;
  annotation(key: string): Promise<Annotation | undefined>;
  annotate(value: Annotation): Promise<void>;
}
export function fileStore(directory: string): InboxStore {
  const path = (kind: string, key: string) =>
    join(directory, kind, `${keySchema.parse(key)}.json`);
  // A bounded recent-actions index keeps each inbox refresh independent of ledger size.
  // Receipt files remain authoritative and are never pruned while they may fence a native request.
  const historyPath = join(directory, "recent.json");
  const historySchema = z.array(receiptSchema).max(30);
  let historyWrite = Promise.resolve();
  const history = async (): Promise<Receipt[]> => {
    const raw = await readJson(historyPath);
    return raw === undefined ? [] : historySchema.parse(raw);
  };
  const record = (receipt: Receipt): Promise<void> => {
    const write = historyWrite.then(async () => {
      const prior = await history();
      await atomicJson(
        historyPath,
        [receipt, ...prior.filter((item) => item.key !== receipt.key)].slice(
          0,
          30,
        ),
      );
    });
    historyWrite = write.catch(() => undefined);
    return write;
  };
  return {
    async claim(value) {
      const claimed = await claimJson(
        path("receipts", value.key),
        receiptSchema.parse(value),
      );
      if (claimed) {
        await record(value);
      }
      return claimed;
    },
    async receipt(key) {
      const raw = await readJson(path("receipts", key));
      return raw === undefined ? undefined : receiptSchema.parse(raw);
    },
    async complete(value) {
      await atomicJson(path("receipts", value.key), receiptSchema.parse(value));
      await record(value);
    },
    recent: history,
    async annotation(key) {
      const raw = await readJson(path("annotations", key));
      return raw === undefined ? undefined : annotationSchema.parse(raw);
    },
    annotate: (value) =>
      atomicJson(path("annotations", value.key), annotationSchema.parse(value)),
  };
}
