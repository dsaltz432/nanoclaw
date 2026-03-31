/**
 * Gmail OAuth Authorization
 *
 * Requests gmail.readonly scope for the metadata extractor.
 * Opens a browser for Google OAuth, then saves the token.
 */
import fs from 'fs';
import http from 'http';
import open from 'open';
import path from 'path';
import { google } from 'googleapis';

const GMAIL_MCP_DIR = path.join(process.env.HOME || '~', '.gmail-mcp');
const OAUTH_KEYS_PATH = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');
const TOKEN_PATH = path.join(GMAIL_MCP_DIR, 'credentials.json');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

async function main() {
  if (!fs.existsSync(OAUTH_KEYS_PATH)) {
    console.error(`OAuth keys not found at ${OAUTH_KEYS_PATH}`);
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const { client_id, client_secret } = keys.installed || keys.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('Opening browser for authorization...');
  console.log(`If it doesn't open, visit: ${authUrl}\n`);

  // Start a temporary server to receive the callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const authCode = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
        server.close();
        resolve(authCode);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      open(authUrl).catch(() => {
        console.log('Could not open browser automatically.');
      });
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out after 120 seconds'));
    }, 120_000);
  });

  const { tokens } = await oauth2Client.getToken(code);
  console.log('Got tokens, saving...');

  const tokenData = { tokens, scopes: SCOPES };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2) + '\n');
  console.log(`Saved to ${TOKEN_PATH}`);
  console.log('Done! You can now run the metadata extractor.');
}

main().catch((err) => {
  console.error('Authorization failed:', err.message);
  process.exit(1);
});
