/**
 * Email Metadata Extractor (Container 1)
 *
 * Host-side script — no LLM, no browser, no messaging.
 * Queries Gmail API for metadata only (no email bodies ever fetched).
 * Writes sanitized candidate list for the agent to analyze.
 *
 * Security: This script has Gmail credentials but no AI.
 * The agent that reads this output has AI but no Gmail credentials.
 */
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

// --- Configuration ---

const GMAIL_MCP_DIR = path.join(
  process.env.HOME || '~',
  '.gmail-mcp',
);
const OAUTH_KEYS_PATH = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');
const TOKEN_PATH = path.join(GMAIL_MCP_DIR, 'credentials.json');

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'email-unsubscribe');
const METADATA_FILE = path.join(OUTPUT_DIR, 'sanitized_metadata.json');
const DOMAINS_FILE = path.join(OUTPUT_DIR, 'known_unsubscribe_domains.json');

// Labels to exclude — these are curated newsletters the user wants to keep
const EXCLUDED_LABELS = [
  'newsletters-daily-pulse',
  'newsletters-deep-dives',
];

const LOOKBACK_DAYS = 7;
const MAX_RESULTS_PER_QUERY = 200;

// --- Types ---

interface Candidate {
  senderName: string;
  senderEmail: string;
  subject: string;
  frequency: number;
  hasUnsubscribeHeader: boolean;
  unsubscribeUrl: string | null;
  hasOneClickUnsubscribe: boolean;
  messageId: string;
  labelIds: string[];
}

interface SenderAccumulator {
  senderName: string;
  senderEmail: string;
  subjects: string[];
  frequency: number;
  hasUnsubscribeHeader: boolean;
  unsubscribeUrl: string | null;
  hasOneClickUnsubscribe: boolean;
  messageId: string;
  labelIds: string[];
}

// --- Auth ---

function getAuthClient() {
  if (!fs.existsSync(OAUTH_KEYS_PATH)) {
    throw new Error(
      `Gmail OAuth keys not found at ${OAUTH_KEYS_PATH}. Run /add-gmail first.`,
    );
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `Gmail token not found at ${TOKEN_PATH}. Run /add-gmail first.`,
    );
  }

  const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const tokenFile = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));

  const { client_id, client_secret, redirect_uris } =
    keys.installed || keys.web;
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0],
  );
  // Token file uses {"tokens": {...}} wrapper
  oauth2Client.setCredentials(tokenFile.tokens || tokenFile);

  return oauth2Client;
}

// --- Gmail queries ---

async function fetchMessageMetadata(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
): Promise<Array<{ id: string; headers: Record<string, string>; labelIds: string[] }>> {
  const messages: Array<{ id: string; headers: Record<string, string>; labelIds: string[] }> = [];
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: MAX_RESULTS_PER_QUERY,
      pageToken,
    });

    const msgList = listRes.data.messages || [];
    pageToken = listRes.data.nextPageToken || undefined;

    // Fetch metadata for each message — format=metadata means no body
    for (const msg of msgList) {
      if (!msg.id) continue;

      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: [
          'From',
          'Subject',
          'List-Unsubscribe',
          'List-Unsubscribe-Post',
        ],
      });

      const headers: Record<string, string> = {};
      for (const h of detail.data.payload?.headers || []) {
        if (h.name && h.value) {
          headers[h.name.toLowerCase()] = h.value;
        }
      }

      messages.push({
        id: msg.id,
        headers,
        labelIds: detail.data.labelIds || [],
      });
    }
  } while (pageToken);

  return messages;
}

// --- Parsing helpers ---

function parseFromHeader(from: string): { name: string; email: string } {
  // "Example Store <deals@example.com>" → { name: "Example Store", email: "deals@example.com" }
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, '').trim(),
      email: match[2].toLowerCase(),
    };
  }
  return { name: from, email: from.toLowerCase() };
}

function extractUnsubscribeUrl(header: string | undefined): string | null {
  if (!header) return null;

  // List-Unsubscribe can contain multiple entries: <mailto:...>, <https://...>
  // We only want HTTPS URLs
  const urlMatch = header.match(/<(https?:\/\/[^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
}

function hasOneClick(postHeader: string | undefined): boolean {
  // List-Unsubscribe-Post: List-Unsubscribe=One-Click
  return !!postHeader?.toLowerCase().includes('one-click');
}

function sanitizeSubject(subject: string | undefined): string {
  if (!subject) return '(no subject)';

  // Strip to printable ASCII, collapse whitespace, truncate
  return subject
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// --- History filtering ---

function loadUnsubscribeHistory(): Set<string> {
  const historyPaths = [
    path.join(PROJECT_ROOT, 'groups', 'main', 'unsubscribe-history.json'),
    path.join(PROJECT_ROOT, 'groups', 'telegram_main', 'unsubscribe-history.json'),
  ];

  const unsubscribedEmails = new Set<string>();

  for (const historyPath of historyPaths) {
    if (!fs.existsSync(historyPath)) continue;
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      for (const entry of history.history || []) {
        if (entry.result === 'success' && entry.senderEmail) {
          unsubscribedEmails.add(entry.senderEmail.toLowerCase());
        }
      }
    } catch {
      // Ignore malformed history
    }
  }

  return unsubscribedEmails;
}

// --- Main ---

async function main() {
  console.log(`[${new Date().toISOString()}] Email metadata extraction starting`);

  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Build label exclusion clause
  const labelExclusions = EXCLUDED_LABELS.map((l) => `-label:${l}`).join(' ');

  // Two queries: list emails (newsletters) and promotions
  const queries = [
    `list:* newer_than:${LOOKBACK_DAYS}d ${labelExclusions}`,
    `category:promotions newer_than:${LOOKBACK_DAYS}d is:unread ${labelExclusions}`,
  ];

  console.log('Queries:', queries);

  // Fetch all messages
  const allMessages: Array<{ id: string; headers: Record<string, string>; labelIds: string[] }> = [];
  for (const query of queries) {
    const msgs = await fetchMessageMetadata(gmail, query);
    console.log(`  Query "${query.slice(0, 60)}..." → ${msgs.length} messages`);
    allMessages.push(...msgs);
  }

  // Deduplicate by message ID
  const uniqueMessages = new Map<string, (typeof allMessages)[0]>();
  for (const msg of allMessages) {
    uniqueMessages.set(msg.id, msg);
  }

  console.log(`Total unique messages: ${uniqueMessages.size}`);

  // Group by sender email, accumulate frequency
  const bySender = new Map<string, SenderAccumulator>();

  for (const msg of uniqueMessages.values()) {
    const from = msg.headers['from'];
    if (!from) continue;

    const { name, email } = parseFromHeader(from);
    const subject = sanitizeSubject(msg.headers['subject']);
    const unsubUrl = extractUnsubscribeUrl(msg.headers['list-unsubscribe']);
    const oneClick = hasOneClick(msg.headers['list-unsubscribe-post']);

    const existing = bySender.get(email);
    if (existing) {
      existing.frequency++;
      existing.subjects.push(subject);
      // Prefer the entry that has an unsubscribe URL
      if (!existing.unsubscribeUrl && unsubUrl) {
        existing.unsubscribeUrl = unsubUrl;
        existing.hasUnsubscribeHeader = true;
        existing.hasOneClickUnsubscribe = oneClick;
        existing.messageId = msg.id;
      }
    } else {
      bySender.set(email, {
        senderName: name,
        senderEmail: email,
        subjects: [subject],
        frequency: 1,
        hasUnsubscribeHeader: !!unsubUrl,
        unsubscribeUrl: unsubUrl,
        hasOneClickUnsubscribe: oneClick,
        messageId: msg.id,
        labelIds: msg.labelIds,
      });
    }
  }

  // Filter out already-unsubscribed senders
  const unsubscribedEmails = loadUnsubscribeHistory();
  const candidates: Candidate[] = [];
  const domains = new Set<string>();

  for (const sender of bySender.values()) {
    if (unsubscribedEmails.has(sender.senderEmail)) continue;

    // Use the most recent/representative subject
    const subject = sender.subjects[0];

    candidates.push({
      senderName: sender.senderName,
      senderEmail: sender.senderEmail,
      subject,
      frequency: sender.frequency,
      hasUnsubscribeHeader: sender.hasUnsubscribeHeader,
      unsubscribeUrl: sender.unsubscribeUrl,
      hasOneClickUnsubscribe: sender.hasOneClickUnsubscribe,
      messageId: sender.messageId,
      labelIds: sender.labelIds,
    });

    // Collect domains from unsubscribe URLs
    if (sender.unsubscribeUrl) {
      const domain = extractDomain(sender.unsubscribeUrl);
      if (domain) domains.add(domain);
    }
  }

  // Sort by frequency descending (most spammy first)
  candidates.sort((a, b) => b.frequency - a.frequency);

  console.log(`Candidates after filtering: ${candidates.length}`);

  // Write output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const metadata = {
    scanDate: new Date().toISOString().split('T')[0],
    scannedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    totalMessagesScanned: uniqueMessages.size,
    candidates,
  };
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2) + '\n');
  console.log(`Wrote ${candidates.length} candidates to ${METADATA_FILE}`);

  const domainData = {
    scanDate: new Date().toISOString().split('T')[0],
    domains: [...domains].sort(),
  };
  fs.writeFileSync(DOMAINS_FILE, JSON.stringify(domainData, null, 2) + '\n');
  console.log(`Wrote ${domains.size} domains to ${DOMAINS_FILE}`);

  console.log(`[${new Date().toISOString()}] Email metadata extraction complete`);
}

main().catch((err) => {
  console.error('Email metadata extraction failed:', err);
  process.exit(1);
});
