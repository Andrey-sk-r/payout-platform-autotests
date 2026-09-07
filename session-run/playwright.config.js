const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const dotenv = require('dotenv');

const envName = process.env.PLATFORM_ENV || 'dev';
dotenv.config({ path: path.resolve(__dirname, `.env.${envName}`) });

const baseURL = process.env.PLATFORM_BASE_URL || 'https://payout.test.olympusmobile.co.za';
const apiBaseURL = process.env.PLATFORM_API_BASE_URL || baseURL;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      Accept: 'application/json',
    },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.js/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'api',
      testMatch: /.*\.api\.spec\.js/,
      use: {
        baseURL: apiBaseURL,
      },
    },
    {
      name: 'chromium',
      testMatch: /.*\.ui\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
