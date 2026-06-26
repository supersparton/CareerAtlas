import { Injectable, Logger } from '@nestjs/common';
import { RawJob } from './provider.interface';

@Injectable()
export class CustomConfigProvider {
  private readonly logger = new Logger(CustomConfigProvider.name);

  async fetchJobsWithConfig(companyName: string, config: any): Promise<RawJob[]> {
    const { url, method, headers, payload, mapping } = config;

    this.logger.log(`Fetching custom config jobs for ${companyName} at: ${url}`);

    try {
      const options: RequestInit = {
        method: method || 'GET',
        headers: headers || { 'Content-Type': 'application/json' },
      };

      if (payload && (method === 'POST' || method === 'PUT')) {
        options.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`Custom HTTP call responded with status ${response.status}`);
      }

      const text = await response.text();
      let cleanedText = text.trim();

      // Strip security prefix like )]}'
      if (cleanedText.startsWith(")]}'")) {
        cleanedText = cleanedText.substring(4).trim();
      }

      // Strip leading response size numbers (like in Google batchexecute responses)
      cleanedText = cleanedText.replace(/^\d+\s*/, '').trim();

      let data: any;
      try {
        data = JSON.parse(cleanedText);
      } catch (jsonErr) {
        this.logger.error(`Failed to parse custom config response as JSON: ${jsonErr.message}. Raw prefix: ${cleanedText.substring(0, 100)}`);
        throw jsonErr;
      }
      
      // Resolve path to the job list array
      const rawJobs = this.resolvePath(data, mapping.jobListPath);
      if (!Array.isArray(rawJobs)) {
        this.logger.warn(`Resolved job list path "${mapping.jobListPath}" is not an array for ${companyName}`);
        return [];
      }

      return rawJobs.map((rawJob: any) => {
        const externalId = String(this.resolvePath(rawJob, mapping.externalId) || Math.random().toString());
        const title = String(this.resolvePath(rawJob, mapping.title) || '');
        const location = String(this.resolvePath(rawJob, mapping.location) || 'Remote');
        const description = String(this.resolvePath(rawJob, mapping.description) || '');
        const applyUrl = String(this.resolvePath(rawJob, mapping.applyUrl) || url);

        return {
          externalId,
          title,
          company: companyName,
          location,
          description,
          applyUrl,
        };
      });
    } catch (err) {
      this.logger.error(`Failed to fetch custom config jobs for ${companyName}: ${err.message}`);
      return [];
    }
  }

  /**
   * Helper to resolve dot-notation paths in a JSON object or array (e.g. "location.name" or "0.2")
   * If a resolved value is a double-serialized JSON string (common in Google RPC), it parses it automatically.
   */
  private resolvePath(obj: any, path: string): any {
    if (!path || obj === undefined || obj === null) return obj;
    
    const parts = path.split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      
      // Try to parse if current is a string representing a serialized JSON
      if (typeof current === 'string') {
        const trimmed = current.trim();
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
          try {
            current = JSON.parse(trimmed);
          } catch {}
        }
      }
      
      // Look up property or array index
      current = current[part];
    }
    
    // Final check to see if result is a serialized JSON string
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          return JSON.parse(trimmed);
        } catch {}
      }
    }
    
    return current;
  }
}
