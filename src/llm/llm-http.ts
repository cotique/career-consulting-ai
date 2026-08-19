import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { LlmError } from './errors';

/**
 * Turns a failure from the LLM layer into the HTTP answer it deserves.
 *
 * One place rather than a `catch` per caller, and keyed on the error's `kind`
 * rather than its class: the taxonomy in `errors.ts` exists precisely so that
 * whoever must act on a failure can do so without knowing which subclass it is,
 * and a new subclass then arrives already mapped. Before this, every caller
 * handled `LlmSchemaError` alone, so a truncated response — the case the layer
 * goes to some trouble to identify — reached the client as a bare 500 that told
 * them nothing, and a tripped spend guard did the same.
 *
 * `permanentMessage` is what the user reads when the request itself cannot
 * succeed. The internal message is not reused: it describes schema issues and
 * token bounds, which are our problem and not theirs.
 */
export function httpErrorFor(err: unknown, permanentMessage: string): unknown {
  if (!(err instanceof LlmError)) return err;

  switch (err.kind) {
    case 'permanent':
      return new BadRequestException(permanentMessage);
    case 'budget':
      // Not a bad request and not our outage: the work was refused on purpose
      // and may succeed later. The message is the guard's own, because "you
      // have reached your monthly limit" is exactly what the user needs to know.
      return new HttpException(err.message, HttpStatus.TOO_MANY_REQUESTS);
    case 'retryable':
      return new ServiceUnavailableException(
        'The language model is temporarily unavailable. Try again shortly.',
      );
  }
}
