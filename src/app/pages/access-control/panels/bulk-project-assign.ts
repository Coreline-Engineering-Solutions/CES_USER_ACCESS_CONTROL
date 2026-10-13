import { GisProjectAssignResult } from '../../../services/gis-access.types';

/** What happened to one person in a bulk project assignment. */
export interface PersonOutcome {
  email: string;
  ok: boolean;
  /** Projects the server matched and gave. */
  assigned: string[];
  /** Project names the server did not recognise, so nobody got them. */
  missing: string[];
  /** HTTP status of the failure, when there was one. */
  status?: number;
  /** The server's own explanation, when it gave one. */
  detail?: string;
}

/**
 * Give the same projects to many people.
 *
 * `/admin/projects/assign` takes one person and many projects, so this makes
 * one call per person - a few at a time, not all at once. One person failing
 * never stops the rest: everybody gets an outcome, and the caller shows who
 * did not take it and why.
 *
 * `assign` is the single-person call; it should reject on failure. The reject
 * value is read for `response.status` and `response.data.detail`, the shape
 * axios errors have.
 */
export async function runBulkProjectAssign(
  emails: readonly string[],
  projectNames: readonly string[],
  assign: (email: string, projectNames: string[]) => Promise<Partial<GisProjectAssignResult> | undefined>,
  concurrency = 4,
  onProgress?: (done: number, total: number) => void,
): Promise<PersonOutcome[]> {
  const total = emails.length;
  const results: PersonOutcome[] = new Array(total);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < total) {
      const i = next++;
      const email = emails[i];
      try {
        const res = await assign(email, [...projectNames]);
        const missing = res?.missing ?? [];
        results[i] = {
          email,
          ok: true,
          // The server may not echo what it assigned; then everything it did not call missing was given.
          assigned: res?.assigned ?? projectNames.filter((n) => !missing.includes(n)),
          missing,
        };
      } catch (err: any) {
        const detail = err?.response?.data?.detail;
        results[i] = {
          email,
          ok: false,
          assigned: [],
          missing: [],
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

/** One plain sentence for why a person did not get the projects. */
export function personFailureReason(o: PersonOutcome): string {
  if (o.status === 404) return `"${o.email}" isn't registered, so the user has to sign up first.`;
  if (o.status === 403) return "You don't have permission to give project access.";
  return o.detail || 'The server did not accept it.';
}

/** The headline for a finished run, e.g. "Gave 2 projects to 4 people. 1 failed." */
export function bulkSummary(outcomes: readonly PersonOutcome[], projectCount: number): string {
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.length - ok.length;
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const projects = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;
  const head = ok.length ? `Gave ${projects} to ${people(ok.length)}.` : 'Nobody got the projects.';
  return failed ? `${head} ${failed} failed.` : head;
}

/** People whose call failed, so a retry sends only them. */
export function failedEmails(outcomes: readonly PersonOutcome[]): string[] {
  return outcomes.filter((o) => !o.ok).map((o) => o.email);
}
