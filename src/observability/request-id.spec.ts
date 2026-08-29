import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { currentRequestId } from './request-context';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './request-id.middleware';

/**
 * Driven over real HTTP rather than by calling the middleware with fabricated
 * arguments: the properties here are about headers and about the id surviving
 * an async boundary, and neither exists when a function is called directly.
 */
function appUnderTest() {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/echo', (_req, res) => {
    res.json({ seenInsideHandler: currentRequestId() });
  });
  app.get('/after-await', async (_req, res) => {
    // The boundary a real handler crosses on its way to the database or a
    // provider. A module-level variable would start attributing one request's
    // lines to another exactly here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.json({ seenAfterAwait: currentRequestId() });
  });
  return app;
}

describe('request id', () => {
  it('assigns one and returns it, so a caller has something to quote', async () => {
    const res = await request(appUnderTest()).get('/echo').expect(200);

    const header = res.headers[REQUEST_ID_HEADER];
    expect(header).toBeTruthy();
    // Two different ids would be worse than none, because each looks authoritative.
    expect(res.body.seenInsideHandler).toBe(header);
  });

  it("keeps the caller's own id, so their logs and ours join up", async () => {
    const supplied = `client-${randomUUID()}`;

    const res = await request(appUnderTest())
      .get('/echo')
      .set(REQUEST_ID_HEADER, supplied)
      .expect(200);

    expect(res.headers[REQUEST_ID_HEADER]).toBe(supplied);
    expect(res.body.seenInsideHandler).toBe(supplied);
  });

  // The header is attacker-controlled and lands in log lines, so an overlong
  // value would flood them. Substituting keeps the request working, where a 400
  // would turn a cosmetic problem into an outage.
  it.each([
    ['an overlong value', 'x'.repeat(500)],
    ['an empty value', ''],
  ])('refuses %s and substitutes its own', async (_label, hostile) => {
    const res = await request(appUnderTest())
      .get('/echo')
      .set(REQUEST_ID_HEADER, hostile)
      .expect(200);

    const header = res.headers[REQUEST_ID_HEADER];
    expect(header).not.toBe(hostile);
    expect(header.length).toBeLessThanOrEqual(128);
    expect(res.body.seenInsideHandler).toBe(header);
  });

  // Driven directly, deliberately: Node's own parser rejects a header carrying
  // CR or LF before any of this code runs, so the attempt cannot be expressed as
  // a request at all — the first version of this test failed for that reason,
  // which is how the limit was found. The check stays as a second layer, because
  // "the transport refuses it today" is a property of the transport rather than
  // of this middleware, and a line break reaching a log line would let a caller
  // forge entries in it.
  it.each([
    ['a newline', 'abc\ninjected-log-line'],
    ['a carriage return', 'abc\r\nINFO fake'],
  ])('does not adopt %s even when handed one directly', (_label, hostile) => {
    let assigned: string | undefined;
    const req = { header: () => hostile } as unknown as Parameters<typeof requestIdMiddleware>[0];
    const res = {
      setHeader: (_name: string, value: string) => {
        assigned = value;
      },
    } as unknown as Parameters<typeof requestIdMiddleware>[1];

    requestIdMiddleware(req, res, () => {});

    expect(assigned).toBeDefined();
    expect(assigned).not.toBe(hostile);
    expect(assigned).not.toContain('\n');
    expect(assigned).not.toContain('\r');
  });

  it('survives an await, and two concurrent requests do not share an id', async () => {
    const app = appUnderTest();

    const [a, b] = await Promise.all([
      request(app).get('/after-await').expect(200),
      request(app).get('/after-await').expect(200),
    ]);

    expect(a.body.seenAfterAwait).toBe(a.headers[REQUEST_ID_HEADER]);
    expect(b.body.seenAfterAwait).toBe(b.headers[REQUEST_ID_HEADER]);
    expect(a.body.seenAfterAwait).not.toBe(b.body.seenAfterAwait);
  });
});
