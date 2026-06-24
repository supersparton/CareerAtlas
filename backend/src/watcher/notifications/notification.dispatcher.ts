import { Injectable, Logger } from '@nestjs/common';
import { TelegramNotificationProvider } from './telegram.provider';
import { EmailNotificationProvider } from './email.provider';
import { DiscordNotificationProvider } from './discord.provider';
import { NotificationPayload, NotificationProvider } from './notification.interface';

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly providers: NotificationProvider[];

  constructor(
    private readonly telegram: TelegramNotificationProvider,
    private readonly email: EmailNotificationProvider,
    private readonly discord: DiscordNotificationProvider,
  ) {
    this.providers = [telegram, email, discord];
  }

  async dispatch(userId: number, userEmail: string, payload: NotificationPayload): Promise<void> {
    this.logger.log(`[DISPATCHER] Dispatching alert for user ${userEmail} regarding job at ${payload.companyName}`);
    for (const provider of this.providers) {
      try {
        await provider.sendAlert(userId, userEmail, payload);
      } catch (err) {
        this.logger.error(`[DISPATCHER] Error dispatching via ${provider.name}: ${err.message}`);
      }
    }
  }
}
