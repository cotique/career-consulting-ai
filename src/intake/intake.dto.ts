import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PasteVacancyDto {
  @ApiProperty({
    description:
      'The job posting as text, pasted from wherever it was published. Stored verbatim; nothing is fetched or followed.',
    example: 'Senior Product Manager\nAcme sp. z o.o., Warsaw (hybrid)\n\nWhat you will do...',
  })
  rawText!: string;

  @ApiPropertyOptional({
    description:
      'Where it was published, if you want it recorded. Kept as a note only — the system never opens it.',
    example: 'https://example.com/jobs/123',
  })
  sourceUrl?: string;
}
