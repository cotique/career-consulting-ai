import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';

/**
 * Rate limiting is applied by a global guard, so the interesting questions are
 * about its edges rather than its middle: does it actually refuse, and does it
 * leave alone the endpoints that must never be refused.
 *
 * Driven through the real HTTP stack — a guard that works in isolation and is
 * not wired into the app is exactly the failure this catches.
 */
let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('rate limiting', () => {
  // The probes are hit continuously by the platform. If a limit applied to
  // them, a healthy deployment would start reporting itself unhealthy — the one
  // place where a rate limit breaks the system instead of protecting it.
  it('never throttles the health probes, however often they are called', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
    }
  });

  // Unauthenticated requests still cost work to reject, so the limit has to
  // apply before authentication rather than after it.
  it('throttles a flood of unauthenticated requests with 429', async () => {
    let sawTooMany = false;
    let sawUnauthorized = false;

    for (let i = 0; i < 200; i++) {
      const res = await request(app.getHttpServer()).get('/me');
      if (res.status === 401) sawUnauthorized = true;
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
    }

    expect(sawUnauthorized).toBe(true); // the guard rejected before the limit kicked in
    expect(sawTooMany).toBe(true); // and the limit did kick in
  });
});
