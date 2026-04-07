/**
 * Strava OAuth Setup Script
 *
 * Usage:
 *   npx tsx scripts/strava-auth.ts
 *
 * This script walks you through connecting a Strava account to NanoClaw.
 * Run it once per athlete (you + your wife). It saves credentials to
 * data/sessions/telegram_main/.claude/strava-credentials.json
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = path.resolve(__dirname, "..");
const credPath = path.join(
  nanoclawRoot,
  "data/sessions/telegram_main/.claude/strava-credentials.json"
);

const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = "read,activity:read_all";

function rl(prompt: string): Promise<string> {
  const iface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    iface.question(prompt, (ans) => {
      iface.close();
      resolve(ans.trim());
    });
  });
}

function loadCredentials(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(credPath)) return [];
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    return [];
  }
}

function saveCredentials(creds: Record<string, unknown>[]) {
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Authorization denied. You can close this tab.</h2>");
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>✅ Authorization successful! You can close this tab and return to the terminal.</h2>"
        );
        server.close();
        resolve(code);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`\nListening for OAuth callback on port ${CALLBACK_PORT}...`);
    });

    server.on("error", reject);
  });
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number; firstname: string; lastname: string };
}> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: number; firstname: string; lastname: string };
  }>;
}

async function main() {
  console.log("\n🚴 Strava OAuth Setup\n");

  const existing = loadCredentials();
  if (existing.length > 0) {
    console.log(
      `Found ${existing.length} existing account(s):`,
      existing.map((c) => (c as { athlete_name: string }).athlete_name).join(", ")
    );
    console.log("Adding another account...\n");
  }

  const clientId = await rl("Client ID (from strava.com/settings/api): ");
  const clientSecret = await rl("Client Secret: ");

  if (!clientId || !clientSecret) {
    console.error("Client ID and Client Secret are required.");
    process.exit(1);
  }

  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&approval_prompt=force` +
    `&scope=${SCOPES}`;

  console.log("\nOpen this URL in your browser to authorize:\n");
  console.log(authUrl);
  console.log(
    "\n(A local server is listening for the redirect — keep this terminal open)\n"
  );

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    console.error("Failed to get authorization code:", err);
    process.exit(1);
  }

  console.log("\nExchanging code for tokens...");
  let tokenData: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokenData = await exchangeCode(clientId, clientSecret, code);
  } catch (err) {
    console.error("Token exchange failed:", err);
    process.exit(1);
  }

  const { athlete } = tokenData;
  const athleteName = `${athlete.firstname} ${athlete.lastname}`.trim();

  console.log(`\n✅ Connected: ${athleteName} (ID: ${athlete.id})`);

  const newCred = {
    athlete_id: athlete.id,
    athlete_name: athleteName,
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokenData.refresh_token,
    access_token: tokenData.access_token,
    token_expiry: tokenData.expires_at,
  };

  // Replace existing entry for this athlete or append
  const updated = [
    ...existing.filter(
      (c) => (c as { athlete_id: number }).athlete_id !== athlete.id
    ),
    newCred,
  ];

  saveCredentials(updated);
  console.log(`\nCredentials saved to:\n${credPath}`);
  console.log(`\nConnected accounts: ${updated.map((c) => (c as { athlete_name: string }).athlete_name).join(", ")}`);
  console.log(
    "\nNext: trigger a Strava sync from your chat to pull activity history."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
