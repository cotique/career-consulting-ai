import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';

/**
 * API-layer rate limiting — deferred until "at the first
 * deploy". It is a separate control from the LLM budget caps: those bound
 * *spend*, this bounds *requests*, and a loop hammering a cheap endpoint costs
 * nothing in tokens while still being a problem.
 *
 * One global limit, deliberately generous: its job is to stop a runaway loop or
 * a crude script, not to police normal use. A single person driving the API
 * through Swagger will never approach it. Endpoints that need something
 * stricter *override* it per route with `@Throttle` — see the onboarding parse
 * preview, which spends tokens on every call.
 *
 * A second named throttler was the first attempt and was wrong: every
 * configured throttler applies to every route, so an "expensive" bucket meant
 * to be opt-in silently limited the health probes to ten calls an hour. Caught
 * by the test below, which is the reason it exists.
 *
 * `/health` and `/health/ready` are exempt (`@SkipThrottle` on the controller).
 * The platform probes them continuously, so throttling them would turn a
 * healthy deployment into a flapping one — the one place a rate limit would
 * break the system rather than protect it.
 *
 * Storage is in-process. With `min-replicas: 0, max-replicas: 1` that is the
 * whole picture; at more than one replica each replica would keep its own
 * counters and the effective limit would multiply by the replica count.
 * Deliberately not solved with a shared store: that is a dependency nobody
 * needs yet.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', limit: 120, ttl: seconds(60) }],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
