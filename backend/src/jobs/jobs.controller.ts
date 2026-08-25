import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import {
  CreateJobDto,
  ImportJobsDto,
  MoveJobDto,
  ReorderJobDto,
  UpdateJobDto,
} from './jobs.dto';
import { JobsService } from './jobs.service';
import { JOB_PHASES, Job } from './jobs.types';

@Controller('api/jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly authService: AuthService,
  ) {}

  private extractToken(req?: any, authHeader?: string): string | undefined {
    if (req?.cookies?.['careeratlas_session'])
      return req.cookies['careeratlas_session'];
    if (req?.headers?.cookie) {
      const match = req.headers.cookie.match(/careeratlas_session=([^;]+)/);
      if (match) return match[1];
    }
    if (authHeader && authHeader.startsWith('Bearer '))
      return authHeader.substring(7);
    return undefined;
  }

  private async resolveUser(
    req?: any,
    authHeader?: string,
  ): Promise<{ id: number; email: string } | null> {
    const token = this.extractToken(req, authHeader);
    if (token) {
      try {
        const session = await this.authService.validateSession(token);
        if (session.valid && session.user) return session.user;
      } catch {}
    }
    return null;
  }

  @Get()
  async list(
    @Query() query: any,
    @Query('phase') phase?: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<Job[]> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user) return [];
    const normalizedPhase =
      phase && JOB_PHASES.includes(phase as any) ? phase : undefined;
    return this.jobsService.list(user.id, {
      phase: normalizedPhase,
      tag: query.tag,
      company: query.company,
      q: query.q,
      bookmarked: query.bookmarked === 'true' ? true : undefined,
      from: query.from,
      to: query.to,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  }

  @Post()
  async create(
    @Body() dto: CreateJobDto,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<Job> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    return this.jobsService.create(user.id, dto);
  }

  @Get('export')
  async export(
    @Query('format') format: string,
    @Res() res: Response,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<void> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    const result = await this.jobsService.exportJobs(
      user.id,
      format === 'csv' ? 'csv' : 'json',
    );
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="jobs.csv"');
      res.send(result);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="jobs.json"');
      res.send(JSON.stringify(result, null, 2));
    }
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<Job> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    return this.jobsService.get(user.id, parseInt(id, 10));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateJobDto,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<Job> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    return this.jobsService.update(user.id, parseInt(id, 10), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id') id: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    await this.jobsService.remove(user.id, parseInt(id, 10));
    return { success: true };
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  async move(
    @Param('id') id: string,
    @Body() dto: MoveJobDto,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<Job> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    return this.jobsService.move(
      user.id,
      parseInt(id, 10),
      dto.phase,
      dto.sortOrder,
    );
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(
    @Body() dto: ReorderJobDto,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    return this.jobsService.reorder(user.id, dto.items);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  async importJobs(
    @Body('mapping') mappingRaw?: string,
    @UploadedFile() file?: { buffer: Buffer },
    @Body() jsonBody?: ImportJobsDto,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user)
      throw new HttpException('User not found.', HttpStatus.UNAUTHORIZED);
    if (file && mappingRaw) {
      const mapping = JSON.parse(mappingRaw);
      return this.jobsService.importCsv(
        user.id,
        file.buffer.toString('utf8'),
        mapping,
      );
    }
    if (jsonBody && Array.isArray(jsonBody.jobs)) {
      return this.jobsService.importJobs(user.id, jsonBody.jobs);
    }
    throw new HttpException(
      'Provide a JSON body with a "jobs" array, or a CSV file plus a "mapping" field.',
      HttpStatus.BAD_REQUEST,
    );
  }
}
