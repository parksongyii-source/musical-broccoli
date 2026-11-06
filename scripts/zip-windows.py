from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib,json
root=Path(__file__).resolve().parent.parent
distribution=root/'out/onhyu-win-x64'
version=json.loads((root/'package.json').read_text())['version']
output=root/f'downloads/onhyu-windows-x64-v{version}.zip'
guide='''온휴 Windows 실행판 __VERSION__

Windows 10/11 64비트용입니다. Node.js 설치나 명령어 입력이 필요 없습니다.

1. ZIP 파일의 압축을 모두 풉니다.
2. Onhyu.exe를 더블클릭합니다.
3. 자동으로 열린 브라우저에서 직원을 등록하면 됩니다.

처음에는 빈 직원 목록으로 시작합니다.
실행 중 작은 콘솔 창이 함께 열립니다. 이 창은 실행 중인 프로그램의 일부입니다.
종료하려면 화면 아래 '프로그램 종료'를 누르거나 콘솔 창을 닫으세요.
브라우저 탭만 닫으면 프로그램은 계속 실행됩니다.
다시 더블클릭하면 기존 실행 중인 화면이 열리며, 종료 후 실행해도 자료가 유지됩니다.

직원과 휴가 자료는 이 PC의 %LOCALAPPDATA%\\Onhyu 폴더에 자동 저장됩니다.
백업하려면 프로그램을 종료한 뒤 이 폴더 전체를 복사하세요.
EXE 파일을 바꾸거나 다시 다운로드해도 이 데이터 폴더를 유지하면 자료는 남습니다.
가상 직원 자료나 기존 회사 자료는 이 배포 파일에 포함하지 않았습니다.

입사일을 입력하면 조회 기준일까지 발생한 연차가 자동 계산됩니다.
- 1년 미만: 개근한 것으로 가정한 완료 근무 월마다 1일, 최대 11일
- 1년 이상: 15일, 3년 근속부터 2년마다 1일 가산, 최대 25일
- 입사 기념일부터 다음 기념일 전날까지를 한 연차 기간으로 관리
개근 및 연간 출근율 80% 요건을 충족한 경우의 일반 기준입니다.
근태 예외나 회사 규정은 직원 수정의 '직접 설정'으로 조정할 수 있습니다.
공휴일 자동 제외·기간 간 자동 이월은 포함하지 않습니다.
관리자 혼자 PC에서 사용하는 버전이며 직원용 로그인 기능은 없습니다.

업데이트할 때는 기존 프로그램을 먼저 종료한 뒤 새 Onhyu.exe를 실행하세요.
기존 직원은 자동 계산으로 전환되며, 직원·휴가 기록은 보존됩니다.
과거 직접 입력한 일수도 보존되어 직접 설정 모드에서 다시 사용할 수 있습니다.
이전 데이터베이스 형식을 처음 갱신할 때 변경 전 SQLite 백업이 같은 자료 폴더에 생성됩니다.

전자서명이 없는 초기 버전입니다.
프로그램에 포함된 Node 및 제삼자 소프트웨어의 라이선스는 동봉된 문서를 참고하세요.
'''.replace('__VERSION__',version)
files=['Onhyu.exe','NODE-LICENSE.txt','THIRD-PARTY-NOTICES.txt','build-info.json']
meta=json.loads((distribution/'build-info.json').read_text())
assert meta['target']=='win-x64' and meta['version']==version
assert hashlib.sha256((distribution/'Onhyu.exe').read_bytes()).hexdigest()==meta['applicationSHA256']
assert (distribution/'Onhyu.exe').read_bytes()[:2]==b'MZ'
output.parent.mkdir(exist_ok=True)
with ZipFile(output,'w',ZIP_DEFLATED,compresslevel=9) as z:
 for name in files:z.write(distribution/name,'onhyu-windows/'+name)
 z.writestr('onhyu-windows/처음사용.txt',guide)
with ZipFile(output) as z:
 assert z.testzip() is None
 assert len(z.namelist())==5
 assert hashlib.sha256(z.read('onhyu-windows/Onhyu.exe')).hexdigest()==meta['applicationSHA256']
print(json.dumps({'file':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'archiveIntegrity':'passed','windowsExeSHA256':meta['applicationSHA256']},ensure_ascii=False))
