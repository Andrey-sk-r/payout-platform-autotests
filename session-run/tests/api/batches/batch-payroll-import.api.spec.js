const { test, expect } = require('../../fixtures/payout-api-fixture');
const { optionalEnv } = require('../../../src/config/env');

function listFrom(body) {
  return body?.result?.list || body?.result?.provider_credential_list || [];
}

function credentialUuid(credential) {
  return credential?.uuid || credential?.provider_credential_uuid;
}

const simplePayResourceName = process.env.SIMPLEPAY_RESOURCE_NAME || 'SP original';

function payRunsFrom(body) {
  return body?.result?.pay_run_list?.pay_run_list || [];
}

function batchFrom(body) {
  return body?.result?.batch;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

function importStatus(batch) {
  return batch?.payroll_imports?.[0]?.status;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectOkJson(response, label) {
  await expect(response, label).toBeOK();
  return response.json();
}

async function activeSimplePayCredentialResponse(payoutApi) {
  const response = await payoutApi.get('/v1/payout-platform/provider-credential/get-list', {
    params: {
      provider_code: 'simplepay',
      is_active: true,
      limit: 20,
      offset: 0,
    },
  });
  if (!response.ok()) {
    return { response, body: await response.json().catch(() => null), credential: null };
  }
  const body = await response.json();
  return {
    response,
    body,
    credential: listFrom(body).find((credential) => (
      credential.provider_code === 'simplepay'
      && credential.is_active
      && credential.name === simplePayResourceName
      && credentialUuid(credential)
    )),
  };
}

async function availableSimplePayPayRuns(payoutApi, credential) {
  const response = await payoutApi.listPayrollPayRunsResponse({
    provider_credential_uuid: credentialUuid(credential),
  });
  const body = await response.json().catch(() => null);
  const error = body?.error || {};
  const upstreamCredentialUnavailable = response.status() === 400
    && error.code === 'auth'
    && error.sub_code === 'apikey'
    && /simplepay.*(?:401|not authorized|does not exist)/i.test(`${error.title || ''} ${error.detail || ''}`);

  test.skip(
    upstreamCredentialUnavailable,
    `Active SimplePay credential "${simplePayResourceName}" is rejected by upstream SimplePay (401).`,
  );
  expect(response, 'payroll pay run list').toBeOK();
  return body;
}

test.describe('Payout Platform batch payroll import API', () => {
  test('BATCH-PAYROLL-001: active SimplePay credential can list payroll runs', async ({ payoutApi }) => {
    const result = await activeSimplePayCredentialResponse(payoutApi);
    test.skip(result.response.status() === 429, 'Provider credential list is currently rate-limited for this user.');
    expect(result.response, 'provider credential list').toBeOK();

    const credential = result.credential;
    test.skip(!credential, 'No active SimplePay provider credential exists in this environment.');

    const body = await availableSimplePayPayRuns(payoutApi, credential);
    const payRuns = payRunsFrom(body);

    expect(Array.isArray(payRuns)).toBeTruthy();
    for (const payRun of payRuns) {
      expect(payRun.payment_run_id, 'payment run id').toBeTruthy();
      expect(payRun.period_end_date || payRun.period_start_date || payRun.description || payRun.name).toBeTruthy();
    }
  });

  test('BATCH-PAYROLL-002: pay-run-list rejects missing provider credential UUID', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/payroll-import/pay-run-list', {
      params: {},
    });

    expect(response.ok()).toBeFalsy();
  });

  test('BATCH-PAYROLL-003: load-into-draft-batch rejects empty body without mutating data', async ({ payoutApi }) => {
    const response = await payoutApi.loadPayrollRunIntoDraftBatch({});

    expect(response.ok()).toBeFalsy();
    const body = await response.json();
    expect(body.error?.code || body.error?.title || body.message).toBeTruthy();
  });

  test('BATCH-PAYROLL-004: SimplePay pay run loads into a draft batch asynchronously', async ({ payoutApi }, testInfo) => {
    test.skip(process.env.PLATFORM_ENV !== 'stage', 'SimplePay import mutation is currently approved only for stage/preprod2.');
    test.skip(optionalEnv('ALLOW_MUTATING_BATCH_TESTS') !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create real stage draft batches.');

    const result = await activeSimplePayCredentialResponse(payoutApi);
    test.skip(result.response.status() === 429, 'Provider credential list is currently rate-limited for this user.');
    expect(result.response, 'provider credential list').toBeOK();

    const credential = result.credential;
    test.skip(!credential, 'No active SimplePay provider credential exists in this environment.');

    const payRunsBody = await availableSimplePayPayRuns(payoutApi, credential);
    const payRun = payRunsFrom(payRunsBody).find((item) => Number(item.total_amount || 0) > 0);
    test.skip(!payRun, 'A non-empty SimplePay pay run is required for import coverage.');

    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const createBody = await expectOkJson(await payoutApi.createBatch({
      name: `Codex SimplePay Import ${runId}`,
      client_batch_reference: `CODEX-SIMPLEPAY-${runId}`,
    }), 'create SimplePay import batch');
    const batchUuid = batchFrom(createBody).batch_uuid;
    testInfo.annotations.push({ type: 'batch_uuid', description: batchUuid });

    const loadBody = await expectOkJson(await payoutApi.loadPayrollRunIntoDraftBatch({
      batch_uuid: batchUuid,
      provider_credential_uuid: credentialUuid(credential),
      payroll_list: [{ payment_run_id: payRun.payment_run_id }],
    }), 'load SimplePay pay run into draft batch');
    expect(batchFrom(loadBody).payroll_imports[0].status).toBe('queued');

    let detailBody;
    let batch;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await sleep(2_000);
      detailBody = await payoutApi.getBatchByUuid(batchUuid);
      batch = batchFrom(detailBody);
      const status = importStatus(batch);
      if (status && !['queued', 'processing', 'importing'].includes(status)) break;
      if (batchLines(batch).length > 0) break;
    }

    expect(batch.status).toBe('draft');
    expect(['completed', 'completed_with_errors']).toContain(importStatus(batch));
    expect(Number(batch.total_count)).toBeGreaterThan(0);
    expect(batchLines(batch).length).toBeGreaterThan(0);
    expect(batchLines(batch).some((line) => line.reference?.startsWith('simplepay-payslip-'))).toBeTruthy();
    expect(Array.isArray(batch.payroll_imports[0].warning_list)).toBeTruthy();
  });
});
