import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { ProfileService, UserProfile, ResumeWorkExperience, ResumeProject, ResumeEducation } from './profile.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { QdrantService } from '../vector-store/qdrant.service';

@Injectable()
export class ResumesService {
  private readonly logger = new Logger(ResumesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly profileService: ProfileService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly qdrantService: QdrantService,
  ) {}

  async listVersions(userId: number): Promise<any[]> {
    const res = await this.db.query(
      `SELECT id, name, is_default as "isDefault", notes, parent_version_id as "parentVersionId", 
              source_type as "sourceType", job_id as "jobId", version_number as "versionNumber", created_at as "createdAt"
       FROM resumes 
       WHERE user_id = $1 
       ORDER BY version_number DESC`,
      [userId]
    );
    return res.rows;
  }

  async getResumeDetails(resumeId: number): Promise<any> {
    const resumeRes = await this.db.query('SELECT * FROM resumes WHERE id = $1', [resumeId]);
    if (resumeRes.rows.length === 0) return null;
    const resume = resumeRes.rows[0];

    // Fetch user details for contact info
    const userRes = await this.db.query('SELECT full_name, email, phone FROM users WHERE id = $1', [resume.user_id]);
    const user = userRes.rows[0] || {};

    // Fetch skills
    const skillsRes = await this.db.query('SELECT skill FROM resume_skills WHERE resume_id = $1', [resumeId]);
    const skills = skillsRes.rows.map(r => r.skill);

    // Fetch experience
    const expRes = await this.db.query('SELECT company, role, duration, description FROM resume_experience WHERE resume_id = $1 ORDER BY display_order ASC', [resumeId]);
    const experience = expRes.rows;

    // Fetch projects
    const projRes = await this.db.query('SELECT title, tech_stack as "techStack", description FROM resume_projects WHERE resume_id = $1 ORDER BY display_order ASC', [resumeId]);
    const projects = projRes.rows;

    // Fetch education
    const eduRes = await this.db.query('SELECT institution, degree, duration FROM resume_education WHERE resume_id = $1 ORDER BY display_order ASC', [resumeId]);
    const education = eduRes.rows;

    // Fetch section order
    const orderRes = await this.db.query('SELECT section_name FROM resume_section_order WHERE resume_id = $1 ORDER BY display_order ASC', [resumeId]);
    const sectionOrder = orderRes.rows.map(r => r.section_name);

    return {
      id: resume.id,
      userId: resume.user_id,
      fullName: user.full_name || '',
      email: user.email || '',
      phone: user.phone || '',
      name: resume.name,
      isDefault: resume.is_default,
      notes: resume.notes,
      summary: resume.summary,
      sourceType: resume.source_type,
      jobId: resume.job_id,
      versionNumber: resume.version_number,
      createdAt: resume.created_at,
      skills,
      experience,
      projects,
      education,
      sectionOrder
    };
  }

  async saveVersion(
    userId: number,
    name: string,
    resumeData: any,
    sourceType: string,
    jobId?: string,
    notes?: string
  ): Promise<any> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      // 1. Get next version number
      const verRes = await client.query('SELECT COALESCE(MAX(version_number), 0) as max FROM resumes WHERE user_id = $1', [userId]);
      const nextVersion = verRes.rows[0].max + 1;

      // 2. Insert into resumes table
      const resumeRes = await client.query(
        `INSERT INTO resumes (user_id, name, is_default, notes, source_type, job_id, version_number, summary)
         VALUES ($1, $2, FALSE, $3, $4, $5, $6, $7)
         RETURNING id;`,
        [userId, name, notes || '', sourceType, jobId || null, nextVersion, resumeData.summary || null]
      );
      const resumeId = resumeRes.rows[0].id;

      // 3. Save skills
      const skills = resumeData.skills || [];
      for (const skill of skills) {
        await client.query(
          `INSERT INTO resume_skills (resume_id, skill) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [resumeId, skill]
        );
      }

      // 4. Save experience
      const experiences = resumeData.experience || [];
      for (let i = 0; i < experiences.length; i++) {
        const exp = experiences[i];
        await client.query(
          `INSERT INTO resume_experience (resume_id, company, role, duration, description, display_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [resumeId, exp.company, exp.role, exp.duration, exp.description, i]
        );
      }

      // 5. Save projects
      const projects = resumeData.projects || [];
      for (let i = 0; i < projects.length; i++) {
        const proj = projects[i];
        await client.query(
          `INSERT INTO resume_projects (resume_id, title, tech_stack, description, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [resumeId, proj.title, proj.techStack || [], proj.description, i]
        );
      }

      // 6. Save education
      const education = resumeData.education || [];
      for (let i = 0; i < education.length; i++) {
        const edu = education[i];
        await client.query(
          `INSERT INTO resume_education (resume_id, institution, degree, duration, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [resumeId, edu.institution || edu.university || 'Education', edu.degree, edu.duration || '', i]
        );
      }

      // 7. Save section order
      const sections = resumeData.sectionOrder || ['skills', 'experience', 'projects', 'education'];
      for (let i = 0; i < sections.length; i++) {
        await client.query(
          `INSERT INTO resume_section_order (resume_id, section_name, display_order) VALUES ($1, $2, $3)`,
          [resumeId, sections[i], i + 1]
        );
      }

      await client.query('COMMIT');
      return this.getResumeDetails(resumeId);
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[RESUMES] Failed to save resume version: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  async promoteToDefault(userId: number, resumeId: number): Promise<boolean> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      // Verify resume belongs to user
      const checkRes = await client.query('SELECT id, user_id FROM resumes WHERE id = $1 AND user_id = $2', [resumeId, userId]);
      if (checkRes.rows.length === 0) {
        throw new Error('Resume version not found or unauthorized.');
      }

      // 1. Set all user's resumes to FALSE
      await client.query('UPDATE resumes SET is_default = FALSE WHERE user_id = $1', [userId]);

      // 2. Set chosen resume to TRUE
      await client.query('UPDATE resumes SET is_default = TRUE WHERE id = $1', [resumeId]);

      // 3. Load details of this resume
      const details = await this.getResumeDetails(resumeId);

      // 4. Sync profile metadata back to user_preferences and user_skills
      await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);
      for (const skill of details.skills) {
        await client.query(
          `INSERT INTO user_skills (user_id, skill) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, skill]
        );
      }

      // Sync user_preferences arrays
      const flatEdu = details.education.map((e: any) => `${e.degree} at ${e.institution}`);
      const flatProj = details.projects.map((p: any) => `${p.title}: ${p.description}`);

      await client.query(
        `UPDATE user_preferences 
         SET education = $1, projects = $2 
         WHERE user_id = $3`,
        [flatEdu, flatProj, userId]
      );

      // 5. Regenerate User Embedding and sync to Qdrant
      const userRes = await client.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
      const user = userRes.rows[0];

      const expText = details.experience.map((e: any) => `${e.role} at ${e.company} (${e.duration}): ${e.description}`).join('\n');
      const projText = details.projects.map((p: any) => `${p.title} (${(p.techStack || []).join(', ')}): ${p.description}`).join('\n');
      
      const textToEmbed = [
        `Target Roles: ${details.preferredRoles?.join(', ') || ''}`,
        `Core Skills & Keywords: ${details.skills.join(', ')}`,
        `Education: ${flatEdu.join('. ')}`,
        `Projects: ${projText || flatProj.join('. ')}`,
        `Work Experience:\n${expText}`,
        `Experience Years: ${details.experienceYears || 0}`
      ].join('\n');

      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);

      await this.qdrantService.getClient().upsert('user_embeddings', {
        wait: true,
        points: [
          {
            id: QdrantService.stringToUuid(userId.toString()),
            vector: embedding,
            payload: {
              fullName: user.full_name,
              email: user.email,
              experienceYears: details.experienceYears || 0,
              skills: details.skills,
              preferredRoles: details.preferredRoles || [],
            }
          }
        ]
      });

      await client.query('COMMIT');
      this.logger.log(`[RESUMES] Resume version ${resumeId} promoted to default and Qdrant embeddings updated.`);
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[RESUMES] Promote to default failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteVersion(userId: number, resumeId: number): Promise<boolean> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      const res = await client.query('SELECT is_default FROM resumes WHERE id = $1 AND user_id = $2', [resumeId, userId]);
      if (res.rows.length === 0) {
        throw new Error('Resume version not found.');
      }
      if (res.rows[0].is_default) {
        throw new Error('Cannot delete the default active resume version.');
      }

      await client.query('DELETE FROM resumes WHERE id = $1', [resumeId]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
