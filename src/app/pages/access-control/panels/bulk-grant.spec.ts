import { describe, expect, it } from 'vitest';

import { bulkFailureReason, runBulkGrant } from './bulk-grant';

const httpError = (status: number, detail?: string) => ({ response: { status, data: { detail } } });

describe('runBulkGrant', () => {
  it('grants every module and reports each one', async () => {
    const seen: string[] = [];
    const out = await runBulkGrant(['a', 'b', 'c'], async (g) => { seen.push(g); });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(out.map((o) => [o.module_gid, o.ok])).toEqual([['a', true], ['b', true], ['c', true]]);
  });

  it('keeps going when one module fails, and says which and why', async () => {
    const out = await runBulkGrant(['a', 'b', 'c'], async (g) => {
      if (g === 'b') throw httpError(403);
    });
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(out[1].status).toBe(403);
  });

  it('never runs more than the allowed number at once', async () => {
    let live = 0;
    let peak = 0;
    await runBulkGrant(['1', '2', '3', '4', '5', '6', '7', '8'], async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    }, 3);
    expect(peak).toBe(3);
  });

  it('reports progress as modules finish', async () => {
    const ticks: number[] = [];
    await runBulkGrant(['a', 'b', 'c'], async () => undefined, 1, (done, total) => {
      expect(total).toBe(3);
      ticks.push(done);
    });
    expect(ticks).toEqual([1, 2, 3]);
  });

  it('does nothing for an empty list', async () => {
    expect(await runBulkGrant([], async () => { throw new Error('should not run'); })).toEqual([]);
  });

  it('returns outcomes in the order the modules were given', async () => {
    const out = await runBulkGrant(['slow', 'fast'], (g) => new Promise((r) => setTimeout(r, g === 'slow' ? 20 : 1)), 2);
    expect(out.map((o) => o.module_gid)).toEqual(['slow', 'fast']);
  });
});

describe('bulkFailureReason', () => {
  it('explains a missing user, a module not managed, and anything else', () => {
    expect(bulkFailureReason({ module_gid: 'a', ok: false, status: 404 }, 'x@y.z')).toContain('x@y.z');
    expect(bulkFailureReason({ module_gid: 'a', ok: false, status: 403 }, 'x@y.z')).toContain("don't manage");
    expect(bulkFailureReason({ module_gid: 'a', ok: false, status: 500, detail: 'boom' }, 'x@y.z')).toBe('boom');
    expect(bulkFailureReason({ module_gid: 'a', ok: false }, 'x@y.z')).toBe('The server did not accept it.');
  });
});
