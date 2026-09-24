import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchDto {
  @ApiProperty({ description: 'Natural-language search text.' })
  query!: string;

  @ApiPropertyOptional({ description: 'Max results to return. Default 10, capped at 50.' })
  limit?: number;
}
