import { Injectable, Logger } from '@nestjs/common';
import { chromium } from 'playwright';

@Injectable()
export class PdfExportService {
  private readonly logger = new Logger(PdfExportService.name);

  async generatePdf(resumeData: any): Promise<Buffer> {
    this.logger.log(`[PDF-EXPORT] Generating PDF for ${resumeData.fullName}...`);

    // Build sections HTML based on sectionOrder
    const sectionOrder = resumeData.sectionOrder || ['skills', 'experience', 'projects', 'education'];
    let sectionsHtml = '';

    for (const section of sectionOrder) {
      if (section === 'skills' && resumeData.skills && resumeData.skills.length > 0) {
        sectionsHtml += `
          <div class="section-container">
            <h2 class="section-title">Skills & Competencies</h2>
            <div class="skills-grid">
              ${resumeData.skills.map(s => `<span class="skill-tag">${s}</span>`).join('')}
            </div>
          </div>
        `;
      } else if (section === 'experience' && resumeData.experience && resumeData.experience.length > 0) {
        sectionsHtml += `
          <div class="section-container">
            <h2 class="section-title">Professional Experience</h2>
            ${resumeData.experience.map(exp => `
              <div class="item-container">
                <div class="item-header">
                  <span class="item-primary">${exp.role}</span>
                  <span class="item-secondary">${exp.duration}</span>
                </div>
                <div class="item-subheader">${exp.company}</div>
                <div class="item-description">
                  ${exp.description.split('\n').filter(Boolean).map(bullet => `
                    <div class="bullet-point">${bullet.replace(/^-\s*/, '')}</div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `;
      } else if (section === 'projects' && resumeData.projects && resumeData.projects.length > 0) {
        sectionsHtml += `
          <div class="section-container">
            <h2 class="section-title">Key Projects</h2>
            ${resumeData.projects.map(proj => `
              <div class="item-container">
                <div class="item-header">
                  <span class="item-primary">${proj.title}</span>
                  ${proj.techStack && proj.techStack.length > 0 ? `<span class="item-secondary">${proj.techStack.join(', ')}</span>` : ''}
                </div>
                <div class="item-description">
                  ${proj.description.split('\n').filter(Boolean).map(bullet => `
                    <div class="bullet-point">${bullet.replace(/^-\s*/, '')}</div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `;
      } else if (section === 'education' && resumeData.education && resumeData.education.length > 0) {
        sectionsHtml += `
          <div class="section-container">
            <h2 class="section-title">Education</h2>
            ${resumeData.education.map(edu => `
              <div class="item-container">
                <div class="item-header">
                  <span class="item-primary">${edu.degree}</span>
                  <span class="item-secondary">${edu.duration || ''}</span>
                </div>
                <div class="item-subheader">${edu.institution}</div>
              </div>
            `).join('')}
          </div>
        `;
      }
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          
          body {
            font-family: 'Inter', sans-serif;
            color: #1f2937;
            margin: 0;
            padding: 0;
            font-size: 10.5pt;
            line-height: 1.5;
          }
          
          .header-container {
            text-align: center;
            margin-bottom: 22px;
            border-bottom: 2px solid #e5e7eb;
            padding-bottom: 12px;
          }
          
          .candidate-name {
            font-size: 22pt;
            font-weight: 700;
            color: #111827;
            margin: 0 0 5px 0;
            letter-spacing: -0.02em;
          }
          
          .contact-details {
            font-size: 9.5pt;
            color: #4b5563;
          }
          
          .contact-item {
            display: inline-block;
          }
          
          .contact-separator {
            margin: 0 8px;
            color: #d1d5db;
          }
          
          .section-container {
            margin-bottom: 18px;
            page-break-inside: avoid;
          }
          
          .section-title {
            font-size: 12.5pt;
            font-weight: 600;
            color: #111827;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid #d1d5db;
            padding-bottom: 3px;
            margin: 0 0 10px 0;
          }
          
          .skills-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
          }
          
          .skill-tag {
            background-color: #f3f4f6;
            color: #374151;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 9pt;
            font-weight: 500;
          }
          
          .item-container {
            margin-bottom: 12px;
            page-break-inside: avoid;
          }
          
          .item-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
          }
          
          .item-primary {
            font-size: 10.5pt;
            font-weight: 600;
            color: #111827;
          }
          
          .item-secondary {
            font-size: 9pt;
            color: #6b7280;
            font-weight: 500;
          }
          
          .item-subheader {
            font-size: 10pt;
            font-weight: 500;
            color: #4b5563;
            margin-top: 1px;
          }
          
          .item-description {
            margin-top: 5px;
          }
          
          .bullet-point {
            position: relative;
            padding-left: 12px;
            font-size: 9.5pt;
            color: #374151;
            margin-bottom: 3px;
          }
          
          .bullet-point::before {
            content: "•";
            position: absolute;
            left: 2px;
            color: #9ca3af;
          }
          
          @media print {
            body {
              -webkit-print-color-adjust: exact;
            }
            .section-container {
              page-break-inside: avoid;
            }
            .item-container {
              page-break-inside: avoid;
            }
          }
        </style>
      </head>
      <body>
        <div class="header-container">
          <h1 class="candidate-name">${resumeData.fullName}</h1>
          <div class="contact-details">
            <span class="contact-item">${resumeData.email}</span>
            ${resumeData.phone ? `
              <span class="contact-separator">|</span>
              <span class="contact-item">${resumeData.phone}</span>
            ` : ''}
          </div>
        </div>
        
        ${resumeData.summary ? `
          <div class="section-container">
            <h2 class="section-title">Professional Summary</h2>
            <p style="margin: 0; font-size: 9.5pt; color: #374151; line-height: 1.5; text-align: justify;">${resumeData.summary}</p>
          </div>
        ` : ''}
        
        ${sectionsHtml}
      </body>
      </html>
    `;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: 'load' });
      
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '0.4in',
          right: '0.4in',
          bottom: '0.4in',
          left: '0.4in'
        }
      });
      return pdfBuffer;
    } finally {
      await browser.close();
    }
  }
}
