import { BadRequestException } from '@nestjs/common';
import * as schema from '../db/schema';

export type ApplicationStatus = (typeof schema.applicationStatusEnum.enumValues)[number];

export const APPLICATION_STATUSES = schema.applicationStatusEnum.enumValues;

/**
 * The application's state machine (T21). `offer`/`rejected`/`withdrawn` are
 * terminal — no outbound row — and `interview_completed →
 * interview_scheduled` is a deliberate loop for multi-round interviews, not
 * an oversight.
 */
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  sourced: ['applied', 'rejected', 'withdrawn'],
  applied: ['interview_scheduled', 'rejected', 'withdrawn'],
  interview_scheduled: ['interview_completed', 'rejected', 'withdrawn'],
  interview_completed: ['interview_scheduled', 'offer', 'rejected', 'withdrawn'],
  offer: [],
  rejected: [],
  withdrawn: [],
};

/** Throws before any write — an invalid move is a 400, never a silent no-op. */
export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new BadRequestException(`Cannot move an application from "${from}" to "${to}".`);
  }
}
