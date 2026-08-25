import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  async onModuleInit() {
    this.logger.log('[DATABASE] Connecting to PostgreSQL database...');

    // Connect using DATABASE_URL or individual variables
    const connectionString = process.env.DATABASE_URL;

    // Automatically apply SSL options for Supabase / Cloud PostgreSQL
    const isSupabase =
      (connectionString &&
        (connectionString.includes('supabase') ||
          connectionString.includes('pooler') ||
          connectionString.includes('sslmode=require'))) ||
      (process.env.DB_HOST &&
        (process.env.DB_HOST.includes('supabase') ||
          process.env.DB_HOST.includes('pooler'))) ||
      process.env.DB_SSL === 'true';

    this.pool = new Pool({
      connectionString,
      // When connectionString is set, pg ignores host/port/user/password/database fields
      // Defaults are only used for local development without DATABASE_URL
      host: process.env.DB_HOST || (connectionString ? undefined : 'localhost'),
      port: connectionString ? undefined : parseInt(process.env.DB_PORT || '5432', 10),
      user: connectionString ? undefined : (process.env.DB_USER || 'postgres'),
      password: connectionString ? undefined : (process.env.DB_PASSWORD || 'postgres'),
      database: connectionString ? undefined : (process.env.DB_NAME || 'careeratlas'),
      max: 13,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
    });

    try {
      // Test connection
      await this.pool.query('SELECT NOW()');
      this.logger.log('[DATABASE] Successfully connected to PostgreSQL.');

      // Initialize schema
      await this.initializeSchema();
    } catch (err) {
      this.logger.error(
        `[DATABASE] Failed to connect to PostgreSQL: ${err.message}`,
      );
    }
  }

  async onModuleDestroy() {
    this.logger.log('[DATABASE] Closing database pool connection...');
    await this.pool.end();
  }

  getPool(): Pool {
    return this.pool;
  }

  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  private async initializeSchema() {
    this.logger.log('[DATABASE] Initializing database schema...');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Create users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          full_name TEXT NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          phone TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Create user preferences table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          preferred_roles TEXT[] NOT NULL,
          locations TEXT[] NOT NULL,
          remote BOOLEAN NOT NULL,
          employment_types TEXT[] NOT NULL,
          experience_years NUMERIC(3,1) NOT NULL,
          education TEXT[] DEFAULT '{}',
          projects TEXT[] DEFAULT '{}',
          achievements TEXT[] DEFAULT '{}'
        );
      `);

      // Ensure new columns and types exist for existing tables
      await client.query(`
        ALTER TABLE users ALTER COLUMN full_name TYPE TEXT;
        ALTER TABLE users ALTER COLUMN phone TYPE TEXT;
        ALTER TABLE user_preferences ALTER COLUMN experience_years TYPE NUMERIC(3,1);
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS salary_expectation INTEGER;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS education TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS projects TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS achievements TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS latest_run_id VARCHAR(255);
        ALTER TABLE user_skills ALTER COLUMN skill TYPE VARCHAR(255);
      `);

      // 3. Create user skills table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skills (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          skill VARCHAR(255) NOT NULL,
          PRIMARY KEY (user_id, skill)
        );
      `);

      // 3b. Create sessions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          session_token VARCHAR(255) UNIQUE NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
      `);

      // 4. Create results table for user-specific recommendations
      await client.query(`
        CREATE TABLE IF NOT EXISTS results (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_id VARCHAR(255) NOT NULL,
          company VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL,
          location VARCHAR(255) NOT NULL,
          source VARCHAR(100) NOT NULL,
          url TEXT,
          score INTEGER NOT NULL,
          reasoning TEXT,
          status VARCHAR(50) DEFAULT 'matched',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          confidence_score INTEGER,
          confidence_factors JSONB,
          UNIQUE (user_id, job_id)
        );
      `);

      // Ensure url column exists in case table was created previously without it
      await client.query(`
        ALTER TABLE results ADD COLUMN IF NOT EXISTS url TEXT;
      `);

      // Ensure run_id column exists
      await client.query(`
        ALTER TABLE results ADD COLUMN IF NOT EXISTS run_id VARCHAR(255);
      `);

      // Ensure confidence_score and confidence_factors columns exist
      await client.query(`
        ALTER TABLE results ADD COLUMN IF NOT EXISTS confidence_score INTEGER;
      `);
      await client.query(`
        ALTER TABLE results ADD COLUMN IF NOT EXISTS confidence_factors JSONB;
      `);

      // 5. Create sequence for run IDs
      await client.query(`
        CREATE SEQUENCE IF NOT EXISTS workflow_run_id_seq START WITH 1;
      `);

      // 6. Create indexes for fast retrieval
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_results_user_run ON results(user_id, run_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
      `);

      // 7. Create resume versions table for multi-version management
      await client.query(`
        CREATE TABLE IF NOT EXISTS resume_versions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          version_name VARCHAR(255) NOT NULL,
          is_active BOOLEAN DEFAULT false,
          raw_text TEXT,
          parsed_data JSONB NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_user_version_name UNIQUE (user_id, version_name)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_resume_versions_user ON resume_versions(user_id);
      `);

      // 8. Create agent search sessions table for persistent search history
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_search_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          version_id INTEGER REFERENCES resume_versions(id) ON DELETE CASCADE,
          search_title VARCHAR(255) NOT NULL,
          location_pref VARCHAR(255) NOT NULL,
          job_count INTEGER DEFAULT 0,
          run_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_search_sessions_user ON agent_search_sessions(user_id, version_id);
      `);

      // 9. Create job tracker tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(255) NOT NULL,
          company VARCHAR(255) NOT NULL,
          location VARCHAR(255),
          salary_min INTEGER,
          salary_max INTEGER,
          url TEXT,
          notes TEXT,
          tags TEXT[] DEFAULT '{}',
          phase VARCHAR(20) NOT NULL DEFAULT 'bookmarked',
          sort_order INTEGER NOT NULL DEFAULT 0,
          bookmarked BOOLEAN NOT NULL DEFAULT false,
          source VARCHAR(50) DEFAULT 'manual',
          company_logo_url TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          last_moved_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_user_phase ON jobs(user_id, phase, sort_order);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_company ON jobs(user_id, company);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_tags ON jobs(user_id, tags);
        CREATE TABLE IF NOT EXISTS job_phase_changes (
          id SERIAL PRIMARY KEY,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL,
          from_phase VARCHAR(20),
          to_phase VARCHAR(20) NOT NULL,
          changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_job_phase_changes_job ON job_phase_changes(job_id);
      `);

      await client.query('COMMIT');
      this.logger.log(
        '[DATABASE] Database schema and indexes initialized successfully.',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(
        `[DATABASE] Failed to initialize database schema: ${err.message}`,
        err.stack,
      );
      throw err;
    } finally {
      client.release();
    }
  }

  async getNextExecutionId(): Promise<string> {
    try {
      const res = await this.query(
        "SELECT nextval('workflow_run_id_seq') as val",
      );
      const num = res.rows[0].val;
      return `run_${String(num).padStart(4, '0')}`;
    } catch (err) {
      this.logger.error(
        `[DATABASE] Failed to get next run sequence: ${err.message}`,
      );
      return `run_${Date.now()}`;
    }
  }
}
