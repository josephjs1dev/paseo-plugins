import { useEffect } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { observeDirectory } from "./observation";

/**
 * Invalidates a TanStack query key whenever the daemon reports agent or
 * concert directory changes. Keeps `usePaseo` behind client/paseo/.
 */
export function useDirectoryInvalidation(key: string[]): void {
  const paseo = usePaseo();
  const cache = useQueryClient();
  useEffect(
    () =>
      observeDirectory(paseo, () => {
        void cache.invalidateQueries({ queryKey: key });
      }),
    [paseo, cache],
  );
}
