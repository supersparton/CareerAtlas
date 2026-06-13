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

      // Enable pgvector extension
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      
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
          salary_expectation INTEGER,
          experience_years INTEGER NOT NULL
        );
      `);

      // 3. Create user skills table
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skills (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          skill VARCHAR(100) NOT NULL,
          PRIMARY KEY (user_id, skill)
        );
      `);

      // 4. Create user embeddings table (384 dimensions for bge-small)
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_embeddings (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          embedding vector(384) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 5. Create jobs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id VARCHAR(50) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          company VARCHAR(255) NOT NULL,
          url TEXT NOT NULL,
          description TEXT NOT NULL,
          location VARCHAR(255) NOT NULL,
          posting_date TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 6. Create job requirements table
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_requirements (
          job_id VARCHAR(50) PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
          required_skills TEXT[] NOT NULL,
          preferred_skills TEXT[] NOT NULL,
          experience_required INTEGER NOT NULL,
          education_requirements TEXT[] NOT NULL,
          employment_type VARCHAR(100) NOT NULL,
          remote_allowed BOOLEAN NOT NULL,
          actual_location VARCHAR(255) NOT NULL
        );
      `);

      // 7. Create job embeddings table (384 dimensions for bge-small)
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_embeddings (
          job_id VARCHAR(50) PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
          embedding vector(384) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 8. Create HNSW indexes for cosine distance search speedup
      await client.query(`
        CREATE INDEX IF NOT EXISTS job_embeddings_vector_idx 
        ON job_embeddings USING hnsw (embedding vector_cosine_ops);
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
}
