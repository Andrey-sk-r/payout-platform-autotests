const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env.stage') });

const statePath = path.resolve(__dirname, '.auth', 'session-state.json');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-session', open: 'never' }],
  ],
  use: {
    baseURL: process.env.PLATFORM_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: { Accept: 'application/json' },
  },
  projects: [
    {
      name: 'session-setup',
      testMatch: /session-auth\.setup\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      dependencies: ['session-setup'],
      testMatch: /.*\.ui\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: statePath,
      },
    },
    {
      name: 'api',
      dependencies: ['session-setup'],
      testMatch: /.*\.api\.spec\.js/,
      testIgnore: /employee-cards/,
      use: {
        baseURL: process.env.PLATFORM_API_BASE_URL,
      },
    },
  ],
});
