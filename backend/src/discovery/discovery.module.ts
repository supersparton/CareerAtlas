import { Module } from '@nestjs/common';
import { AtsPortalsAgent } from './ats-portals.agent';
import { StartupBoardsAgent } from './startup-boards.agent';
import { IndiaFocusedAgent } from './india-focused.agent';
import { LinkedInAgent } from './linkedin.agent';

@Module({
  providers: [
    AtsPortalsAgent,
    StartupBoardsAgent,
    IndiaFocusedAgent,
    LinkedInAgent,
  ],
  exports: [
    AtsPortalsAgent,
    StartupBoardsAgent,
    IndiaFocusedAgent,
    LinkedInAgent,
  ],
})
export class DiscoveryModule {}
