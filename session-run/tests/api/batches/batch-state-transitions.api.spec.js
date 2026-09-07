const { test, expect } = require('../../fixtures/payout-api-fixture');
const { optionalEnv, requiredEnv } = require('../../../src/config/env');

function batchFrom(body) {
  return body?.result?.batch;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

function lineUuid(line) {
  return line?.line_uuid || line?.uuid;
}

function firstEftDestination(body) {
  const list = body?.result?.list || [];
  return list.find((destination) => destination.rail === 'eft' && destination.destination_uuid) || null;
}

async function expectOkJson(response, label) {
  await expect(response, label).toBeOK();
  return response.json();
}

async function approvedEftDestination(payoutApi) {
  const destinationsBody = await payoutApi.listBeneficiaryDestinations({
    status: 'approved',
    disabled: false,
    per_page: 20,
  });
  const destination = firstEftDestination(destinationsBody);
  expect(destination, 'approved EFT destination is required').toBeTruthy();
  return destination;
}

async function createDraftBatch(payoutApi, runId, namePart, extra = {}) {
  const body = await expectOkJson(await payoutApi.createBatch({
    name: `Codex API ${namePart} ${runId}`,
    client_batch_reference: `CODEX-API-${namePart.toUpperCase().replace(/\s+/g, '-')}-${runId}`,
    ...extra,
  }), `create ${namePart} batch`);
  return batchFrom(body);
}

async function addLineAndSubmit(payoutApi, batchUuid, destination, runId) {
  await expectOkJson(await payoutApi.addBatchDraftLine({
    batch_uuid: batchUuid,
    destination_uuid: destination.destination_uuid,
    amount: '11.00',
    reference: `Codex API transition ${runId}`,
    internal_reference: `CODEX-API-TRANSITION-${runId}`,
  }), 'add transition draft line');

  const submitBody = await expectOkJson(await payoutApi.submitBatch({
    batch_uuid: batchUuid,
    force_submit: true,
  }), 'submit transition batch');
  expect(batchFrom(submitBody).status).toBe('submitted');

  const detail = await payoutApi.getBatchByUuid(batchUuid);
  expect(lineUuid(batchLines(batchFrom(detail))[0]), 'submitted line uuid').toBeTruthy();
  return batchFrom(detail);
}

async function approveBatch(payoutApi, batchUuid) {
  await expectOkJson(await payoutApi.requestBatchApprovalOtp({
    batch_uuid: batchUuid,
  }), 'request transition approval OTP');

  const approveBody = await expectOkJson(await payoutApi.approveBatch({
    batch_uuid: batchUuid,
    email_otp: requiredEnv('PLATFORM_EMAIL_OTP'),
    phone_otp: requiredEnv('PLATFORM_APPROVAL_PHONE_OTP'),
    force_approve: true,
  }), 'approve transition batch');
  return batchFrom(approveBody);
}

test.describe('Payout Platform batch API state transitions', () => {
  test.skip(process.env.PLATFORM_ENV !== 'stage', 'Batch state mutation coverage is currently approved only for stage/preprod2.');
  test.skip(optionalEnv('ALLOW_MUTATING_BATCH_TESTS') !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create and mutate real stage batches.');

  test('BATCH-STATE-001: draft mark-deleted endpoint accepts draft batch', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const batch = await createDraftBatch(payoutApi, runId, 'Draft Delete');
    testInfo.annotations.push({ type: 'batch_uuid', description: batch.batch_uuid });

    const deleteBody = await expectOkJson(await payoutApi.markBatchDeleted({
      batch_uuid: batch.batch_uuid,
      reason: 'Codex API draft delete transition',
    }), 'mark draft batch deleted');
    expect(batchFrom(deleteBody).status).toBe('draft');

    const detail = await payoutApi.getBatchByUuid(batch.batch_uuid);
    expect(batchFrom(detail).status).toBe('draft');
  });

  test('BATCH-STATE-002: submitted batch can be cancelled', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const destination = await approvedEftDestination(payoutApi);
    const batch = await createDraftBatch(payoutApi, runId, 'Submitted Cancel');
    testInfo.annotations.push({ type: 'batch_uuid', description: batch.batch_uuid });

    await addLineAndSubmit(payoutApi, batch.batch_uuid, destination, runId);

    const cancelBody = await expectOkJson(await payoutApi.cancelBatch({
      batch_uuid: batch.batch_uuid,
      reason: 'Codex API submitted cancel transition',
    }), 'cancel submitted batch');
    expect(batchFrom(cancelBody).status).toBe('cancelled');
    expect(batchFrom(cancelBody).changed_status_reason).toBe('Codex API submitted cancel transition');

    const detail = await payoutApi.getBatchByUuid(batch.batch_uuid);
    expect(batchFrom(detail).status).toBe('cancelled');
  });

  test('BATCH-STATE-003: scheduled approved batch can be moved back to submitted and cancelled', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const destination = await approvedEftDestination(payoutApi);
    const batch = await createDraftBatch(payoutApi, runId, 'Scheduled Cancel', {
      scheduled_at_sast: '2026-12-18 15:30:00',
    });
    testInfo.annotations.push({ type: 'batch_uuid', description: batch.batch_uuid });

    await addLineAndSubmit(payoutApi, batch.batch_uuid, destination, runId);

    const approved = await approveBatch(payoutApi, batch.batch_uuid);
    expect(approved.status).toBe('approved');
    expect(approved.scheduled_at_sast).toBe('2026-12-18 15:30:00');

    const scheduledCancelBody = await expectOkJson(await payoutApi.cancelScheduledBatch({
      batch_uuid: batch.batch_uuid,
      reason: 'Codex API scheduled cancel transition',
    }), 'cancel scheduled approved batch');
    expect(batchFrom(scheduledCancelBody).status).toBe('submitted');
    expect(batchFrom(scheduledCancelBody).changed_status_reason).toBe('Codex API scheduled cancel transition');

    const cleanupCancelBody = await expectOkJson(await payoutApi.cancelBatch({
      batch_uuid: batch.batch_uuid,
      reason: 'Codex API scheduled cleanup cancel',
    }), 'cleanup cancel resubmitted scheduled batch');
    expect(batchFrom(cleanupCancelBody).status).toBe('cancelled');
  });
});
