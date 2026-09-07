function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function uniquePayrollId(prefix = 'PAY-QA') {
  return `${prefix}-${uniqueSuffix()}`;
}

function uniqueSouthAfricanPhone() {
  return `2782${uniqueSuffix().slice(-7)}`;
}

function alphaSuffix(length = 6) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const seed = uniqueSuffix();
  let value = '';
  for (const char of seed) {
    value += alphabet[Number(char) % alphabet.length];
  }
  return value.padEnd(length, 'x').slice(0, length);
}

let currentEmployeeTestTitle = '';

function setCurrentEmployeeTestTitle(title) {
  currentEmployeeTestTitle = title || '';
}

function readableTestLabel(title = currentEmployeeTestTitle) {
  const sourceTitle = String(title);
  const semanticTitle = sourceTitle.includes(':')
    ? sourceTitle.split(':').slice(1).join(':')
    : sourceTitle.replace(/\b[A-Z]{2,}(?:-[A-Z]+)*(?:-\d+)+\b/g, ' ');
  const lowerSemanticTitle = semanticTitle.toLowerCase();
  if (lowerSemanticTitle.includes('allocates') && lowerSemanticTitle.includes('activates') && lowerSemanticTitle.includes('card')) {
    return 'card lifecycle random';
  }
  if (lowerSemanticTitle.includes('notification settings')) {
    return 'notification settings';
  }
  if (lowerSemanticTitle.includes('valid passport data') && lowerSemanticTitle.includes('phone')) {
    return 'draft passport phone';
  }
  if (lowerSemanticTitle.includes('without phone')) {
    return 'draft fake phone';
  }
  if (lowerSemanticTitle.includes('filters') && lowerSemanticTitle.includes('payroll')) {
    return 'search filters payroll';
  }
  if (lowerSemanticTitle.includes('audit history')) {
    return 'audit history';
  }
  if (lowerSemanticTitle.includes('verification info')) {
    return 'verification info';
  }
  if (lowerSemanticTitle.includes('documents collection')) {
    return 'documents collection';
  }
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'api',
    'as',
    'accepts',
    'by',
    'create',
    'creates',
    'current',
    'endpoint',
    'employee',
    'for',
    'from',
    'in',
    'is',
    'of',
    'or',
    'the',
    'to',
    'using',
    'with',
  ]);

  return semanticTitle
    .replace(/[^a-zA-Z ']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => !stopWords.has(word.toLowerCase()))
    .slice(0, 3)
    .join(' ');
}

function employeeNameForTest(kind = 'Passport', overrides = {}) {
  const label = readableTestLabel(overrides.testLabel);
  const suffix = alphaSuffix(5);
  const lastNameParts = [kind, label, suffix].filter(Boolean);

  return {
    firstName: overrides.firstName || 'Qa',
    lastName: overrides.lastName || lastNameParts.join(' ').slice(0, 36).trim(),
  };
}

function futureDate({ years = 5 } = {}) {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function pastDate({ years = 30 } = {}) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function validPassportEmployee(overrides = {}) {
  const suffix = uniqueSuffix();
  const passportNumber = overrides.passportNumber || `P${suffix.slice(-8)}`;
  const birthDate = overrides.birthDate || '1991-04-12';
  const name = employeeNameForTest('Passport', overrides);

  return {
    email: overrides.email || `qa.employee.${suffix}@example.test`,
    phone: overrides.phone,
    personal_data: {
      first_name: name.firstName,
      last_name: name.lastName,
      middle_name: overrides.middleName || '',
      birth_date: birthDate,
      payroll_id: overrides.payrollId || uniquePayrollId(),
      ...(overrides.personalData || {}),
    },
    identity_data: {
      passport_data: {
        passport_number: passportNumber,
        passport_country: overrides.passportCountry || 'ZAF',
        passport_issue_date: overrides.passportIssueDate || '2020-01-01',
        passport_expire_date: overrides.passportExpireDate || futureDate(),
        ...(overrides.passportData || {}),
      },
      ...(overrides.identityData || {}),
    },
  };
}

function validAsylumEmployee(overrides = {}) {
  const suffix = uniqueSuffix();
  const asylumNumber = overrides.asylumNumber || `ASY${suffix.slice(-8)}`;
  const name = employeeNameForTest('Asylum', overrides);

  return {
    email: overrides.email || `qa.asylum.${suffix}@example.test`,
    phone: overrides.phone,
    personal_data: {
      first_name: name.firstName,
      last_name: name.lastName,
      middle_name: overrides.middleName || '',
      birth_date: overrides.birthDate || '1992-07-22',
      payroll_id: overrides.payrollId || uniquePayrollId('ASY-QA'),
      ...(overrides.personalData || {}),
    },
    identity_data: {
      asylum_paper_data: {
        asylum_paper_number: asylumNumber,
        asylum_paper_country: overrides.asylumCountry || 'ZAF',
        asylum_paper_expire_date: overrides.asylumExpireDate || futureDate(),
        ...(overrides.asylumData || {}),
      },
      ...(overrides.identityData || {}),
    },
  };
}

function cloneWith(data, patch) {
  return {
    ...data,
    ...patch,
    personal_data: {
      ...(data.personal_data || {}),
      ...(patch.personal_data || {}),
    },
    identity_data: {
      ...(data.identity_data || {}),
      ...(patch.identity_data || {}),
    },
  };
}

function employeeUuidFromCreateResponse(body) {
  return body?.result?.employee?.customer_uuid
    || body?.result?.employee?.customer?.customer_uuid
    || body?.result?.employee?.profile?.customer_uuid;
}

function employeeFromResponse(body) {
  return body?.result?.employee;
}

function currentCardFromEmployee(employee) {
  return employee?.card || employee?.active_card || null;
}

function cardUuidFromEmployee(employee) {
  const card = currentCardFromEmployee(employee);
  return card?.card_uuid || card?.uuid;
}

function fakePngUpload(name = 'invalid-document.png') {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  };
}

function textUpload(name = 'not-an-image.txt') {
  return {
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a valid employee document', 'utf8'),
  };
}

function uniqueTrackingId() {
  return `TRK-QA-${uniqueSuffix()}`;
}

function uniqueActivationToken() {
  return `ACT-QA-${uniqueSuffix()}`;
}

module.exports = {
  cardUuidFromEmployee,
  cloneWith,
  currentCardFromEmployee,
  employeeFromResponse,
  employeeUuidFromCreateResponse,
  fakePngUpload,
  futureDate,
  employeeNameForTest,
  pastDate,
  setCurrentEmployeeTestTitle,
  textUpload,
  todayDate,
  tomorrowDate,
  uniqueActivationToken,
  alphaSuffix,
  uniquePayrollId,
  uniqueSouthAfricanPhone,
  uniqueTrackingId,
  validAsylumEmployee,
  validPassportEmployee,
};
