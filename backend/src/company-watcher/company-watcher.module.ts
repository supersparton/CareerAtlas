import { Module } from '@nestjs/common';
import { CompanyWatcherService } from './company-watcher.service';
import { CompanyWatcherController } from './company-watcher.controller';
import { CompanyWatcherEventsListener } from './company-watcher.events.listener';
import { NotifierModule } from '../notifier/notifier.module';

@Module({
  imports: [
    NotifierModule,
  ],
  controllers: [
    CompanyWatcherController,
  ],
  providers: [
    CompanyWatcherService,
    CompanyWatcherEventsListener,
  ],
  exports: [
    CompanyWatcherService,
  ],
})
export class CompanyWatcherModule {}
