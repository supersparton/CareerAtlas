import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { CareerPagesAgent } from './career-pages.agent';
import { YcGreenhouseAgent } from './yc-greenhouse.agent';
import { WellfoundGlassdoorAgent } from './wellfound-glassdoor.agent';
import { LinkedInAgent } from './linkedin.agent';

@Module({
  providers: [
    DiscoveryService,
    CareerPagesAgent,
    YcGreenhouseAgent,
    WellfoundGlassdoorAgent,
    LinkedInAgent,
  ],
  exports: [
    DiscoveryService,
    CareerPagesAgent,
    YcGreenhouseAgent,
    WellfoundGlassdoorAgent,
    LinkedInAgent,
  ],
})
export class DiscoveryModule {}


