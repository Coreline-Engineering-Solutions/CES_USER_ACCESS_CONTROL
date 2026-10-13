import { describe, expect, it } from 'vitest';

import { bulkSummary, failedEmails, personFailureReason, runBulkProjectAssign } from './bulk-project-assign';

const httpError = (status: number, detail?: string) => ({ response: { status, data: { detail } } });

describe('runBulkProjectAssign', () => {
  it('gives every person the same projects, one call each', async () => {
    const calls: Array<[string, string[]]> = [];
    const out = await runBulkProjectAssign(['a@x.com', 'b@x.com', 'c@x.com'], ['Delft', 'PM Test'], async (e, names) => {
      calls.push([e, names]);
      return { assigned: names, missing: [] };
    });
    expect(calls.map((c) => c[0]).sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(calls.every((c) => c[1].join() === 'Delft,PM Test')).toBe(true);
    expect(out.map((o) => [o.email, o.ok])).toEqual([['a@x.com', true], ['b@x.com', true], ['c@x.com', true]]);
  });

  it('keeps going when one person fails, and says who and why', async () => {
    const out = await runBulkProjectAssign(['a@x.com', 'b@x.com', 'c@x.com'], ['Delft'], async (e) => {
      if (e === 'b@x.com') throw httpError(404);
      return { assigned: ['Delft'], missing: [] };
    });
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(out[1].status).toBe(404);
    expect(personFailureReason(out[1])).toMatch(/isn't registered/);
    expect(failedEmails(out)).toEqual(['b@x.com']);
  });

  it('reports project names the server did not recognise', async () => {
    const out = await runBulkProjectAssign(['a@x.com'], ['Delft', 'Nope'], async () => ({ assigned: ['Delft'], missing: ['Nope'] }));
    expect(out[0]).toMatchObject({ ok: true, assigned: ['Delft'], missing: ['Nope'] });
  });

  it('treats everything not called missing as given when the server does not echo what it assigned', async () => {
    const out = await runBulkProjectAssign(['a@x.com'], ['Delft', 'Nope'], async () => ({ missing: ['Nope'] }));
    expect(out[0].assigned).toEqual(['Delft']);
    const none = await runBulkProjectAssign(['a@x.com'], ['Delft'], async () => undefined);
    expect(none[0]).toMatchObject({ ok: true, assigned: ['Delft'], missing: [] });
  });

  it('never runs more than the allowed number at once', async () => {
    let live = 0;
    let peak = 0;
    await runBulkProjectAssign(['1', '2', '3', '4', '5', '6', '7', '8'], ['Delft'], async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return {};
    });
    expect(peak).toBe(4);
  });

  it('reports progress as people finish', async () => {
    const seen: Array<[number, number]> = [];
    await runBulkProjectAssign(['a', 'b', 'c'], ['Delft'], async () => ({}), 1, (d, t) => seen.push([d, t]));
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('handles an empty list without calling anything', async () => {
    let called = false;
    const out = await runBulkProjectAssign([], ['Delft'], async () => { called = true; return {}; });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('bulkSummary', () => {
  const ok = (email: string) => ({ email, ok: true, assigned: [], missing: [] });
  const bad = (email: string) => ({ email, ok: false, assigned: [], missing: [] });

  it('says what was given', () => {
    expect(bulkSummary([ok('a'), ok('b')], 3)).toBe('Gave 3 projects to 2 people.');
    expect(bulkSummary([ok('a')], 1)).toBe('Gave 1 project to 1 person.');
  });

  it('adds how many failed, or says nobody got it', () => {
    expect(bulkSummary([ok('a'), bad('b')], 2)).toBe('Gave 2 projects to 1 person. 1 failed.');
    expect(bulkSummary([bad('a'), bad('b')], 2)).toBe('Nobody got the projects. 2 failed.');
  });
});

describe('personFailureReason', () => {
  it('explains the common failures', () => {
    expect(personFailureReason({ email: 'a@x.com', ok: false, assigned: [], missing: [], status: 403 })).toMatch(/permission/);
    expect(personFailureReason({ email: 'a@x.com', ok: false, assigned: [], missing: [], detail: 'boom' })).toBe('boom');
    expect(personFailureReason({ email: 'a@x.com', ok: false, assigned: [], missing: [] })).toMatch(/did not accept/);
  });
});
