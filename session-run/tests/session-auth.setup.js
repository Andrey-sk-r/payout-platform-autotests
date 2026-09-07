const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { tokenPath } = require('./fixtures/session-auth');

const statePath = path.resolve(__dirname, '..', '.auth', 'session-state.json');

function waitTimeoutMs(text) {
  const match = String(text).match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match) return 0;
  return (Number(match[1] || 0) * 60 + Number(match[2] || 0) + 5) * 1000;
}

async function requestOtpToken(request) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await request.post(
        `${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`,
        {
          data: {
            email: process.env.PLATFORM_USER_EMAIL,
            password: process.env.PLATFORM_USER_PASSWORD,
          },
          timeout: 45_000,
        },
      );
    } catch (error) {
      const transient = /ETIMEDOUT|ECONNRESET|socket hang up|ENOTFOUND|EAI_AGAIN/i.test(error.message || '');
      if (!transient || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      continue;
    }
    const text = await response.text();
    if (response.ok()) return JSON.parse(text).result.temp_token;

    const delay = waitTimeoutMs(text);
    if (!delay || attempt === 3) {
      throw new Error(`Session OTP request failed with status ${response.status()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error('Unable to request the session OTP token');
}

test('create one reusable authenticated session', async ({ page, request }) => {
  test.setTimeout(15 * 60_000);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const tempToken = await requestOtpToken(request);
  const loginResponse = await request.post(
    `${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/login`,
    {
      data: {
        email: process.env.PLATFORM_USER_EMAIL,
        temp_token: tempToken,
        otp_code: process.env.PLATFORM_EMAIL_OTP,
      },
      timeout: 45_000,
    },
  );
  await expect(loginResponse, 'single-session API login').toBeOK();
  const initialTokenPair = (await loginResponse.json()).result;

  await page.goto('/login');
  await page.evaluate(
    ({ refreshToken }) => {
      localStorage.setItem('pp.tokens', JSON.stringify({ refreshToken }));
    },
    { refreshToken: initialTokenPair.refresh_token },
  );
  const refreshResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/payout-platform/auth/refresh-token') && response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await page.goto('/dashboard');
  const refreshResponse = await refreshResponsePromise;
  expect(refreshResponse.ok(), 'frontend session refresh').toBeTruthy();
  const tokenPair = (await refreshResponse.json()).result;
  await page.waitForURL(
    (url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'),
    { timeout: 60_000 },
  );

  await fs.writeFile(
    tokenPath,
    JSON.stringify({
      accessToken: tokenPair.access_token,
      refreshToken: tokenPair.refresh_token,
    }),
    'utf8',
  );
  await page.context().storageState({ path: statePath });
});
