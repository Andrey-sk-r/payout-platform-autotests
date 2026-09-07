const fs = require('node:fs');
const path = require('node:path');

const tokenPath = path.resolve(__dirname, '..', '..', '.auth', 'session-tokens.json');
const statePath = path.resolve(__dirname, '..', '..', '.auth', 'session-state.json');
let sharedContext;
let sharedPage;

function readSessionTokens() {
  const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  return {
    accessToken: saved.accessToken,
    refreshToken: saved.refreshToken,
    access_token: saved.accessToken,
    refresh_token: saved.refreshToken,
  };
}

function writeSessionTokens({ accessToken, refreshToken }) {
  fs.writeFileSync(tokenPath, JSON.stringify({ accessToken, refreshToken }), 'utf8');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const origin = state.origins.find((item) => item.origin === process.env.PLATFORM_BASE_URL);
  if (!origin) throw new Error('Authenticated frontend origin is missing from storageState');

  const value = JSON.stringify({ refreshToken });
  const stored = origin.localStorage.find((item) => item.name === 'pp.tokens');
  if (stored) stored.value = value;
  else origin.localStorage.push({ name: 'pp.tokens', value });

  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
}

async function getSessionPage(browser) {
  if (!sharedContext) {
    sharedContext = await browser.newContext({ storageState: statePath });
    sharedContext.on('response', async (response) => {
      if (!response.url().endsWith('/v1/payout-platform/auth/refresh-token') || !response.ok()) return;
      try {
        const result = (await response.json()).result;
        writeSessionTokens({
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
        });
      } catch {
        // Do not log authentication data; affected tests will surface session failures.
      }
    });
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await sharedContext.newPage();
  }
  return sharedPage;
}

module.exports = {
  getSessionPage,
  readSessionTokens,
  writeSessionTokens,
  statePath,
  tokenPath,
};
