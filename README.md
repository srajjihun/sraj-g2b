# 나라장터 입찰 레이더

나라장터(조달청) 입찰공고를 매일 모아, 우리가 참여할 수 있는 공고를 골라내고
공고문의 심사표로 예상 점수를 매깁니다. 화면은 PC 에서 `g2b-live.html` 로 보거나,
Netlify 로 배포한 공개 URL 로 봅니다(아래 참고).

## 어떤 .bat 을 언제 누르나

| 파일 | 언제 |
|---|---|
| **G2B-설치.bat** | 처음 한 번. 코드를 받고 최근 30일치를 모읍니다 |
| **화면-새로고침.bat** | 평소에 이것만. 최신 코드를 받아 화면을 다시 만듭니다 (API 호출 없음) |
| **코드받기.bat** | 코드만 최신으로 (git 사용) |
| **자동수집-등록.bat** | 처음 한 번. 아침 자동 수집을 작업 스케줄러에 등록합니다 |
| 1년치-수집.bat | 과거 1년치를 채울 때 |
| 공고문-분석.bat | 공고 첨부파일을 읽어 자격·심사표를 뽑을 때 |
| 공고문-전체분석.bat | 위를 저장된 공고 전부에 |
| 키워드-검증.bat | 키워드 설정을 바꾸기 전후로 |
| 단어확인.bat | 단어 하나를 넣을지 말지 숫자로 볼 때 |
| 인증-리포트.bat | 어떤 인증·직접생산확인이 실제로 점수가 되는지 |
| 작년실적-수집.bat | 작년 낙찰정보(작년 수행업체) |

자동 수집은 작업 스케줄러가 `collect-silent.vbs` 를 불러 창 없이 돌립니다.

## 어디를 고치나

| 파일 | 무엇 |
|---|---|
| `config/g2b-keywords.md` | 어떤 공고를 우리 일로 볼지 (→ `docs/키워드-기준.md`) |
| `config/회사정보.md` | 소재지·규모·인증·직접생산확인 |
| `config/실적DB.md` | 수행실적 건별 기록 (자가채점의 근거) |

고친 뒤 **화면-새로고침.bat** 한 번이면 이미 모아둔 과거 공고 전부에
새 기준이 소급 적용됩니다. 다시 수집할 필요가 없습니다.

## Netlify 배포

`netlify.toml` 이 빌드를 정의합니다 — `build-page.mjs` 로 `g2b-live.html` 을
굽고 `public/index.html` 로 복사합니다. 나라장터 API 는 한국 IP 에서만
열리므로 Netlify 빌드 서버(해외)는 API 를 부르지 않고, PC 가 이미 만들어
커밋해 둔 `data/g2b/posts.json`(+ `docs.json`, `awards.json`)만 읽습니다.

연결하는 법 (한 번만):
1. https://app.netlify.com → **Add new site → Import an existing project**
2. GitHub → `srajjihun/sraj-g2b` 선택, 브랜치 `main`
3. Build command · Publish directory 는 `netlify.toml` 을 읽어 자동으로 채워집니다
   (직접 입력해야 하면 `node scripts/g2b/build-page.mjs && mkdir -p public && cp g2b-live.html public/index.html && cp netlify/robots.txt public/robots.txt` / `public`)
4. **Deploy site**

이후로는 PC 가 매일 아침 수집·분석하고 `collect-g2b.bat` 이 끝에
`data/g2b/posts.json` 등을 커밋·푸시합니다. Netlify 는 `main` 에 푸시가
올 때마다 저절로 다시 빌드합니다 — PC 가 켜져 있어야 화면이 갱신됩니다.

## 주의

이 저장소는 **공개**입니다. `config/실적DB.md` 의 사업명·발주기관·계약금액,
그리고 `data/g2b/posts.json` 등에 담긴 공고 목록·우리 자가채점 점수·경쟁사
분석이 전부 Netlify 공개 URL 로 나갑니다. 검색엔진 색인은 막아 뒀지만
(`robots.txt`, `<meta name="robots">`) 링크를 아는 사람은 누구나 볼 수 있습니다
— 2026-08 사용자 결정입니다.
