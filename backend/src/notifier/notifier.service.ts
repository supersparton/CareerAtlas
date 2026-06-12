import { Injectable, Logger } from '@nestjs/common';
import { Job } from '../discovery/discovery.service';

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

    const message = `🚨 <b>New High-Match Job Found!</b> 🚨\n\n` +
      `💼 <b>Role:</b> ${escapeHtml(job.title)}\n` +
      `🏢 <b>Company:</b> ${escapeHtml(job.company)}\n` +
      `📍 <b>Location:</b> ${escapeHtml(job.location)}\n` +
      `🎯 <b>Match Score:</b> <b>${finalScore}/100</b>\n` +
      `  • <i>Skills:</i> ${subScores.skills}/100\n` +
      `  • <i>Experience:</i> ${subScores.experience}/100\n` +
      `  • <i>Location:</i> ${subScores.location}/100\n\n` +
      `🧠 <b>AI Reasoning:</b> ${escapeHtml(reasoning)}\n\n` +
      `🔗 <a href="${job.applyUrl}">Apply Here</a>`;

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

      this.logger.log(`[NOTIFIER] Telegram alert sent successfully for ${job.company}!`);
    } catch (e) {
      this.logger.error(`[NOTIFIER] Failed to send Telegram alert: ${e.message}`);
    }
  }
}
