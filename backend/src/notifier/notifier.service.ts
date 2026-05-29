import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;

  async sendJobAlert(title: string, company: string, score: number, reasoning: string, link: string) {
    if (!this.botToken || !this.chatId) {
      this.logger.warn('Telegram credentials not found in .env. Skipping alert.');
      return;
    }

    const message = `🚨 *New High-Match Job!* 🚨\n\n` +
      `💼 *Role:* ${title}\n` +
      `🏢 *Company:* ${company}\n` +
      `🎯 *Match Score:* ${score}/100\n\n` +
      `🧠 *AI Reasoning:* ${reasoning}\n\n` +
      `🔗 [Apply Here](${link})`;

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
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API responded with status ${response.status}`);
      }

      this.logger.log(`Telegram alert sent successfully for ${company}!`);
    } catch (e) {
      this.logger.error(`Failed to send Telegram alert: ${e.message}`);
    }
  }
}
