import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExecutionLogger } from './logger/execution-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new ExecutionLogger());
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();

