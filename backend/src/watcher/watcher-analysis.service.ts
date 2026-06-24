import { Injectable, Logger } from '@nestjs/common';

export class DiscoveryMetadataInput {
  companyIdentifier: string;
  companyName: string;
  careersUrl: string;
  requestUrl: string;
  method: string;
  headers: Record<string, string>;
  payload?: string;
  responseBody?: string;
  contentType?: string;
}

export interface AnalysisResult {
  isJobPostingEndpoint: boolean;
  classification: 'Public API' | 'GraphQL Endpoint' | 'Static HTML Page' | 'Session Dependent Endpoint' | 'Signature Based Endpoint' | 'Unsupported';
  confidenceScore: number; // 0 to 100
  isMonitoredServerSide: boolean;
}

@Injectable()
export class WatcherAnalysisService {
  private readonly logger = new Logger(WatcherAnalysisService.name);

  async analyzeRequest(input: DiscoveryMetadataInput): Promise<AnalysisResult> {
    const { requestUrl, method, headers, payload, responseBody, contentType } = input;
    
    let isJobPostingEndpoint = false;
    let classification: AnalysisResult['classification'] = 'Unsupported';
    let confidenceScore = 0;
    let isMonitoredServerSide = false;

    // Normalize inputs
    const urlLower = requestUrl.toLowerCase();
    const headersKeysLower = Object.keys(headers).map(k => k.toLowerCase());
    const isJson = contentType?.toLowerCase().includes('json') || urlLower.includes('.json') || (responseBody && responseBody.trim().startsWith('{')) || (responseBody && responseBody.trim().startsWith('['));
    const isHtml = contentType?.toLowerCase().includes('html') || (!contentType && (urlLower.endsWith('.html') || urlLower.endsWith('/')));

    // 1. Detect if request likely returns job postings
    // Check URL keywords
    const urlJobKeywords = ['job', 'career', 'posting', 'position', 'opening', 'requisition', 'vacancy', 'role', 'opportunity', 'graphql', 'query'];
    const urlMatches = urlJobKeywords.some(keyword => urlLower.includes(keyword));

    // Check payload and response body
    let responseBodyMatches = false;
    let containsJobFields = false;

    if (responseBody) {
      const responseBodyLower = responseBody.toLowerCase();
      // Look for job list indicator keys
      const bodyJobKeywords = ['"jobs"', '"postings"', '"roles"', '"careers"', '"openings"', '"requisitions"', '"vacancies"', '"items"', '"results"'];
      responseBodyMatches = bodyJobKeywords.some(keyword => responseBodyLower.includes(keyword));

      // Look for standard job fields
      const jobFields = ['title', 'location', 'department', 'reqid', 'requisition', 'applyurl', 'jobid', 'postingid', 'url'];
      let matchedFieldsCount = 0;
      jobFields.forEach(field => {
        if (responseBodyLower.includes(`"${field}"`)) {
          matchedFieldsCount++;
        }
      });
      if (matchedFieldsCount >= 2) {
        containsJobFields = true;
      }
    }

    if (urlMatches || responseBodyMatches || containsJobFields) {
      isJobPostingEndpoint = true;
    }

    // 2. Classify endpoint
    const hasAuthHeaders = headersKeysLower.some(k => 
      k.includes('authorization') || 
      k.includes('cookie') || 
      k.includes('xsrf') || 
      k.includes('csrf') || 
      k.includes('token') || 
      k.includes('x-api-key') ||
      k.includes('x-session')
    );

    const hasSignatureHeaders = headersKeysLower.some(k => 
      k.includes('signature') || 
      k.includes('x-sign') || 
      k.includes('sec-ch-ua') || 
      k.includes('cf-ray')
    );

    if (hasSignatureHeaders) {
      classification = 'Signature Based Endpoint';
      confidenceScore = 70;
    } else if (hasAuthHeaders && (urlLower.includes('session') || urlLower.includes('login') || urlLower.includes('private'))) {
      classification = 'Session Dependent Endpoint';
      confidenceScore = 80;
    } else if (method.toUpperCase() === 'POST' && (urlLower.includes('graphql') || payload?.includes('query') || payload?.includes('operationName'))) {
      classification = 'GraphQL Endpoint';
      confidenceScore = 95;
    } else if (isJson) {
      classification = 'Public API';
      confidenceScore = 90;
    } else if (isHtml) {
      classification = 'Static HTML Page';
      confidenceScore = 60;
    } else {
      classification = 'Unsupported';
      confidenceScore = 20;
    }

    // Adjust confidence score based on the evidence
    if (isJobPostingEndpoint) {
      confidenceScore = Math.min(confidenceScore + 10, 100);
    } else {
      confidenceScore = Math.max(confidenceScore - 30, 0);
    }

    // Determine if server-side monitoring is possible
    if (
      (classification === 'Public API' || classification === 'GraphQL Endpoint' || classification === 'Static HTML Page') &&
      confidenceScore >= 50
    ) {
      isMonitoredServerSide = true;
    }

    this.logger.log(`[ANALYSIS] Request url: ${requestUrl} classified as: ${classification} with confidence score: ${confidenceScore}. Server monitoring: ${isMonitoredServerSide}`);

    return {
      isJobPostingEndpoint,
      classification,
      confidenceScore,
      isMonitoredServerSide
    };
  }
}
