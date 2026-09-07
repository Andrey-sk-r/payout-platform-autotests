const { expect } = require('@playwright/test');

class PayoutApiClient {
  constructor(request) {
    this.request = request;
    this.accessToken = null;
    this.refreshToken = null;
  }

  authHeaders() {
    if (!this.accessToken) {
      throw new Error('API client is not authenticated. Call loginWithOtp first.');
    }

    return {
      Authorization: this.accessToken,
      Accept: 'application/json',
    };
  }

  async requestWithRateLimitRetry(method, path, options = {}) {
    let response;
    let lastError;
    const retryDelays = [5_000, 15_000];

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        response = await this.request[method](path, {
          ...options,
          headers: {
            ...this.authHeaders(),
            ...(options.headers || {}),
          },
        });
      } catch (error) {
        lastError = error;
        const transient = /socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message || '');
        if (!transient || attempt === retryDelays.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }

      if (response.status() !== 429 || attempt === retryDelays.length) {
        return response;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }

    if (response) return response;
    throw lastError;
  }

  async get(path, options = {}) {
    return this.requestWithRateLimitRetry('get', path, options);
  }

  async post(path, options = {}) {
    return this.requestWithRateLimitRetry('post', path, options);
  }

  async requestOtpEmail({ email, password }) {
    let response;
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.request.post('/v1/payout-platform/auth/request-otp-email', {
          data: { email, password },
        });
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    if (!response) {
      throw lastError;
    }

    await expect(response, 'request OTP email').toBeOK();
    return response.json();
  }

  async loginWithOtp({ email, password, otpCode }) {
    const otpResponse = await this.requestOtpEmail({ email, password });
    const tempToken = otpResponse.result.temp_token;

    const response = await this.request.post('/v1/payout-platform/auth/login', {
      data: {
        email,
        temp_token: tempToken,
        otp_code: otpCode,
      },
    });
    await expect(response, 'login with OTP').toBeOK();

    const body = await response.json();
    this.accessToken = body.result.access_token;
    this.refreshToken = body.result.refresh_token;
    return body;
  }

  async refreshJwtToken(refreshToken = this.refreshToken) {
    const response = await this.request.post('/v1/payout-platform/auth/refresh-token', {
      data: { refresh_token: refreshToken },
    });
    await expect(response, 'refresh JWT token').toBeOK();

    const body = await response.json();
    this.accessToken = body.result.access_token;
    this.refreshToken = body.result.refresh_token;
    return body;
  }

  async me() {
    const response = await this.request.get('/v1/payout-platform/settings/me', {
      headers: this.authHeaders(),
    });
    await expect(response, 'settings me').toBeOK();
    return response.json();
  }

  async organisationInfo() {
    const response = await this.request.get('/v1/payout-platform/settings/get-organisation-info', {
      headers: this.authHeaders(),
    });
    await expect(response, 'organisation info').toBeOK();
    return response.json();
  }

  async getDashboard() {
    const response = await this.get('/v1/payout-platform/dashboard/get');
    await expect(response, 'dashboard get').toBeOK();
    return response.json();
  }

  async getEmployeeCustomerDashboard() {
    const response = await this.get('/v1/payout-platform/dashboard/get-employee-customer');
    await expect(response, 'employee customer dashboard get').toBeOK();
    return response.json();
  }

  async listOrgUsers() {
    const response = await this.get('/v1/payout-platform/org-user/get-list');
    await expect(response, 'org user list').toBeOK();
    return response.json();
  }

  async inviteOrgUser(data) {
    return this.post('/v1/payout-platform/org-user/invite', { data });
  }

  async updateOrgUser(data) {
    return this.post('/v1/payout-platform/org-user/update', { data });
  }

  async resendOrgUserInvite(data) {
    return this.post('/v1/payout-platform/org-user/resend-invite', { data });
  }

  async disableOrgUser(data) {
    return this.post('/v1/payout-platform/org-user/disable', { data });
  }

  async enableOrgUser(data) {
    return this.post('/v1/payout-platform/org-user/enable', { data });
  }

  async listProviderCredentials(params = {}) {
    const response = await this.get('/v1/payout-platform/provider-credential/get-list', { params });
    await expect(response, 'provider credential list').toBeOK();
    return response.json();
  }

  async listProviderJobs(params = {}) {
    const response = await this.get('/v1/payout-platform/provider-job/list', { params });
    await expect(response, 'provider job list').toBeOK();
    return response.json();
  }

  async getProviderJobStatus(jobUuid) {
    const response = await this.get('/v1/payout-platform/provider-job/get-status', {
      params: { job_uuid: jobUuid },
    });
    await expect(response, 'provider job get status').toBeOK();
    return response.json();
  }

  async getProviderCredentialByUuid(providerCredentialUuid) {
    return this.get('/v1/payout-platform/provider-credential/get-by-uuid', {
      params: { uuid: providerCredentialUuid },
    });
  }

  async createProviderCredential(data) {
    return this.post('/v1/payout-platform/provider-credential/create', {
      data,
    });
  }

  async updateProviderCredential(data) {
    return this.post('/v1/payout-platform/provider-credential/update', {
      data,
    });
  }

  async updateProviderCredentialActive(data) {
    return this.post('/v1/payout-platform/provider-credential/update-active', {
      data,
    });
  }

  async updateProviderCredentialApiKey(data) {
    return this.post('/v1/payout-platform/provider-credential/update-apikey', {
      data,
    });
  }

  async deleteProviderCredential(data) {
    return this.post('/v1/payout-platform/provider-credential/delete', {
      data,
    });
  }

  async createEmployeeCustomer(data) {
    return this.post('/v1/payout-platform/employee-customer/create-customer', {
      data,
    });
  }

  async expectCreateEmployeeCustomer(data) {
    const response = await this.createEmployeeCustomer(data);
    await expect(response, 'create employee customer').toBeOK();
    return response.json();
  }

  async editEmployeeCustomer(data) {
    return this.post('/v1/payout-platform/employee-customer/edit-customer', {
      data,
    });
  }

  async expectEditEmployeeCustomer(data) {
    const response = await this.editEmployeeCustomer(data);
    await expect(response, 'edit employee customer').toBeOK();
    return response.json();
  }

  async changeEmployeePhone(data) {
    return this.post('/v1/payout-platform/employee-customer/change-phone', {
      data,
    });
  }

  async listEmployeeCustomers(params = {}) {
    const response = await this.get('/v1/payout-platform/employee-customer/customer-list', {
      params,
    });
    await expect(response, 'list employee customers').toBeOK();
    return response.json();
  }

  async getEmployeeCustomerByUuid(customerUuid) {
    const response = await this.get('/v1/payout-platform/employee-customer/get-customer-by-uuid', {
      params: { customer_uuid: customerUuid },
    });
    await expect(response, 'get employee customer by uuid').toBeOK();
    return response.json();
  }

  async getEmployeeAuditHistory(customerUuid, params = {}) {
    const response = await this.get('/v1/payout-platform/employee-customer/audit-log/get-history', {
      params: {
        customer_uuid: customerUuid,
        ...params,
      },
    });
    await expect(response, 'get employee audit history').toBeOK();
    return response.json();
  }

  async getEmployeeVerificationInfo(customerUuid) {
    const response = await this.get('/v1/payout-platform/employee-customer/verification/info', {
      params: { customer_uuid: customerUuid },
    });
    await expect(response, 'get employee verification info').toBeOK();
    return response.json();
  }

  async runEmployeeVerification(customerUuid) {
    return this.post('/v1/payout-platform/employee-customer/verification/run-verification-operation', {
      data: { customer_uuid: customerUuid },
    });
  }

  async uploadEmployeeDocument({ customerUuid, documentType, file }) {
    return this.post('/v1/payout-platform/employee-customer/document/upload', {
      multipart: {
        customer_uuid: customerUuid,
        document_type: documentType,
        file,
      },
    });
  }

  async downloadEmployeeDocument(documentUuid) {
    return this.get('/v1/payout-platform/employee-customer/document/download', {
      params: { document_uuid: documentUuid },
    });
  }

  async allocateEmployeeCard({ customerUuid, token }) {
    return this.post('/v1/payout-platform/employee-customer/card/allocate-by-org-user', {
      data: {
        customer_uuid: customerUuid,
        token,
      },
    });
  }

  async activateEmployeeCard({ customerUuid, cardUuid, token }) {
    return this.post('/v1/payout-platform/employee-customer/card/activate-by-org-user', {
      data: {
        customer_uuid: customerUuid,
        card_uuid: cardUuid,
        token,
      },
    });
  }

  async blockEmployeeCard({ customerUuid, cardUuid, status }) {
    return this.post('/v1/payout-platform/employee-customer/card/block-by-org-user', {
      data: {
        customer_uuid: customerUuid,
        card_uuid: cardUuid,
        status,
      },
    });
  }

  async editEmployeeNotificationSettings({ customerUuid, cardOperationSmsEnabled }) {
    return this.post('/v1/payout-platform/employee-customer/edit-notification-settings', {
      data: {
        customer_uuid: customerUuid,
        card_operation_sms_enabled: cardOperationSmsEnabled,
      },
    });
  }

  async listEmployeeAccountTransactions({ accountUuid, limit = 50, offset = 0 }) {
    const response = await this.get('/v1/payout-platform/employee-customer/account/transaction-list', {
      params: {
        account_uuid: accountUuid,
        limit,
        offset,
      },
    });
    await expect(response, 'list employee account transactions').toBeOK();
    return response.json();
  }

  async listBeneficiaryDestinations(params = {}) {
    const response = await this.get('/v1/payout-platform/beneficiary/destination-list', {
      params,
    });
    await expect(response, 'beneficiary destination list').toBeOK();
    return response.json();
  }

  async listBeneficiaries(params = {}) {
    const response = await this.get('/v1/payout-platform/beneficiary/beneficiary-list', {
      params,
    });
    await expect(response, 'beneficiary list').toBeOK();
    return response.json();
  }

  async getBeneficiaryDetails(beneficiaryUuid) {
    const response = await this.get('/v1/payout-platform/beneficiary/get-details', {
      params: { beneficiary_uuid: beneficiaryUuid },
    });
    await expect(response, 'beneficiary details').toBeOK();
    return response.json();
  }

  async createBeneficiary(data) {
    return this.post('/v1/payout-platform/beneficiary/create', { data });
  }

  async updateBeneficiary(data) {
    return this.post('/v1/payout-platform/beneficiary/update', { data });
  }

  async createBeneficiaryDestination(data) {
    return this.post('/v1/payout-platform/beneficiary/create-destination', { data });
  }

  async updateBeneficiaryDestination(data) {
    return this.post('/v1/payout-platform/beneficiary/update-destination', { data });
  }

  async changeBeneficiaryDestinationStatus(data) {
    return this.post('/v1/payout-platform/beneficiary/destination-change-status', { data });
  }

  async deleteBeneficiaryDestination(data) {
    return this.post('/v1/payout-platform/beneficiary/destination/delete-destination', { data });
  }

  async approvePendingDestinationsByBeneficiary(data) {
    return this.post('/v1/payout-platform/beneficiary/destination/approve-pending-bulk-by-beneficiary', { data });
  }

  async rejectPendingDestinationsByBeneficiary(data) {
    return this.post('/v1/payout-platform/beneficiary/destination/reject-pending-bulk-by-beneficiary', { data });
  }

  async uploadBeneficiaryDocument({ beneficiaryUuid, file }) {
    return this.post('/v1/payout-platform/beneficiary/document-upload', {
      multipart: {
        beneficiary_uuid: beneficiaryUuid,
        file,
      },
    });
  }

  async deleteBeneficiaryDocument(data) {
    return this.post('/v1/payout-platform/beneficiary/document-delete', { data });
  }

  async downloadBeneficiaryDocument(documentUuid) {
    return this.get('/v1/payout-platform/beneficiary/document-download', {
      params: { document_uuid: documentUuid },
    });
  }

  async createBatch(data) {
    return this.post('/v1/payout-platform/batch/create', { data });
  }

  async listBatches(params = {}) {
    const response = await this.get('/v1/payout-platform/batch/get-list', {
      params,
    });
    await expect(response, 'batch list').toBeOK();
    return response.json();
  }

  async addBatchDraftLine(data) {
    return this.post('/v1/payout-platform/batch/draft-line/add', { data });
  }

  async uploadBatchFile({ batchUuid, file }) {
    return this.post('/v1/payout-platform/batch/load-csv-file', {
      multipart: {
        ...(batchUuid ? { batch_uuid: batchUuid } : {}),
        file,
      },
    });
  }

  async getBatchByUuid(batchUuid, params = {}) {
    const response = await this.get('/v1/payout-platform/batch/get-by-uuid', {
      params: {
        batch_uuid: batchUuid,
        include_items: true,
        ...params,
      },
    });
    await expect(response, 'get batch by uuid').toBeOK();
    return response.json();
  }

  async submitBatch(data) {
    return this.post('/v1/payout-platform/batch/status/submit', { data });
  }

  async markBatchDeleted(data) {
    return this.post('/v1/payout-platform/batch/status/mark-deleted', { data });
  }

  async cancelBatch(data) {
    return this.post('/v1/payout-platform/batch/status/cancel', { data });
  }

  async cancelScheduledBatch(data) {
    return this.post('/v1/payout-platform/batch/status/scheduled-cancel', { data });
  }

  async continueBatchExecution(data) {
    return this.post('/v1/payout-platform/batch/status/continue-execution', { data });
  }

  async markBatchLineForEdit(data) {
    return this.post('/v1/payout-platform/batch/line/mark-for-edit', { data });
  }

  async returnBatchForEdit(data) {
    return this.post('/v1/payout-platform/batch/status/return-for-edit', { data });
  }

  async updateBatchLine(data) {
    return this.post('/v1/payout-platform/batch/line/update', { data });
  }

  async cancelBatchLineMarkForEdit(data) {
    return this.post('/v1/payout-platform/batch/line/cancel-mark-for-edit', { data });
  }

  async requestBatchApprovalOtp(data) {
    return this.post('/v1/payout-platform/batch/otp/request', { data });
  }

  async approveBatch(data) {
    return this.post('/v1/payout-platform/batch/approve', { data });
  }

  async compareBatchWithHistorical(data) {
    return this.post('/v1/payout-platform/batch/compare-with-historical', { data });
  }

  async listPayrollPayRuns(params = {}) {
    const response = await this.listPayrollPayRunsResponse(params);
    await expect(response, 'payroll pay run list').toBeOK();
    return response.json();
  }

  async listPayrollPayRunsResponse(params = {}) {
    return this.get('/v1/payout-platform/payroll-import/pay-run-list', { params });
  }

  async loadPayrollRunIntoDraftBatch(data) {
    return this.post('/v1/payout-platform/payroll-import/load-into-draft-batch', { data });
  }
}

module.exports = {
  PayoutApiClient,
};
