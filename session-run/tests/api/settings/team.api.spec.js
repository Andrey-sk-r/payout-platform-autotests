const { test, expect } = require('../../fixtures/payout-api-fixture');

const malformedUuid = 'not-a-uuid';
const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
const makerRole = 'payout_maker';
const checkerRole = 'payout_checker';

const protectedRoutes = [
  { id: 'LIST', method: 'get', path: '/v1/payout-platform/org-user/get-list' },
  { id: 'INVITE', method: 'post', path: '/v1/payout-platform/org-user/invite', options: { data: {} } },
  { id: 'UPDATE', method: 'post', path: '/v1/payout-platform/org-user/update', options: { data: {} } },
  { id: 'RESEND', method: 'post', path: '/v1/payout-platform/org-user/resend-invite', options: { data: {} } },
  { id: 'DISABLE', method: 'post', path: '/v1/payout-platform/org-user/disable', options: { data: {} } },
  { id: 'ENABLE', method: 'post', path: '/v1/payout-platform/org-user/enable', options: { data: {} } },
];

function orgUserList(body) {
  return body?.result?.list || body?.result?.user_list || body?.list || [];
}

function orgUserUuid(user) {
  return user?.user_uuid || user?.uuid;
}

function expectOrgUserShape(user) {
  expect(orgUserUuid(user), 'user uuid').toBeTruthy();
  expect(user.email, 'email').toBeTruthy();
  expect(Array.isArray(user.roles), 'roles').toBeTruthy();
  expect(user.status, 'status').toBeTruthy();
}

async function expectNonOk(response, message) {
  expect(response.ok(), message).toBeFalsy();
}

async function findOrgUserByEmail(payoutApi, email) {
  const body = await payoutApi.listOrgUsers();
  return orgUserList(body).find((user) => user.email === email);
}

function disposableUserPayload(suffix, overrides = {}) {
  const phoneSuffix = String(suffix).slice(-8).padStart(8, '0');
  const firstNames = ['Amahle', 'Bongani', 'Lerato', 'Sipho', 'Thabo', 'Zanele'];
  const lastNames = ['Maseko', 'Dlamini', 'Khumalo', 'Mokoena', 'Naidoo', 'Nkosi'];
  const index = Number(phoneSuffix.slice(-2)) % firstNames.length;
  return {
    first_name: firstNames[index],
    last_name: lastNames[index],
    email: `stage.team.${suffix}@email.com`,
    phone: `278${phoneSuffix}`,
    roles: [makerRole],
    ...overrides,
  };
}

test.describe('Payout Platform settings team API', () => {
  for (const route of protectedRoutes) {
    test(`TEAM-AUTH-NEG-${route.id}: ${route.method.toUpperCase()} ${route.path} rejects unauthenticated request`, async ({ request }) => {
      const response = await request[route.method](route.path, route.options || {});

      await expectNonOk(response, `${route.path} must require authentication`);
    });
  }

  test('TEAM-LIST-001: get-list returns team members with roles and statuses', async ({ payoutApi }) => {
    const body = await payoutApi.listOrgUsers();
    const list = orgUserList(body);

    expect(Array.isArray(list)).toBeTruthy();
    expect(list.length, 'stage organisation should have team members').toBeGreaterThan(0);
    for (const user of list) {
      expectOrgUserShape(user);
    }
  });

  const invalidInviteCases = [
    { id: '001', title: 'empty body', data: {} },
    { id: '002', title: 'missing first name', data: disposableUserPayload(Date.now(), { first_name: '' }) },
    { id: '003', title: 'missing last name', data: disposableUserPayload(Date.now(), { last_name: '' }) },
    { id: '004', title: 'malformed email', data: disposableUserPayload(Date.now(), { email: 'not-an-email' }) },
    { id: '005', title: 'missing phone', data: disposableUserPayload(Date.now(), { phone: '' }) },
    { id: '006', title: 'empty roles', data: disposableUserPayload(Date.now(), { roles: [] }) },
    { id: '007', title: 'unknown role', data: disposableUserPayload(Date.now(), { roles: ['unknown_role'] }) },
  ];

  for (const testCase of invalidInviteCases) {
    test(`TEAM-INVITE-NEG-${testCase.id}: invite rejects ${testCase.title}`, async ({ payoutApi }) => {
      const response = await payoutApi.inviteOrgUser(testCase.data);

      await expectNonOk(response, `invite must reject ${testCase.title}`);
    });
  }

  test('TEAM-UPDATE-NEG-001: update rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateOrgUser({});

    await expectNonOk(response, 'update must reject empty body');
  });

  test('TEAM-UPDATE-NEG-002: update rejects malformed user UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateOrgUser({
      user_uuid: malformedUuid,
      first_name: 'Stage',
      last_name: 'Member',
      email: 'stage.member@email.com',
      phone: '27810000000',
      roles: [makerRole],
    });

    await expectNonOk(response, 'update must reject malformed UUID');
  });

  test('TEAM-UPDATE-NEG-003: update rejects non-existent user UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateOrgUser({
      user_uuid: nonExistentUuid,
      first_name: 'Stage',
      last_name: 'Member',
      email: 'stage.member@email.com',
      phone: '27810000000',
      roles: [makerRole],
    });

    await expectNonOk(response, 'update must reject non-existent UUID');
  });

  for (const testCase of [
    { id: 'RESEND-001', title: 'resend-invite empty body', call: (payoutApi) => payoutApi.resendOrgUserInvite({}) },
    { id: 'RESEND-002', title: 'resend-invite malformed UUID', call: (payoutApi) => payoutApi.resendOrgUserInvite({ user_uuid: malformedUuid }) },
    { id: 'RESEND-003', title: 'resend-invite non-existent UUID', call: (payoutApi) => payoutApi.resendOrgUserInvite({ user_uuid: nonExistentUuid }) },
    { id: 'DISABLE-001', title: 'disable empty body', call: (payoutApi) => payoutApi.disableOrgUser({}) },
    { id: 'DISABLE-002', title: 'disable malformed UUID', call: (payoutApi) => payoutApi.disableOrgUser({ user_uuid: malformedUuid, reason: 'QA validation' }) },
    { id: 'DISABLE-003', title: 'disable missing reason', call: (payoutApi) => payoutApi.disableOrgUser({ user_uuid: nonExistentUuid }) },
    { id: 'ENABLE-001', title: 'enable empty body', call: (payoutApi) => payoutApi.enableOrgUser({}) },
    { id: 'ENABLE-002', title: 'enable malformed UUID', call: (payoutApi) => payoutApi.enableOrgUser({ user_uuid: malformedUuid }) },
    { id: 'ENABLE-003', title: 'enable non-existent UUID', call: (payoutApi) => payoutApi.enableOrgUser({ user_uuid: nonExistentUuid }) },
  ]) {
    test(`TEAM-${testCase.id}: ${testCase.title} is rejected`, async ({ payoutApi }) => {
      const response = await testCase.call(payoutApi);

      await expectNonOk(response, `${testCase.title} must be rejected`);
    });
  }

  test('TEAM-MUT-001: invite, update, resend invite, disable, enable, and disable disposable user', async ({ payoutApi }) => {
    const suffix = Date.now();
    const original = disposableUserPayload(suffix);
    const updated = disposableUserPayload(suffix, {
      first_name: `${original.first_name} Updated`,
      roles: [checkerRole],
    });
    let userUuid;

    try {
      const inviteResponse = await payoutApi.inviteOrgUser(original);
      await expect(inviteResponse, 'invite disposable org user').toBeOK();

      const invited = await findOrgUserByEmail(payoutApi, original.email);
      expect(invited, 'invited user must appear in list').toBeTruthy();
      userUuid = orgUserUuid(invited);
      expect(invited.status, 'newly invited user status').toBe('pending');
      expect(invited.roles).toContain(makerRole);

      const updateResponse = await payoutApi.updateOrgUser({
        user_uuid: userUuid,
        ...updated,
      });
      await expect(updateResponse, 'update disposable org user').toBeOK();

      const updatedUser = await findOrgUserByEmail(payoutApi, updated.email);
      expect(updatedUser, 'updated user must stay findable by email').toBeTruthy();
      expect(updatedUser.first_name).toBe(updated.first_name);
      expect(updatedUser.roles).toContain(checkerRole);

      const resendResponse = await payoutApi.resendOrgUserInvite({ user_uuid: userUuid });
      await expect(resendResponse, 'resend disposable org user invite').toBeOK();

      const disableResponse = await payoutApi.disableOrgUser({
        user_uuid: userUuid,
        reason: 'Automated stage cleanup',
      });
      await expect(disableResponse, 'disable disposable org user').toBeOK();

      const enableResponse = await payoutApi.enableOrgUser({ user_uuid: userUuid });
      await expect(enableResponse, 'enable disposable org user').toBeOK();
    } finally {
      if (userUuid) {
        const cleanupResponse = await payoutApi.disableOrgUser({
          user_uuid: userUuid,
          reason: 'Automated stage cleanup',
        });
        await expect(cleanupResponse, 'final cleanup disables disposable org user').toBeOK();
      }
    }
  });
});
