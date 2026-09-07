const { test, expect } = require('../../fixtures/payout-api-fixture');

test.describe('Payout Platform auth API', () => {
  test('refresh token returns a new token pair and invalidates the old refresh token', async ({ payoutApi, request }) => {
    const oldRefreshToken = payoutApi.refreshToken;

    const refreshed = await payoutApi.refreshJwtToken();

    expect(refreshed.result.access_token).toBeTruthy();
    expect(refreshed.result.refresh_token).toBeTruthy();
    expect(refreshed.result.refresh_token).not.toBe(oldRefreshToken);

    const reuseOldToken = await request.post('/v1/payout-platform/auth/refresh-token', {
      data: { refresh_token: oldRefreshToken },
    });

    expect(reuseOldToken.ok()).toBeFalsy();
  });
});
