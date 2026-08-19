import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { startTelemetry } from './observability/telemetry';

async function bootstrap() {
  // Before the app is created: instrumentation has to be in place before the
  // libraries it patches start being used.
  await startTelemetry();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(cookieParser());

  // Trust exactly one proxy hop, so the client IP comes from X-Forwarded-For
  // rather than being the ingress every time. Without this, rate limiting
  // behind Container Apps ingress would put the entire internet in one bucket —
  // the limit would be shared, so one caller could exhaust it for everyone, and
  // the counter would say nothing about who was responsible.
  //
  // One hop, not `true`: trusting the whole chain would let a caller prepend a
  // forged X-Forwarded-For and choose its own bucket. The app is only reachable
  // through the ingress, so exactly one hop is the truth here.
  app.set('trust proxy', 1);

  // There is no UI in the MVP (SPEC §8) — Swagger is the interface the system is
  // actually driven from. But it is unauthenticated by nature: it hands anyone
  // who reaches it the full API surface. So it is opt-in per environment rather
  // than always on, and defaults to off, since the environment that would
  // forget to think about this is the deployed one.
  if (process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('career-consulting-ai')
      .setDescription('Sign in at /auth/google in a browser, then use the session cookie.')
      .setVersion('0.1')
      .build();
    SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
