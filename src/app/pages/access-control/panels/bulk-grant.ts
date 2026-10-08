/** What happened to one module in a bulk grant. */
export interface BulkOutcome {
  module_gid: string;
  ok: boolean;
  /** HTTP status of the failure, when there was one. */
  status?: number;
  /** The server's own explanation, when it gave one. */
  detail?: string;
}

/**
 * Grant the same access to many modules for one user.
 *
 * The server has no multi-module grant, so this makes one call per module -
 * a few at a time rather than all at once, so ticking 40 modules does not fire
 * 40 requests together. One module failing never stops the rest: every module
 * gets an outcome, and the caller shows which ones did not take.
 *
 * `grant` is the single-module call; it should reject on failure. The reject
 * value is read for `response.status` and `response.data.detail`, which is the
 * shape axios errors have.
 */
export async function runBulkGrant(
  gids: readonly string[],
  grant: (module_gid: string) => Promise<unknown>,
  concurrency = 4,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkOutcome[]> {
  const total = gids.length;
  const results: BulkOutcome[] = new Array(total);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < total) {
      const i = next++;
      const module_gid = gids[i];
      try {
        await grant(module_gid);
        results[i] = { module_gid, ok: true };
      } catch (err: any) {
        const detail = err?.response?.data?.detail;
        results[i] = {
          module_gid,
          ok: false,
          status: err?.response?.status,
          detail: typeof detail === 'string' ? detail : (err?.message ?? undefined),
        };
      }
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), total) }, worker));
  return results;
}

/** One plain sentence for why a module did not take the grant. */
export function bulkFailureReason(o: BulkOutcome, email: string): string {
  if (o.status === 404) return `"${email}" isn't registered - the user has to sign up first.`;
  if (o.status === 403) return "You don't manage this module, so you can't grant access on it.";
  return o.detail || 'The server did not accept it.';
}
