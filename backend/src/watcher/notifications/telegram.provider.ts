import { Injectable, Logger } from '@nestjs/common';
import { NotificationPayload, NotificationProvider } from './notification.interface';

@Injectable()
export class TelegramNotificationProvider implements NotificationProvider {
  name = 'telegram';
  private readonly logger = new Logger(TelegramNotificationProvider.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;

  async sendAlert(userId: number, userEmail: string, payload: NotificationPayload): Promise<void> {
    if (!this.botToken || !this.chatId) {
      this.logger.warn(`[TELEGRAM] Credentials not configured in .env. Skipping alert for User ${userId} (${userEmail})`);
      return;
    }

    const rolesMatched = payload.matchedRole ? `• <b>Role Matched:</b> ${payload.matchedRole}\n` : '';
    const locationsMatched = payload.matchedLocation ? `• <b>Location Matched:</b> ${payload.matchedLocation}\n` : '';
    const keywordsMatched = payload.matchedKeywords && payload.matchedKeywords.length > 0 
      ? `• <b>Keywords Matched:</b> ${payload.matchedKeywords.join(', ')}\n` 
      : '';

    const message = `🔔 <b>Dream Company Watcher Alert!</b> 🔔\n\n` +
      `🏢 <b>Company:</b> ${payload.companyName}\n` +
      `💼 <b>Role:</b> ${payload.jobTitle}\n` +
      `📍 <b>Location:</b> ${payload.location}\n\n` +
      `🎯 <b>Matching Preferences:</b>\n` +
      rolesMatched +
      locationsMatched +
      keywordsMatched +
      `\n🔗 <a href="${payload.url}">View Posting</a>`;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API responded with status ${response.status}`);
      }

      this.logger.log(`[TELEGRAM] Alert sent successfully to user ${userId} (${userEmail}) for ${payload.companyName}!`);
    } catch (e) {
      this.logger.error(`[TELEGRAM] Failed to send alert to user ${userId}: ${e.message}`);
    }
  }
}
