const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('../../fixtures/payout-api-fixture');
const { optionalEnv } = require('../../../src/config/env');

const fixturesDir = path.resolve(__dirname, '../../../test-data/batches');

function batchFrom(body) {
  return body?.result?.batch;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectOkJson(response, label) {
  await expect(response, label).toBeOK();
  return response.json();
}

async function uploadFixtureToNewBatch(payoutApi, fixture, testInfo) {
  const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const createBody = await expectOkJson(await payoutApi.createBatch({
    name: `Codex Upload ${fixture.kind} ${runId}`,
    client_batch_reference: `CODEX-UPLOAD-${fixture.kind.toUpperCase()}-${runId}`,
  }), `create ${fixture.kind} upload batch`);
  const batchUuid = batchFrom(createBody).batch_uuid;
  testInfo.annotations.push({ type: 'batch_uuid', description: batchUuid });

  const uploadBody = await expectOkJson(await payoutApi.uploadBatchFile({
    batchUuid,
    file: {
      name: path.basename(fixture.filePath),
      mimeType: fixture.mimeType,
      buffer: fs.readFileSync(fixture.filePath),
    },
  }), `upload ${fixture.kind} batch file`);

  let detailBody;
  let batch;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await sleep(2_000);
    detailBody = await payoutApi.getBatchByUuid(batchUuid);
    batch = batchFrom(detailBody);
    const uploaded = batch.uploaded_files || [];
    const errors = batch.error_files || [];
    if (uploaded.some((file) => file.status === 'done') || errors.length > 0 || batchLines(batch).length > 0) break;
  }

  return { batchUuid, uploadBody, batch };
}

test.describe('Payout Platform batch file upload API', () => {
  test.describe.configure({ timeout: 120_000 });

  test.skip(process.env.PLATFORM_ENV !== 'stage', 'Batch file upload mutation is currently approved only for stage/preprod2.');
  test.skip(optionalEnv('ALLOW_MUTATING_BATCH_TESTS') !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create real stage draft batches.');

  test('BATCH-UPLOAD-001: CSV upload records row-level validation failures in draft batch', async ({ payoutApi }, testInfo) => {
    const fixture = {
      kind: 'csv',
      filePath: path.join(fixturesDir, 'payout_batch_ticket_test.csv'),
      mimeType: 'text/csv',
    };
    test.skip(!fs.existsSync(fixture.filePath), 'CSV fixture is required for upload coverage.');

    const { uploadBody, batch } = await uploadFixtureToNewBatch(payoutApi, fixture, testInfo);
    expect(uploadBody.result.file_uuid).toBeTruthy();

    const uploaded = batch.uploaded_files[0];
    expect(batch.status).toBe('draft');
    expect(uploaded.status).toBe('done');
    expect(uploaded.total_rows).toBe(23);
    expect(uploaded.success_rows).toBe(15);
    expect(uploaded.error_rows).toBe(8);
    expect(uploaded.has_error).toBeTruthy();

    const lines = batchLines(batch);
    expect(lines).toHaveLength(23);
    expect(lines.filter((line) => line.validation_status === 'invalid')).toHaveLength(8);
    expect(lines.some((line) => line.reference === 'TC19-MULTI-ERROR' && line.validation_status === 'invalid')).toBeTruthy();
    expect(lines.some((line) => line.reference === 'TC21-UNKNOWN-BANK' && line.validation_status === 'invalid')).toBeTruthy();
    expect(lines.some((line) => line.reference === 'TC08-AMOUNT-SPACE' && line.validation_status === 'valid')).toBeTruthy();
  });

  test('BATCH-UPLOAD-002: SimplePay XLSX upload creates valid draft lines', async ({ payoutApi }, testInfo) => {
    const fixture = {
      kind: 'simplepay-xlsx',
      filePath: path.join(fixturesDir, 'payment_run_sample.xlsx'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    test.skip(!fs.existsSync(fixture.filePath), 'SimplePay XLSX fixture is required for upload coverage.');

    const { uploadBody, batch } = await uploadFixtureToNewBatch(payoutApi, fixture, testInfo);
    expect(uploadBody.result.file_uuid).toBeTruthy();

    const uploaded = batch.uploaded_files[0];
    expect(batch.status).toBe('draft');
    expect(uploaded.status).toBe('done');
    expect(uploaded.total_rows).toBe(16);
    expect(uploaded.success_rows).toBe(16);
    expect(uploaded.error_rows).toBe(0);
    expect(uploaded.has_error).toBeFalsy();

    const lines = batchLines(batch);
    expect(lines).toHaveLength(16);
    expect(lines.every((line) => line.validation_status === 'valid')).toBeTruthy();
    expect(lines.every((line) => line.destination?.rail === 'eft' || line.destination?.rail === 'rtc')).toBeTruthy();
    expect(lines.every((line) => Number(line.amount) === 1)).toBeTruthy();
  });
});
