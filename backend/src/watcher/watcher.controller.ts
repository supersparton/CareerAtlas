import { Controller, Post, Get, Body, Query, BadRequestException } from '@nestjs/common';
import { WatcherService } from './watcher.service';

@Controller('api/watcher')
export class WatcherController {
  constructor(private readonly watcherService: WatcherService) {}

  /**
   * Watch a company career portal
   * POST /watcher/watch
   */
  @Post('watch')
  async watchCompany(
    @Body('companyName') companyName: string,
    @Body('url') url: string,
    @Body('email') email?: string,
    @Body('locationFilter') locationFilter?: string,
    @Body('roleFilter') roleFilter?: string
  ) {
    if (!companyName || !url) {
      throw new BadRequestException('companyName and url are required fields');
    }

    return this.watcherService.watchCompany(email, companyName, url, locationFilter, roleFilter);
  }

  /**
   * List watched companies for a user
   * GET /watcher/watchers
   */
  @Get('watchers')
  async getWatchers(@Query('email') email?: string) {
    return this.watcherService.getWatchersForUser(email);
  }

  /**
   * List all discovery queue jobs (admin)
   * GET /watcher/discoveries
   */
  @Get('discoveries')
  async getDiscoveries() {
    return this.watcherService.getDiscoveryQueue();
  }

  /**
   * Approve a discovered company endpoint (admin)
   * POST /watcher/admin/approve
   */
  @Post('admin/approve')
  async approveDiscovery(
    @Body('discoveryId') discoveryId: number,
    @Body('customConfig') customConfig: any
  ) {
    if (!discoveryId || !customConfig) {
      throw new BadRequestException('discoveryId and customConfig are required');
    }

    const success = await this.watcherService.approveDiscovery(discoveryId, customConfig);
    if (!success) {
      throw new BadRequestException('Discovery job not found or failed to approve');
    }

    return { success: true, message: 'Discovery approved. Company promoted to custom provider.' };
  }

  /**
   * Manually trigger job synchronization for all watched companies (cron trigger fallback)
   * POST /watcher/sync
   */
  @Post('sync')
  async triggerSync() {
    this.watcherService.syncAllActiveCompanies().catch((err) => {
      // Async background logging
    });
    return { success: true, message: 'Bulk watch synchronization triggered in background.' };
  }
}
