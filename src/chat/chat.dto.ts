import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiPropertyOptional({
    description:
      'Continue an existing conversation. Omit to start a new one — the response carries its id.',
  })
  conversationId?: string;

  @ApiProperty({ description: 'The message to send.' })
  message!: string;
}
