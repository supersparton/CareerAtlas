import { Controller, Post, Get, Delete, Body, Param, Query, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { WatcherService, WatchlistPreferences } from './watcher.service';
import { WatcherSchedulerService } from './watcher-scheduler.service';
import { DiscoveryMetadataInput } from './watcher-analysis.service';

export class WatchlistDto {
  userEmail: string;
  companyIdentifier: string;
  companyName: string;
  careersUrl: string;
  desiredRoles: string[];
  preferredLocations: string[];
  keywords: string[];
  notificationFrequency: string;
}

@Controller('api/watcher')
export class WatcherController {
  private readonly logger = new Logger(WatcherController.name);

  constructor(
    private readonly watcherService: WatcherService,
    private readonly schedulerService: WatcherSchedulerService
  ) {}

  @Post('discover')
  @HttpCode(HttpStatus.OK)
  async discoverEndpoint(@Body() body: DiscoveryMetadataInput) {
    this.logger.log(`[API] Discovery payload received for company: ${body.companyName} (${body.companyIdentifier})`);
    return this.watcherService.processDiscoveryMetadata(body);
  }

  @Post('discover-real')
  @HttpCode(HttpStatus.OK)
  async discoverRealEndpoint(
    @Body('companyId') companyId: number,
    @Body('companyIdentifier') companyIdentifier: string,
    @Body('companyName') companyName: string,
    @Body('careersUrl') careersUrl: string
  ) {
    this.logger.log(`[API] Real-time Discovery triggered for company: ${companyName}`);
    return this.watcherService.discoverRealEndpoint(companyId, companyIdentifier, companyName, careersUrl);
  }

  @Post('register-company')
  @HttpCode(HttpStatus.CREATED)
  async registerCompany(
    @Body('companyIdentifier') companyIdentifier: string,
    @Body('companyName') companyName: string,
    @Body('careersUrl') careersUrl: string
  ) {
    return this.watcherService.getOrCreateCompany(companyIdentifier, companyName, careersUrl);
  }

  @Post('watchlist')
  @HttpCode(HttpStatus.OK)
  async addToWatchlist(@Body() body: WatchlistDto) {
    const { userEmail, companyIdentifier, companyName, careersUrl, desiredRoles, preferredLocations, keywords, notificationFrequency } = body;
    return this.watcherService.addToWatchlist(userEmail, companyIdentifier, companyName, careersUrl, {
      desiredRoles,
      preferredLocations,
      keywords,
      notificationFrequency
    });
  }

  @Get('watchlist')
  async getWatchlist(@Query('email') email: string) {
    if (!email) {
      throw new Error('Email query parameter is required');
    }
    return this.watcherService.getUserWatchlist(email);
  }

  @Delete('watchlist/:companyId')
  async removeFromWatchlist(@Param('companyId') companyId: string, @Query('email') email: string) {
    if (!email) {
      throw new Error('Email query parameter is required');
    }
    return this.watcherService.removeFromWatchlist(email, parseInt(companyId, 10));
  }

  @Post('check-now')
  @HttpCode(HttpStatus.OK)
  async checkNow() {
    this.logger.log('[API] Manual watcher check-now triggered.');
    // Run in background and return success
    this.schedulerService.runAllChecks().catch(err => {
      this.logger.error(`Manual run failed: ${err.message}`);
    });
    return { message: 'Monitoring scan initiated in background.' };
  }

  @Get('companies')
  async getCompanies() {
    return this.watcherService.getAllCompanies();
  }

  // Returns all real network captures from the discovery_metadata table
  // The Chrome extension POSTs to /discover when it intercepts a network call;
  // the frontend polls this endpoint to show the live feed.
  @Get('discovered')
  async getDiscoveredEndpoints(@Query('companyIdentifier') companyIdentifier?: string) {
    return this.watcherService.getDiscoveredEndpoints(companyIdentifier);
  }
}
