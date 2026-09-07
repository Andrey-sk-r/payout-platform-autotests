const { test, expect } = require('../../fixtures/payout-api-fixture');

const malformedUuid = 'not-a-uuid';
const nonExistentUuid = '00000000-0000-4000-8000-000000000000';

const protectedRoutes = [
  { id: 'LIST', method: 'get', path: '/v1/payout-platform/beneficiary/beneficiary-list' },
  { id: 'DETAIL', method: 'get', path: '/v1/payout-platform/beneficiary/get-details', options: { params: { beneficiary_uuid: nonExistentUuid } } },
  { id: 'DEST-LIST', method: 'get', path: '/v1/payout-platform/beneficiary/destination-list' },
  { id: 'CREATE', method: 'post', path: '/v1/payout-platform/beneficiary/create', options: { data: {} } },
  { id: 'UPDATE', method: 'post', path: '/v1/payout-platform/beneficiary/update', options: { data: {} } },
  { id: 'DEST-CREATE', method: 'post', path: '/v1/payout-platform/beneficiary/create-destination', options: { data: {} } },
  { id: 'DEST-UPDATE', method: 'post', path: '/v1/payout-platform/beneficiary/update-destination', options: { data: {} } },
  { id: 'DEST-STATUS', method: 'post', path: '/v1/payout-platform/beneficiary/destination-change-status', options: { data: {} } },
  { id: 'DEST-DELETE', method: 'post', path: '/v1/payout-platform/beneficiary/destination/delete-destination', options: { data: {} } },
  { id: 'BULK-APPROVE', method: 'post', path: '/v1/payout-platform/beneficiary/destination/approve-pending-bulk-by-beneficiary', options: { data: {} } },
  { id: 'BULK-REJECT', method: 'post', path: '/v1/payout-platform/beneficiary/destination/reject-pending-bulk-by-beneficiary', options: { data: {} } },
  { id: 'DOC-DELETE', method: 'post', path: '/v1/payout-platform/beneficiary/document-delete', options: { data: {} } },
  { id: 'DOC-DOWNLOAD', method: 'get', path: '/v1/payout-platform/beneficiary/document-download', options: { params: { document_uuid: nonExistentUuid } } },
];

function listFrom(body) {
  return body?.result?.list || body?.result?.beneficiary_list || [];
}

function beneficiaryUuid(beneficiary) {
  return beneficiary?.beneficiary_uuid || beneficiary?.uuid;
}

function destinationUuid(destination) {
  return destination?.destination_uuid || destination?.uuid;
}

function beneficiaryFromCreate(body) {
  return body?.result?.beneficiary?.beneficiary || body?.result?.beneficiary || body?.result;
}

async function expectNonOk(response, message) {
  expect(response.ok(), message).toBeFalsy();
}

async function firstBeneficiary(payoutApi) {
  const body = await payoutApi.listBeneficiaries({ limit: 20, offset: 0 });
  return listFrom(body).find((beneficiary) => beneficiaryUuid(beneficiary));
}

async function firstDestination(payoutApi, params = {}) {
  const body = await payoutApi.listBeneficiaryDestinations({
    limit: 20,
    offset: 0,
    ...params,
  });
  return listFrom(body).find((destination) => destinationUuid(destination));
}

test.describe('Payout Platform beneficiary API', () => {
  for (const route of protectedRoutes) {
    test(`BEN-AUTH-NEG-${route.id}: ${route.method.toUpperCase()} ${route.path} rejects unauthenticated request`, async ({ request }) => {
      const response = await request[route.method](route.path, route.options || {});

      await expectNonOk(response, `${route.path} must require authentication`);
    });
  }

  test('BEN-LIST-001: beneficiary-list returns paginated beneficiary rows', async ({ payoutApi }) => {
    const body = await payoutApi.listBeneficiaries({ limit: 10, offset: 0 });
    const list = listFrom(body);

    expect(body.meta).toBeTruthy();
    expect(Array.isArray(list)).toBeTruthy();
    for (const beneficiary of list) {
      expect(beneficiaryUuid(beneficiary), 'beneficiary uuid').toBeTruthy();
      expect(beneficiary.display_name || beneficiary.name, 'beneficiary display name').toBeTruthy();
    }
  });

  test('BEN-LIST-002: beneficiary-list filters by display name substring', async ({ payoutApi }) => {
    const sample = await firstBeneficiary(payoutApi);
    test.skip(!sample, 'No beneficiaries exist in this organisation.');

    const displayName = sample.display_name || sample.name;
    const token = displayName.split(/\s+/).find((part) => part.length >= 2) || displayName.slice(0, 3);
    const body = await payoutApi.listBeneficiaries({ display_name: token, limit: 20, offset: 0 });
    const list = listFrom(body);

    expect(list.some((beneficiary) => beneficiaryUuid(beneficiary) === beneficiaryUuid(sample))).toBeTruthy();
  });

  test('BEN-DEST-LIST-001: destination-list returns destination rows with beneficiary and rail data', async ({ payoutApi }) => {
    const body = await payoutApi.listBeneficiaryDestinations({ limit: 10, offset: 0 });
    const list = listFrom(body);

    expect(Array.isArray(list)).toBeTruthy();
    for (const destination of list) {
      expect(destinationUuid(destination), 'destination uuid').toBeTruthy();
      expect(destination.rail, 'destination rail').toBeTruthy();
      expect(destination.beneficiary || destination.beneficiary_uuid, 'destination beneficiary data').toBeTruthy();
    }
  });

  test('BEN-DEST-LIST-002: destination-list supports approved EFT filter', async ({ payoutApi }) => {
    const body = await payoutApi.listBeneficiaryDestinations({
      status: 'approved',
      rail: 'eft',
      disabled: false,
      limit: 10,
      offset: 0,
    });
    const list = listFrom(body);

    expect(Array.isArray(list)).toBeTruthy();
    for (const destination of list) {
      expect(destination.status).toBe('approved');
      expect(destination.rail).toBe('eft');
      expect(destination.disabled).toBeFalsy();
    }
  });

  test('BEN-DETAIL-001: get-details returns beneficiary, documents, and creator metadata', async ({ payoutApi }) => {
    const sample = await firstBeneficiary(payoutApi);
    test.skip(!sample, 'No beneficiaries exist in this organisation.');

    const body = await payoutApi.getBeneficiaryDetails(beneficiaryUuid(sample));
    const result = body.result?.beneficiary || body.result;
    const beneficiary = result?.beneficiary || result;

    expect(beneficiaryUuid(beneficiary)).toBe(beneficiaryUuid(sample));
    expect(Array.isArray(result.documents || [])).toBeTruthy();
    expect(result.creator || beneficiary.created_by || beneficiary.created_at).toBeTruthy();
  });

  test('BEN-DETAIL-NEG-001: get-details rejects missing beneficiary UUID', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/beneficiary/get-details', {
      params: {},
    });

    await expectNonOk(response, 'get-details must reject missing beneficiary_uuid');
  });

  test('BEN-DETAIL-NEG-002: get-details rejects malformed beneficiary UUID', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/beneficiary/get-details', {
      params: { beneficiary_uuid: malformedUuid },
    });

    await expectNonOk(response, 'get-details must reject malformed beneficiary_uuid');
  });

  test('BEN-DETAIL-NEG-003: get-details rejects non-existent beneficiary UUID', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/beneficiary/get-details', {
      params: { beneficiary_uuid: nonExistentUuid },
    });

    await expectNonOk(response, 'get-details must reject non-existent beneficiary_uuid');
  });

  test('BEN-CREATE-NEG-001: create rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.createBeneficiary({});

    await expectNonOk(response, 'create must reject empty body');
  });

  test('BEN-CREATE-002: create accepts beneficiary without destinations', async ({ payoutApi }, testInfo) => {
    const displayName = `Codex Beneficiary Only ${Date.now()}`;
    const response = await payoutApi.createBeneficiary({
      display_name: displayName,
      creator_comment: 'Beneficiary-only API contract coverage',
    });
    await expect(response, 'create beneficiary without destinations').toBeOK();

    const body = await response.json();
    const created = beneficiaryFromCreate(body);
    const uuid = beneficiaryUuid(created);
    expect(uuid, 'created beneficiary uuid').toBeTruthy();
    testInfo.annotations.push({ type: 'beneficiary_uuid', description: uuid });

    const detailBody = await payoutApi.getBeneficiaryDetails(uuid);
    const detail = detailBody.result?.beneficiary?.beneficiary || detailBody.result?.beneficiary || detailBody.result;
    expect(beneficiaryUuid(detail)).toBe(uuid);
    expect(detail.display_name).toBe(displayName);
  });

  test('BEN-UPDATE-NEG-001: update rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateBeneficiary({});

    await expectNonOk(response, 'update must reject empty body');
  });

  test('BEN-UPDATE-NEG-002: update rejects malformed beneficiary UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateBeneficiary({
      beneficiary_uuid: malformedUuid,
      display_name: 'Codex malformed uuid',
    });

    await expectNonOk(response, 'update must reject malformed beneficiary UUID');
  });

  test('BEN-DEST-CREATE-NEG-001: create-destination rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.createBeneficiaryDestination({});

    await expectNonOk(response, 'create-destination must reject empty body');
  });

  test('BEN-DEST-CREATE-NEG-002: create-destination rejects non-existent beneficiary UUID', async ({ payoutApi }) => {
    const response = await payoutApi.createBeneficiaryDestination({
      beneficiary_uuid: nonExistentUuid,
      rail: 'eft',
      bank_identifier: 'fnb',
      bank_account_number: '1234567890',
    });

    await expectNonOk(response, 'create-destination must reject non-existent beneficiary UUID');
  });

  test('BEN-DEST-UPDATE-NEG-001: update-destination rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateBeneficiaryDestination({});

    await expectNonOk(response, 'update-destination must reject empty body');
  });

  test('BEN-DEST-UPDATE-NEG-002: update-destination rejects malformed destination UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateBeneficiaryDestination({
      destination_uuid: malformedUuid,
      rail: 'eft',
      bank_identifier: 'fnb',
      bank_account_number: '1234567890',
    });

    await expectNonOk(response, 'update-destination must reject malformed destination UUID');
  });

  test('BEN-DEST-STATUS-NEG-001: destination-change-status rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.changeBeneficiaryDestinationStatus({});

    await expectNonOk(response, 'destination-change-status must reject empty body');
  });

  test('BEN-DEST-STATUS-NEG-002: destination-change-status rejects unsupported status', async ({ payoutApi }) => {
    const destination = await firstDestination(payoutApi);
    test.skip(!destination, 'No beneficiary destinations exist in this organisation.');

    const response = await payoutApi.changeBeneficiaryDestinationStatus({
      destination_uuid: destinationUuid(destination),
      status: 'not_a_real_status',
    });

    await expectNonOk(response, 'destination-change-status must reject unsupported status');
  });

  test('BEN-BULK-APPROVE-NEG-001: approve pending bulk rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.approvePendingDestinationsByBeneficiary({});

    await expectNonOk(response, 'bulk approve must reject empty body');
  });

  test('BEN-BULK-REJECT-NEG-001: reject pending bulk rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.rejectPendingDestinationsByBeneficiary({});

    await expectNonOk(response, 'bulk reject must reject empty body');
  });

  test('BEN-DOC-UPLOAD-NEG-001: document-upload rejects missing file', async ({ payoutApi }) => {
    const sample = await firstBeneficiary(payoutApi);
    test.skip(!sample, 'No beneficiaries exist in this organisation.');

    const response = await payoutApi.post('/v1/payout-platform/beneficiary/document-upload', {
      multipart: {
        beneficiary_uuid: beneficiaryUuid(sample),
      },
    });

    await expectNonOk(response, 'document-upload must reject missing file');
  });

  test('BEN-DOC-DELETE-NEG-001: document-delete rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.deleteBeneficiaryDocument({});

    await expectNonOk(response, 'document-delete must reject empty body');
  });

  test('BEN-DOC-DOWNLOAD-NEG-001: document-download rejects malformed document UUID', async ({ payoutApi }) => {
    const response = await payoutApi.downloadBeneficiaryDocument(malformedUuid);

    await expectNonOk(response, 'document-download must reject malformed document UUID');
  });
});
