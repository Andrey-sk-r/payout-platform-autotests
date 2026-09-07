const { test, expect } = require('../../fixtures/payout-api-fixture');

function beneficiaryUuid(beneficiary) {
  return beneficiary?.beneficiary_uuid || beneficiary?.uuid;
}

function destinationUuid(destination) {
  return destination?.destination_uuid || destination?.uuid;
}

function beneficiaryFromCreate(body) {
  return body?.result?.beneficiary?.beneficiary || body?.result?.beneficiary || body?.result;
}

function destinationsFromDetails(body) {
  const result = body?.result?.beneficiary || body?.result || {};
  return result.destinations || result.beneficiary?.destinations || result.destination_list || [];
}

function destinationFromResponse(body) {
  return body?.result?.destination || body?.result?.beneficiary_destination || body?.result;
}

async function createDisposableBeneficiary(payoutApi, suffix) {
  const response = await payoutApi.createBeneficiary({
    display_name: `Codex Destination Lifecycle ${suffix}`,
    creator_comment: 'Automated beneficiary destination lifecycle coverage',
  });
  await expect(response, 'create disposable beneficiary').toBeOK();
  const body = await response.json();
  const beneficiary = beneficiaryFromCreate(body);
  const uuid = beneficiaryUuid(beneficiary);
  expect(uuid, 'created beneficiary uuid').toBeTruthy();
  return uuid;
}

async function getDestinationByUuid(payoutApi, beneficiaryUuidValue, destinationUuidValue) {
  const details = await payoutApi.getBeneficiaryDetails(beneficiaryUuidValue);
  return destinationsFromDetails(details).find((destination) => destinationUuid(destination) === destinationUuidValue);
}

test.describe('Payout Platform beneficiary destination positive lifecycle API', () => {
  test('BEN-DEST-LIFE-001: create, update, approve, add, reject, and delete disposable e-wallet destinations', async ({ payoutApi }) => {
    const suffix = Date.now();
    const beneficiaryUuidValue = await createDisposableBeneficiary(payoutApi, suffix);
    let approvedDestinationUuid;
    let rejectedDestinationUuid;

    const firstPhone = `2782${String(suffix).slice(-7)}`;
    const updatedFirstPhone = `2783${String(suffix).slice(-7)}`;
    const secondPhone = `2784${String(suffix).slice(-7)}`;

    try {
      const createDestinationResponse = await payoutApi.createBeneficiaryDestination({
        beneficiary_uuid: beneficiaryUuidValue,
        rail: 'e-wallet',
        phone_number: firstPhone,
      });
      await expect(createDestinationResponse, 'create pending e-wallet destination').toBeOK();
      approvedDestinationUuid = destinationUuid(destinationFromResponse(await createDestinationResponse.json()));
      expect(approvedDestinationUuid, 'created destination uuid').toBeTruthy();

      let destination = await getDestinationByUuid(payoutApi, beneficiaryUuidValue, approvedDestinationUuid);
      expect(destination?.status, 'new destination status').toBe('pending');
      expect(destination?.phone_number, 'new destination phone').toContain(firstPhone.slice(-7));

      const updateDestinationResponse = await payoutApi.updateBeneficiaryDestination({
        destination_uuid: approvedDestinationUuid,
        rail: 'e-wallet',
        phone_number: updatedFirstPhone,
      });
      await expect(updateDestinationResponse, 'update pending e-wallet destination').toBeOK();

      destination = await getDestinationByUuid(payoutApi, beneficiaryUuidValue, approvedDestinationUuid);
      expect(JSON.stringify(destination), 'updated phone should be reflected in details').toContain(updatedFirstPhone.slice(-7));

      const approveResponse = await payoutApi.approvePendingDestinationsByBeneficiary({
        beneficiary_uuid: beneficiaryUuidValue,
      });
      await expect(approveResponse, 'approve pending destination').toBeOK();

      destination = await getDestinationByUuid(payoutApi, beneficiaryUuidValue, approvedDestinationUuid);
      expect(destination?.status, 'approved destination status').toBe('approved');

      const createSecondDestinationResponse = await payoutApi.createBeneficiaryDestination({
        beneficiary_uuid: beneficiaryUuidValue,
        rail: 'e-wallet',
        phone_number: secondPhone,
      });
      await expect(createSecondDestinationResponse, 'create second pending e-wallet destination').toBeOK();
      rejectedDestinationUuid = destinationUuid(destinationFromResponse(await createSecondDestinationResponse.json()));
      expect(rejectedDestinationUuid, 'second destination uuid').toBeTruthy();

      const rejectResponse = await payoutApi.rejectPendingDestinationsByBeneficiary({
        beneficiary_uuid: beneficiaryUuidValue,
        reason: 'Automated rejection coverage',
      });
      await expect(rejectResponse, 'reject pending destination').toBeOK();

      destination = await getDestinationByUuid(payoutApi, beneficiaryUuidValue, rejectedDestinationUuid);
      expect(destination?.status, 'rejected destination status').toBe('rejected');
    } finally {
      for (const uuid of [approvedDestinationUuid, rejectedDestinationUuid].filter(Boolean)) {
        const deleteResponse = await payoutApi.deleteBeneficiaryDestination({
          destination_uuid: uuid,
          reason: 'Automated stage cleanup',
        });
        expect([200, 400, 404, 409, 422], `cleanup destination ${uuid}`).toContain(deleteResponse.status());
      }
    }
  });
});
