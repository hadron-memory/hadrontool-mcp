/**
 * Pure-logic guards around the MCP-speaking layer: pagination draining must
 * never loop forever on a hostile upstream, and every tool result must be
 * bounded before it reaches a run hop's context — for ALL content, not just
 * text blocks.
 */
import { describe, expect, it } from 'vitest';
import { boundContent, drainPages } from './upstream.js';
import { UpstreamProtocolError } from './errors.js';

describe('drainPages — pagination is bounded', () => {
  it('accumulates across pages and stops when the cursor runs out', async () => {
    const pages = [
      { items: ['a', 'b'], nextCursor: 'c1' },
      { items: ['c'], nextCursor: 'c2' },
      { items: ['d'], nextCursor: undefined },
    ];
    let i = 0;
    const items = await drainPages(async () => pages[i++], { maxItems: 1000, maxPages: 50 });
    expect(items).toEqual(['a', 'b', 'c', 'd']);
    expect(i).toBe(3);
  });

  it('fails typed when the upstream repeats a cursor forever', async () => {
    // The classic hang: empty page, same cursor, indefinitely.
    await expect(
      drainPages(async () => ({ items: [] as string[], nextCursor: 'stuck' }), { maxItems: 1000, maxPages: 50 }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  it('stops at the page cap when every page is empty with a fresh cursor', async () => {
    let calls = 0;
    const items = await drainPages(
      async () => {
        calls += 1;
        return { items: [] as string[], nextCursor: `cursor-${calls}` };
      },
      { maxItems: 1000, maxPages: 5 },
    );
    expect(items).toEqual([]);
    expect(calls).toBe(5); // capped, did not run away
  });

  it('stops once the item cap is reached', async () => {
    let calls = 0;
    const items = await drainPages(
      async () => {
        calls += 1;
        return { items: [calls], nextCursor: `c-${calls}` };
      },
      { maxItems: 3, maxPages: 50 },
    );
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });
});

describe('boundContent — responses are bounded (all content, not just text)', () => {
  it('truncates an oversized text block with a marker', () => {
    const big = 'x'.repeat(300_000);
    const [block] = boundContent([{ type: 'text', text: big }]);
    expect((block.text as string).length).toBeLessThan(big.length);
    expect(block.text).toContain('[truncated by hadrontool-mcp]');
  });

  it('truncates non-text payloads too (image base64, nested resource, _meta)', () => {
    const big = 'A'.repeat(300_000);
    const [image, resource] = boundContent([
      { type: 'image', data: big, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'x://y', blob: big }, _meta: { note: big } },
    ]);
    expect((image.data as string)).toContain('[truncated by hadrontool-mcp]');
    const res = resource.resource as Record<string, unknown>;
    expect(res.blob as string).toContain('[truncated by hadrontool-mcp]');
    const meta = resource._meta as Record<string, unknown>;
    expect(meta.note as string).toContain('[truncated by hadrontool-mcp]');
  });

  it('caps the block count', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ type: 'text', text: `b${i}` }));
    expect(boundContent(many)).toHaveLength(100);
  });

  it('enforces the total cap even on the first block (no bypass)', () => {
    // A single hostile block whose many 200k-capped fields aggregate past 5 MB.
    const fields: Record<string, unknown> = { type: 'resource' };
    for (let i = 0; i < 40; i++) fields[`f${i}`] = 'z'.repeat(200_000);
    const bounded = boundContent([fields]);
    expect(bounded).toHaveLength(1);
    expect(bounded[0].text).toContain('hadrontool-mcp dropped 1 content block');
  });

  it('caps the total serialized size and appends a drop marker', () => {
    // 40 blocks × ~200k each ≈ 8MB > 5MB cap → trailing blocks dropped.
    const blocks = Array.from({ length: 40 }, () => ({ type: 'text', text: 'y'.repeat(200_000) }));
    const bounded = boundContent(blocks);
    expect(bounded.length).toBeLessThan(40);
    const last = bounded[bounded.length - 1];
    expect(last.text).toContain('hadrontool-mcp dropped');
    expect(last.text).toContain('exceeded');
  });
});
