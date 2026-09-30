import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SendMessageDto } from './chat.dto';
import { ChatService } from './chat.service';

@ApiTags('chat')
@Controller('me/chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  @ApiOperation({
    summary: 'Send a message, grounded in your own resumes and saved vacancies',
    description:
      'Costs an embedding call and a model call. Omit conversationId to start a new conversation.',
  })
  async send(@CurrentUser() userId: string, @Body() body: SendMessageDto) {
    return this.chat.send(userId, body);
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'One conversation, oldest message first' })
  async get(@CurrentUser() userId: string, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.chat.getConversation(userId, conversationId);
  }
}
