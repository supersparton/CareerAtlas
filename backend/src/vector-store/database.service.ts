import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  async onModuleInit() {
    this.logger.log('[DATABASE] Connecting to PostgreSQL database...');
    
    // Connect using DATABASE_URL or individual variables
    const connectionString = process.env.DATABASE_URL;
    
    // Automatically apply SSL options if Supabase is detected or requested
    const isSupabase = 
      (connectionString && (connectionString.includes('supabase') || connectionString.includes('sslmode=require'))) ||
      (process.env.DB_HOST && process.env.DB_HOST.includes('supabase')) ||
      process.env.DB_SSL === 'true';

    this.pool = new Pool({
      connectionString,
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'careeratlas',
      max: 13,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3500,
      ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
    });

    try {
      // Test connection
      await this.pool.query('SELECT NOW()');
      this.logger.log('[DATABASE] Successfully connected to PostgreSQL.');
      
      // Initialize schema
      await this.initializeSchema();
    } catch (err) {
      this.logger.error(`[DATABASE] Failed to connect to PostgreSQL: ${err.message}`);
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
          full_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          phone VARCHAR(50),
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
        ALTER TABLE user_preferences ALTER COLUMN experience_years TYPE NUMERIC(3,1);
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS education TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS projects TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS achievements TEXT[] DEFAULT '{}';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS latest_run_id VARCHAR(255);
      `);

      // 3. Create user skills table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skills (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          skill VARCHAR(100) NOT NULL,
          PRIMARY KEY (user_id, skill)
        );
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

      // 5. Create sequence for run IDs
      await client.query(`
        CREATE SEQUENCE IF NOT EXISTS workflow_run_id_seq START WITH 1;
      `);

      await client.query('COMMIT');
      this.logger.log('[DATABASE] Database schema initialized successfully.');
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[DATABASE] Failed to initialize database schema: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  async getNextExecutionId(): Promise<string> {
    try {
      const res = await this.query("SELECT nextval('workflow_run_id_seq') as val");
      const num = res.rows[0].val;
      return `run_${String(num).padStart(4, '0')}`;
    } catch (err) {
      this.logger.error(`[DATABASE] Failed to get next run sequence: ${err.message}`);
      return `run_${Date.now()}`;
    }
  }
}
