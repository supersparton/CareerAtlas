import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { CompanyWatcherService } from './company-watcher.service';

@Controller('api/company-watcher')
export class CompanyWatcherController {
  private readonly defaultUserId = 1; // Default user ID for single-user environment

  constructor(private readonly watcherService: CompanyWatcherService) {}

  @Post('watch')
  async addWatch(
    @Body('companyName') companyName: string,
    @Body('role') role: string,
    @Body('location') location: string,
  ) {
    return await this.watcherService.addWatch(this.defaultUserId, companyName, role, location);
  }

  @Get('watches')
  async getWatches() {
    return await this.watcherService.getWatches(this.defaultUserId);
  }

  @Delete('watch/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeWatch(@Param('id', ParseIntPipe) id: number) {
    await this.watcherService.removeWatch(this.defaultUserId, id);
  }

  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerScrape() {
    // Fire and forget or execute asynchronously
    this.watcherService.triggerCronJob().catch((err) => {
      console.error('[CONTROLLER] Async cron trigger failed:', err);
    });
    return { message: 'Scraping cron run triggered successfully.' };
  }
}
