export type ImportEmployee = {
  name: string;
  department: string;
  position: string;
  joinDate: string;
};

export type ParsedEmployee = {
  employee: ImportEmployee;
  sourceRow: number;
};

type RecordRow = { cells: string[]; sourceRow: number };
type EmployeeColumn = keyof ImportEmployee;

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EMPLOYEES = 500;
const aliases: Record<string, EmployeeColumn> = {
  이름: 'name',
  성명: 'name',
  name: 'name',
  부서: 'department',
  부서명: 'department',
  department: 'department',
  직책: 'position',
  직위: 'position',
  position: 'position',
  입사일: 'joinDate',
  입사일자: 'joinDate',
  joindate: 'joinDate',
};

function headerName(value: string): EmployeeColumn | undefined {
  const normalized = value.trim().replace(/[\s_]/g, '').toLowerCase();
  return Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
}

// Excel copies cells with tabs; a tab inside a quoted CSV value must not change
// the file's delimiter. Inspect only the first nonblank logical record.
function delimiterOf(text: string): ',' | '\t' {
  let quoted = false;
  let hasTab = false;
  let hasContent = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      hasContent = true;
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (hasContent) return hasTab ? '\t' : ',';
      hasTab = false;
      if (character === '\r' && text[index + 1] === '\n') index++;
    } else {
      if (!quoted && character === '\t') hasTab = true;
      if (character.trim()) hasContent = true;
    }
  }
  return hasTab ? '\t' : ',';
}

function parseRecords(text: string, delimiter: ',' | '\t'): RecordRow[] {
  const records: RecordRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let physicalLine = 1;
  let recordLine = 1;

  function finishField() {
    cells.push(field.trim());
    field = '';
    afterQuote = false;
  }
  function finishRecord() {
    finishField();
    if (cells.some(value => value !== '')) records.push({ cells, sourceRow: recordLine });
    cells = [];
  }

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const newline = character === '\n' || character === '\r';
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { inQuotes = false; afterQuote = true; }
      } else if (newline) {
        field += '\n';
        if (character === '\r' && text[index + 1] === '\n') index++;
        physicalLine++;
      } else field += character;
      continue;
    }
    if (character === delimiter) {
      finishField();
    } else if (newline) {
      finishRecord();
      if (character === '\r' && text[index + 1] === '\n') index++;
      physicalLine++;
      recordLine = physicalLine;
    } else if (afterQuote) {
      if (character.trim()) throw new Error(`${physicalLine}행: 닫는 따옴표 뒤에는 구분자나 줄바꿈만 올 수 있습니다.`);
    } else if (character === '"') {
      if (field.trim()) throw new Error(`${physicalLine}행: 따옴표가 있는 셀은 셀 전체를 큰따옴표로 감싸 주세요.`);
      field = '';
      inQuotes = true;
    } else field += character;
  }
  if (inQuotes) throw new Error(`${recordLine}행: 큰따옴표가 닫히지 않았습니다.`);
  finishRecord();
  return records;
}

/** Parse a spreadsheet clipboard selection (TSV) or an Excel-compatible CSV. */
export function parseEmployeeText(input: string): ParsedEmployee[] {
  if (typeof input !== 'string') throw new Error('직원 목록을 텍스트로 입력해 주세요.');
  if (new TextEncoder().encode(input).byteLength > MAX_BYTES) throw new Error('목록은 2MB 이하로 입력해 주세요.');
  const text = input.replace(/^\uFEFF/, '');
  const records = parseRecords(text, delimiterOf(text));
  if (!records.length) throw new Error('직원 목록을 붙여넣거나 CSV 파일을 선택해 주세요.');

  const first = records[0];
  const headers = first.cells.map(headerName);
  const hasHeader = headers.some(Boolean);
  let columns: (EmployeeColumn | undefined)[];
  let data: RecordRow[];
  if (hasHeader) {
    if (!headers.includes('name') || !headers.includes('joinDate')) {
      throw new Error('첫 행 제목에 이름(또는 성명)과 입사일(또는 입사일자)이 모두 필요합니다.');
    }
    const recognized = headers.filter((value): value is EmployeeColumn => Boolean(value));
    if (new Set(recognized).size !== recognized.length) throw new Error('첫 행 제목에 같은 항목이 두 번 들어 있습니다. 이름·부서·직책·입사일을 한 번씩만 사용해 주세요.');
    columns = headers;
    data = records.slice(1);
  } else {
    if (first.cells.length === 2) columns = ['name', 'joinDate'];
    else if (first.cells.length === 3) columns = ['name', 'department', 'joinDate'];
    else if (first.cells.length === 4) columns = ['name', 'department', 'position', 'joinDate'];
    else throw new Error('제목 없는 목록은 이름·입사일 2열, 이름·부서·입사일 3열 또는 이름·부서·직책·입사일 4열로 입력해 주세요.');
    data = records;
  }
  if (!data.length) throw new Error('제목 아래에 등록할 직원 정보를 입력해 주세요.');
  if (data.length > MAX_EMPLOYEES) throw new Error('한 번에 최대 500명까지 등록할 수 있습니다. 목록을 나누어 입력해 주세요.');

  return data.map(record => {
    if (!hasHeader && record.cells.length !== columns.length) {
      throw new Error(`${record.sourceRow}행: 열 개수가 첫 직원과 다릅니다. 빠진 셀이나 추가 구분자를 확인해 주세요.`);
    }
    if (hasHeader && record.cells.length > columns.length && record.cells.slice(columns.length).some(Boolean)) {
      throw new Error(`${record.sourceRow}행: 제목보다 많은 열이 있습니다. 따옴표나 구분자를 확인해 주세요.`);
    }
    const employee: ImportEmployee = { name: '', department: '', position: '', joinDate: '' };
    columns.forEach((column, index) => { if (column) employee[column] = record.cells[index] ?? ''; });
    return { employee, sourceRow: record.sourceRow };
  });
}

/** Prefer Unicode CSV; legacy Korean Excel exports commonly use CP949/EUC-KR. */
export function decodeEmployeeFile(buffer: ArrayBuffer): string {
  if (buffer.byteLength > MAX_BYTES) throw new Error('CSV 파일은 2MB 이하로 선택해 주세요.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('euc-kr', { fatal: true }).decode(buffer); }
    catch { throw new Error('파일의 한글 인코딩을 읽을 수 없습니다. 엑셀에서 CSV UTF-8 형식으로 저장한 뒤 다시 선택해 주세요.'); }
  }
}

export const templateCSV = '\uFEFF이름,부서,직책,입사일\r\n';
