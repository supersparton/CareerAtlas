import { Injectable, Logger } from '@nestjs/common';
import { RawJob } from './provider.interface';

@Injectable()
export class CustomConfigProvider {
  private readonly logger = new Logger(CustomConfigProvider.name);

  async fetchJobsWithConfig(companyName: string, config: any): Promise<RawJob[]> {
    const url = config.url || config.endpointUrl;
    const { method, headers, payload, mapping } = config;

    this.logger.log(`Fetching custom config jobs for ${companyName} at: ${url}`);

    try {
      const options: RequestInit = {
        method: method || 'GET',
        headers: headers || { 'Content-Type': 'application/json' },
      };

      if (payload && (method === 'POST' || method === 'PUT')) {
        const headersObj = (options.headers || {}) as Record<string, string>;
        const isFormUrlEncoded = Object.keys(headersObj).some(
          (key) => key.toLowerCase() === 'content-type' && String(headersObj[key]).toLowerCase().includes('application/x-www-form-urlencoded')
        );

        if (isFormUrlEncoded && typeof payload === 'object') {
          const params = new URLSearchParams();
          for (const key of Object.keys(payload)) {
            params.append(key, typeof payload[key] === 'object' ? JSON.stringify(payload[key]) : String(payload[key]));
          }
          options.body = params.toString();
        } else {
          options.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        }
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`Custom HTTP call responded with status ${response.status}`);
      }

      const text = await response.text();
      let data: any;

      const contentType = response.headers.get('content-type') || '';
      const isHtml = contentType.includes('text/html') || text.trim().startsWith('<');

      if (isHtml) {
        this.logger.log(`Response is HTML for ${companyName}. Attempting to extract embedded state JSON...`);
        data = this.extractJsonFromHtml(text);
        if (!data) {
          this.logger.error(`Could not extract embedded JSON state from HTML for ${companyName}`);
          throw new Error('Could not extract embedded JSON state from HTML');
        }
      } else {
        const jsonText = this.extractFirstJsonArray(text);
        if (!jsonText) {
          this.logger.error(`Could not find outer JSON array in response for ${companyName}`);
          throw new Error('Could not find outer JSON array in response');
        }

        try {
          data = JSON.parse(jsonText);
        } catch (jsonErr) {
          this.logger.error(`Failed to parse custom config response as JSON: ${jsonErr.message}. Raw prefix: ${jsonText.substring(0, 100)}`);
          throw jsonErr;
        }
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
   * Helper to extract the first complete JSON array ([[...]...]]) from response stream.
   * Useful for size-prefixed, multi-chunk HTTP response bodies like Google batchexecute.
   */
  private extractFirstJsonArray(text: string): string | null {
    const startIdx = text.indexOf('[[');
    if (startIdx === -1) {
      const singleStart = text.indexOf('[');
      if (singleStart === -1) return null;
      
      let bracketCount = 0;
      for (let i = singleStart; i < text.length; i++) {
        if (text[i] === '[') bracketCount++;
        else if (text[i] === ']') {
          bracketCount--;
          if (bracketCount === 0) return text.substring(singleStart, i + 1);
        }
      }
      return null;
    }
    
    let bracketCount = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '[') {
        bracketCount++;
      } else if (text[i] === ']') {
        bracketCount--;
        if (bracketCount === 0) {
          return text.substring(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * Helper to resolve dot-notation paths in a JSON object or array (e.g. "location.name" or "0.2")
   * If a resolved value is a double-serialized JSON string (common in Google RPC), it parses it automatically.
   */
  private resolvePath(obj: any, path: string): any {
    if (!path || obj === undefined || obj === null) return obj;
    
    // Normalize path by replacing brackets like [1] or ["key"] with dot notation
    const normalizedPath = String(path)
      .replace(/\["([^"]+)"\]/g, '.$1')
      .replace(/\['([^']+)'\]/g, '.$1')
      .replace(/\[(\d+)\]/g, '.$1')
      .replace(/^\./, '');

    const parts = normalizedPath.split('.');
    let current = obj;

    // Skip leading 'body' or 'data' if the root object is an array or does not contain it
    if (parts.length > 0 && (parts[0] === 'body' || parts[0] === 'data')) {
      if (current && typeof current === 'object' && !(parts[0] in current)) {
        parts.shift();
      }
    }
    
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

  /**
   * Helper to search for and parse JSON/JS-state blocks embedded inside HTML documents.
   */
  private extractJsonFromHtml(html: string): any {
    // 1. Try to find a serialized script assignment like "phApp.ddo =", "window.__PRELOADED_STATE__ =", etc.
    const stateVarRegex = /(?:var|window|phApp|state|ddo)\s*[\w\.]+\s*=\s*(\{[\s\S]+?)(?:;|\n|<\/script>)/gi;
    let match;
    while ((match = stateVarRegex.exec(html)) !== null) {
      const matchStr = match[1].trim();
      let braceCount = 0;
      let jsonStr = '';
      for (let i = 0; i < matchStr.length; i++) {
        if (matchStr[i] === '{') braceCount++;
        else if (matchStr[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonStr = matchStr.substring(0, i + 1);
            break;
          }
        }
      }

      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed) return parsed;
        } catch {}
      }
    }

    // 2. Try to find <script type="application/ld+json">
    const ldRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    while ((match = ldRegex.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed) return parsed;
      } catch {}
    }

    return null;
  }
}
