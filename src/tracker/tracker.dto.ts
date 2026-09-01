import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateApplicationDto {
  @ApiProperty({
    description: 'The vacancy to start tracking. Must already exist for you.',
  })
  vacancyId!: string;
}

export class TransitionApplicationDto {
  @ApiProperty({
    description: 'The status to move the application to.',
    example: 'applied',
  })
  status!: string;

  @ApiPropertyOptional({
    description:
      'Free text attached to this transition, e.g. an interview note. Stored only in the event timeline, never on the application itself.',
  })
  note?: string;
}
