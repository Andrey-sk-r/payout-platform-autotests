const { test: base, expect } = require('@playwright/test');
const { PayoutApiClient } = require('../../src/api/payout-api-client');
const { requiredEnv } = require('../../src/config/env');
const { setCurrentEmployeeTestTitle } = require('../../src/test-data/employee-customer-builders');
const { readSessionTokens, writeSessionTokens } = require('./session-auth');

let cachedTokenPair = null;

const test = base.extend({
  employeeTestTitle: [async ({}, use, testInfo) => {
    setCurrentEmployeeTestTitle(testInfo.title);
    await use(testInfo.title);
    setCurrentEmployeeTestTitle('');
  }, { auto: true }],

  payoutApi: async ({ request }, use) => {
    const client = new PayoutApiClient(request);
    if (!cachedTokenPair) {
      cachedTokenPair = readSessionTokens();
    }
    if (cachedTokenPair) {
      client.accessToken = cachedTokenPair.accessToken;
      client.refreshToken = cachedTokenPair.refreshToken;
    } else {
      await client.loginWithOtp({
        email: requiredEnv('PLATFORM_USER_EMAIL'),
        password: requiredEnv('PLATFORM_USER_PASSWORD'),
        otpCode: requiredEnv('PLATFORM_EMAIL_OTP'),
      });
      cachedTokenPair = {
        accessToken: client.accessToken,
        refreshToken: client.refreshToken,
      };
    }
    await use(client);
    cachedTokenPair = {
      accessToken: client.accessToken,
      refreshToken: client.refreshToken,
    };
    writeSessionTokens(cachedTokenPair);
  },
});

module.exports = {
  test,
  expect,
};
