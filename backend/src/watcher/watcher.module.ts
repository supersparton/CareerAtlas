import { Module } from '@nestjs/common';
import { WatcherController } from './watcher.controller';
import { WatcherService } from './watcher.service';
import { WatcherAnalysisService } from './watcher-analysis.service';
import { WatcherSchedulerService } from './watcher-scheduler.service';
import { TelegramNotificationProvider } from './notifications/telegram.provider';
import { EmailNotificationProvider } from './notifications/email.provider';
import { DiscordNotificationProvider } from './notifications/discord.provider';
import { NotificationDispatcher } from './notifications/notification.dispatcher';

@Module({
  controllers: [WatcherController],
  providers: [
    WatcherService,
    WatcherAnalysisService,
    WatcherSchedulerService,
    TelegramNotificationProvider,
    EmailNotificationProvider,
    DiscordNotificationProvider,
    NotificationDispatcher,
  ],
  exports: [
    WatcherService,
    WatcherAnalysisService,
    WatcherSchedulerService,
  ],
})
export class WatcherModule {}
