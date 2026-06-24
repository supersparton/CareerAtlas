import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExecutionLogger } from './logger/execution-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new ExecutionLogger());
  app.enableCors({
    origin: true, // allow all origins including chrome-extension://
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();

