import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TargetMarketDto {
  @ApiProperty({ example: 'PL', description: 'ISO 3166-1 alpha-2. Europe only at launch.' })
  countryCode!: string;

  @ApiPropertyOptional({ example: 'Warsaw' })
  city?: string;

  @ApiPropertyOptional({ example: true, description: 'Open to remote roles in this market.' })
  remote?: boolean;
}

/**
 * Every field is optional: onboarding is step-addressable, so a client can
 * submit one step at a time (and a later positioning step — FR21 — can be
 * added without restructuring the payload or the endpoint).
 */
export class OnboardingDto {
  @ApiPropertyOptional({ example: 'Alex' })
  name?: string;

  @ApiPropertyOptional({ type: [String], example: ['Product Manager', 'Business Analyst'] })
  targetRoles?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Warsaw', 'Remote (EU)'] })
  locations?: string[];

  @ApiPropertyOptional({
    example: 'en',
    description: 'BCP 47. Language of the conversation and UI — NOT of generated documents.',
  })
  uiLanguage?: string;

  @ApiPropertyOptional({ type: [TargetMarketDto] })
  targetMarkets?: TargetMarketDto[];

  @ApiPropertyOptional({
    example: 'Europe/Warsaw',
    description: 'IANA timezone. A browser can auto-detect this; the API takes it explicitly.',
  })
  timezone?: string;

  @ApiPropertyOptional({ example: '09:00', description: '24-hour HH:MM in the timezone above.' })
  preferredNotificationTime?: string;

  @ApiPropertyOptional({
    description:
      'Free-text answer to "what are you looking for and what matters". Parse it first with /onboarding/parse-preview, then submit the confirmed result as `preferences`.',
  })
  freeText?: string;

  @ApiPropertyOptional({
    description: 'Structured preferences the user has reviewed and confirmed.',
  })
  preferences?: Record<string, unknown>;
}

export class ParsePreviewDto {
  @ApiProperty({ example: 'Looking for remote PM roles in fintech, no early-stage startups.' })
  freeText!: string;
}
