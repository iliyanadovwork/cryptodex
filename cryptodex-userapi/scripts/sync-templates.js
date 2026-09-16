/**
 * Resend Email Template Sync Script
 *
 * This script reads local HTML email templates and syncs them to Resend.
 * It creates/updates templates and publishes them automatically.
 *
 * Usage: RESEND_API_KEY=re_xxx node scripts/sync-templates.js
 *
 * Requirements: RESEND_API_KEY with Full Access permissions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API Configuration
const API_KEY = process.env.RESEND_API_KEY;
const API_BASE = 'https://api.resend.com';

// Domain configuration
const DOMAIN = 'cryptodex.exchange';

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make API request to Resend with retry
 */
async function apiRequest(endpoint, options = {}, retries = 3) {
  const url = `${API_BASE}${endpoint}`;

  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    const data = await response.json();

    // Rate limited - wait and retry
    if (response.status === 429) {
      const waitTime = (i + 1) * 1000; // 1s, 2s, 3s
      console.log(`  Rate limited. Waiting ${waitTime}ms before retry...`);
      await delay(waitTime);
      continue;
    }

    if (!response.ok) {
      const error = new Error(data.message || `API Error: ${response.status}`);
      error.statusCode = response.status;
      error.response = { data };
      throw error;
    }

    return data;
  }

  throw new Error('Max retries exceeded due to rate limiting');
}

/**
 * Get existing templates
 */
async function getExistingTemplates() {
  try {
    const result = await apiRequest('/templates');
    return result?.data || result || [];
  } catch {
    return [];
  }
}

/**
 * Find template by alias (partial match)
 */
function findTemplateByAlias(templates, alias) {
  // Try exact match first
  let found = templates.find(t => t.alias === alias);
  if (found) return found;

  // Try partial match (in case alias has suffix)
  found = templates.find(t => t.alias && t.alias.includes(alias));
  if (found) return found;

  // Try by name
  return templates.find(t => t.name === alias);
}

// Template configuration
const TEMPLATES = [
  {
    filename: 'activate_register_user.html',
    name: 'Email Verification - Registration',
    alias: 'email-verification-registration',
    subject: 'Verify Your Email Address',
    from: `verify@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'EMAIL_VERIFICATION_OTP.html',
    name: 'OTP Verification - Login',
    alias: 'otp-verification',
    subject: 'Your Login Verification Code',
    from: `verify@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'User_forgot.html',
    name: 'Password Reset',
    alias: 'password-reset',
    subject: 'Reset Your Password',
    from: `noreply@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'Change_Password.html',
    name: 'Password Changed',
    alias: 'password-changed',
    subject: 'Password Changed Successfully',
    from: `security@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'change_register_email.html',
    name: 'Email Change Request',
    alias: 'email-change-request',
    subject: 'Verify Email Change',
    from: `verify@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'verify_new_email.html',
    name: 'New Email Verification',
    alias: 'new-email-verification',
    subject: 'Verify New Email Address',
    from: `verify@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'Login_confirmation.html',
    name: 'Login OTP Code',
    alias: 'login-otp',
    subject: 'Login Verification Code',
    from: `verify@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'Login_notification.html',
    name: 'New Login Notification',
    alias: 'new-login-notification',
    subject: 'New Login Detected',
    from: `alerts@${DOMAIN}`,
    replyTo: `security@${DOMAIN}`
  },
  {
    filename: 'User_deposit.html',
    name: 'Deposit Confirmation',
    alias: 'deposit-confirmation',
    subject: 'Deposit Received',
    from: `alerts@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  },
  {
    filename: 'Withdraw_notification.html',
    name: 'Withdrawal Confirmation',
    alias: 'withdrawal-confirmation',
    subject: 'Withdrawal Successful',
    from: `alerts@${DOMAIN}`,
    replyTo: `support@${DOMAIN}`
  }
];

/**
 * Extract variables from HTML content with types
 */
function extractVariables(html) {
  // Match {{{VARIABLE}}} pattern
  const regex = /\{\{\{([A-Z_][A-Z0-9_]*)\}\}\}/g;
  const variables = [];
  const seen = new Set();
  let match;

  // Variable type mapping - common patterns
  const numberPatterns = ['AMOUNT', 'COUNT', 'EXPIRES', 'MINUTES', 'HOURS', 'DAYS'];

  while ((match = regex.exec(html)) !== null) {
    const varName = match[1];
    if (!seen.has(varName)) {
      seen.add(varName);
      // Determine type based on variable name
      const isNumber = numberPatterns.some(p => varName.includes(p));
      variables.push({
        key: varName,
        type: isNumber ? 'number' : 'string'
      });
    }
  }

  return variables;
}

/**
 * Read HTML template file
 */
function readTemplate(filename) {
  const templatesDir = path.join(__dirname, '../email-templates');
  const filePath = path.join(templatesDir, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Create or update a template in Resend
 */
async function upsertTemplate(templateConfig, existingTemplates) {
  const { filename, name, alias, subject, from, replyTo } = templateConfig;

  console.log(`\nProcessing: ${alias} (${filename})`);

  // Read HTML content
  const html = readTemplate(filename);

  // Extract variables from HTML
  const variables = extractVariables(html);
  console.log(`  Found ${variables.length} variables: ${variables.slice(0, 5).map(v => v.key).join(', ')}${variables.length > 5 ? '...' : ''}`);

  // Check if template already exists
  const existing = findTemplateByAlias(existingTemplates, alias);

  if (existing) {
    // Update existing template
    console.log(`  Found existing template: ${existing.id}`);
    console.log(`  Updating...`);

    await apiRequest(`/templates/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        html,
        subject,
        from,
        replyTo,
        variables
      })
    });

    console.log(`  Updated successfully`);

    // Wait before publishing
    await delay(1000);

    // Publish
    console.log(`  Publishing...`);
    await apiRequest(`/templates/${existing.id}/publish`, {
      method: 'POST'
    });
    console.log(`  Published!`);

    return { success: true, id: existing.id, updated: true };
  }

  // Create new template
  console.log(`  Creating new template "${name}"...`);

  const createResult = await apiRequest('/templates', {
    method: 'POST',
    body: JSON.stringify({
      name,
      alias,
      html,
      subject,
      from,
      replyTo,
      variables
    })
  });

  const templateId = createResult.id;
  console.log(`  Created: ${templateId}`);

  // Wait before publishing
  await delay(1000);

  // Publish the template
  console.log(`  Publishing...`);
  await apiRequest(`/templates/${templateId}/publish`, {
    method: 'POST'
  });
  console.log(`  Published!`);

  return { success: true, id: templateId };
}

/**
 * Main sync function
 */
async function syncTemplates() {
  console.log('='.repeat(60));
  console.log('Resend Email Template Sync');
  console.log('='.repeat(60));
  console.log(`Domain: ${DOMAIN}`);
  console.log(`Templates to sync: ${TEMPLATES.length}`);

  // Check API key
  if (!API_KEY) {
    console.error('\nERROR: RESEND_API_KEY environment variable not set!');
    console.error('Please set it with: export RESEND_API_KEY=re_xxxxxxxxx');
    process.exit(1);
  }

  // Fetch existing templates once
  console.log('\nFetching existing templates...');
  const existingTemplates = await getExistingTemplates();
  console.log(`Found ${existingTemplates.length} existing templates`);

  const results = {
    success: [],
    failed: []
  };

  // Process each template
  for (let i = 0; i < TEMPLATES.length; i++) {
    const template = TEMPLATES[i];
    console.log(`\n[${i + 1}/${TEMPLATES.length}]`);

    try {
      const result = await upsertTemplate(template, existingTemplates);

      if (result.success) {
        results.success.push({
          alias: template.alias,
          id: result.id,
          updated: result.updated
        });

        // Add the new template to our list so subsequent iterations can find it
        if (!result.updated) {
          existingTemplates.push({
            id: result.id,
            alias: template.alias,
            name: template.name
          });
        }
      }
    } catch (error) {
      results.failed.push({
        alias: template.alias,
        error: error.message
      });
    }

    // Delay between templates (rate limit: 2 req/sec)
    if (i < TEMPLATES.length - 1) {
      await delay(1000);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Sync Summary');
  console.log('='.repeat(60));
  console.log(`Successful: ${results.success.length}`);
  console.log(`Failed: ${results.failed.length}`);

  if (results.success.length > 0) {
    console.log('\nSuccessful templates:');
    results.success.forEach(t => {
      console.log(`  ${t.alias} (ID: ${t.id})${t.updated ? ' - updated' : ' - created'}`);
    });
  }

  if (results.failed.length > 0) {
    console.log('\nFailed templates:');
    results.failed.forEach(t => {
      console.log(`  ${t.alias} - ${t.error}`);
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log('Usage in your code:');
  console.log('='.repeat(60));
  console.log(`
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: 'verify@cryptodex.exchange',
  to: 'user@example.com',
  template: {
    id: 'email-verification',  // Use the alias
    variables: {
      USER_EMAIL: 'user@example.com',
      VERIFY_URL: 'https://...'
    }
  }
});
  `);
}

// Run the sync
syncTemplates().catch(console.error);
