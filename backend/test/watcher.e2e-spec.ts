import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('WatcherController (e2e)', () => {
  let app: INestApplication<App>;
  const testEmail = 'e2e-test-user@careeratlas.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/watcher/register-company (POST)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/watcher/register-company')
      .send({
        companyIdentifier: 'google',
        companyName: 'Google',
        careersUrl: 'https://careers.google.com',
      })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.company_identifier).toBe('google');
    expect(response.body.company_name).toBe('Google');
  });

  it('/api/watcher/discover (POST)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/watcher/discover')
      .send({
        companyIdentifier: 'google',
        companyName: 'Google',
        careersUrl: 'https://careers.google.com',
        requestUrl: 'https://careers.google.com/api/v1/jobs',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        payload: '',
        responseBody: JSON.stringify([
          { id: 'job_123', title: 'Senior TypeScript Engineer', location: 'Remote', url: '/job/123' },
        ]),
        contentType: 'application/json',
      })
      .expect(200);

    expect(response.body).toHaveProperty('success');
    expect(response.body.success).toBe(true);
    expect(response.body.analysis.classification).toBe('Public API');
    expect(response.body.analysis.isMonitoredServerSide).toBe(true);
  });

  it('/api/watcher/watchlist (POST and GET)', async () => {
    // 1. Add to watchlist
    await request(app.getHttpServer())
      .post('/api/watcher/watchlist')
      .send({
        userEmail: testEmail,
        companyIdentifier: 'google',
        companyName: 'Google',
        careersUrl: 'https://careers.google.com',
        desiredRoles: ['TypeScript', 'Fullstack'],
        preferredLocations: ['Remote', 'Ahmedabad'],
        keywords: ['Node.js'],
        notificationFrequency: 'realtime',
      })
      .expect(200);

    // 2. Fetch watchlist
    const getResponse = await request(app.getHttpServer())
      .get(`/api/watcher/watchlist?email=${encodeURIComponent(testEmail)}`)
      .expect(200);

    expect(getResponse.body).toBeInstanceOf(Array);
    expect(getResponse.body.length).toBeGreaterThan(0);
    expect(getResponse.body[0].company_identifier).toBe('google');
    expect(getResponse.body[0].desired_roles).toContain('TypeScript');
  });

  it('/api/watcher/check-now (POST)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/watcher/check-now')
      .expect(200);

    expect(response.body.message).toContain('scan initiated');
  });

  it('/api/watcher/watchlist/:companyId (DELETE)', async () => {
    // 1. Get current watchlist items to retrieve company ID
    const getResponse = await request(app.getHttpServer())
      .get(`/api/watcher/watchlist?email=${encodeURIComponent(testEmail)}`)
      .expect(200);

    const companyId = getResponse.body[0].company_id;

    // 2. Delete item
    await request(app.getHttpServer())
      .delete(`/api/watcher/watchlist/${companyId}?email=${encodeURIComponent(testEmail)}`)
      .expect(200);

    // 3. Confirm deletion
    const finalResponse = await request(app.getHttpServer())
      .get(`/api/watcher/watchlist?email=${encodeURIComponent(testEmail)}`)
      .expect(200);

    expect(finalResponse.body.length).toBe(0);
  });
});
