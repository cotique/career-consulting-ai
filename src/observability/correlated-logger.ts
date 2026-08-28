import { ConsoleLogger } from '@nestjs/common';
import { currentRequestId } from './request-context';

type LogArgs = [message: unknown, ...rest: unknown[]];

/**
 * Puts the request id on every log line written while handling a request.
 *
 * Without it the logs reach Azure Monitor but cannot be narrowed to a single
 * request, which is the difference between having logs and being able to use
 * them while something is on fire.
 *
 * Azure Monitor keeps its own `operation_Id` for the same purpose when
 * telemetry is running. This id is deliberately separate: it exists locally
 * too, where telemetry is off, and it is the one handed back to the caller, so
 * it is the one a person can quote. The two are joinable because this id is in
 * the message text.
 *
 * The public methods are overridden rather than the protected formatter: the
 * formatter is a Nest internal whose signature is free to change, and a logger
 * that breaks on a patch upgrade takes the diagnostics with it.
 */
export class CorrelatedLogger extends ConsoleLogger {
  private tag(message: unknown): unknown {
    const id = currentRequestId();
    return id === undefined ? message : `[${id}] ${String(message)}`;
  }

  log(...args: LogArgs): void {
    super.log(this.tag(args[0]), ...(args.slice(1) as never[]));
  }

  error(...args: LogArgs): void {
    super.error(this.tag(args[0]), ...(args.slice(1) as never[]));
  }

  warn(...args: LogArgs): void {
    super.warn(this.tag(args[0]), ...(args.slice(1) as never[]));
  }

  debug(...args: LogArgs): void {
    super.debug(this.tag(args[0]), ...(args.slice(1) as never[]));
  }

  verbose(...args: LogArgs): void {
    super.verbose(this.tag(args[0]), ...(args.slice(1) as never[]));
  }
}
