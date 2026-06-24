import { Injectable, Logger } from '@nestjs/common';
import { NotificationPayload, NotificationProvider } from './notification.interface';

@Injectable()
export class DiscordNotificationProvider implements NotificationProvider {
  name = 'discord';
  private readonly logger = new Logger(DiscordNotificationProvider.name);

  async sendAlert(userId: number, userEmail: string, payload: NotificationPayload): Promise<void> {
    this.logger.log(
      `[DISCORD] Dispatching webhook alert to Discord channel for user ${userEmail}:\n` +
      `**New job at ${payload.companyName}**:\n` +
      `**Title**: ${payload.jobTitle}\n` +
      `**Location**: ${payload.location}\n` +
      `**Link**: <${payload.url}>\n` +
      `**Matched on**: ${payload.matchedRole || payload.matchedLocation || payload.matchedKeywords?.join(', ') || 'N/A'}`
    );
  }
}
