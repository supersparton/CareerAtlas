import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../discovery/discovery.service';

@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly chatId = process.env.TELEGRAM_CHAT_ID;

  async sendJobAlert(
    job: Job,
    finalScore: number,
    subScores: { skills: number; experience: number; location: number },
    reasoning: string
  ) {
    if (!this.botToken || !this.chatId) {
      this.logger.warn('[NOTIFIER] Telegram credentials not found in .env. Skipping alert.');
      return;
    }

    const message = `🚨 *New High-Match Job Found!* 🚨\n\n` +
      `💼 *Role:* ${job.title}\n` +
      `🏢 *Company:* ${job.company}\n` +
      `📍 *Location:* ${job.location}\n` +
      `🎯 *Match Score:* *${finalScore}/100*\n` +
      `  • _Skills:_ ${subScores.skills}/100\n` +
      `  • _Experience:_ ${subScores.experience}/100\n` +
      `  • _Location:_ ${subScores.location}/100\n\n` +
      `🧠 *AI Reasoning:* ${reasoning}\n\n` +
      `🔗 [Apply Here](${job.applyUrl})`;

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

      this.logger.log(`[NOTIFIER] Telegram alert sent successfully for ${job.company}!`);
    } catch (e) {
      this.logger.error(`[NOTIFIER] Failed to send Telegram alert: ${e.message}`);
    }
  }
}
