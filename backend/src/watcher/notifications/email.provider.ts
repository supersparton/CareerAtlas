import { Injectable, Logger } from '@nestjs/common';
import { NotificationPayload, NotificationProvider } from './notification.interface';

@Injectable()
export class EmailNotificationProvider implements NotificationProvider {
  name = 'email';
  private readonly logger = new Logger(EmailNotificationProvider.name);

  async sendAlert(userId: number, userEmail: string, payload: NotificationPayload): Promise<void> {
    this.logger.log(
      `[EMAIL] Sending email alert to ${userEmail} (User ${userId}):\n` +
      `Subject: New posting at ${payload.companyName}!\n` +
      `Body: Hi there, a new role matching your preferences was found:\n` +
      `- Title: ${payload.jobTitle}\n` +
      `- Location: ${payload.location}\n` +
      `- URL: ${payload.url}\n` +
      `- Match info: Roles(${payload.matchedRole || 'none'}), Location(${payload.matchedLocation || 'none'}), Keywords(${payload.matchedKeywords?.join(', ') || 'none'})`
    );
  }
}
