import { Module, Global } from '@nestjs/common';
import { LlmGatewayService } from './llm-gateway.service';

@Global()
@Module({
  providers: [LlmGatewayService],
  exports: [LlmGatewayService],
})
export class LlmGatewayModule {}
