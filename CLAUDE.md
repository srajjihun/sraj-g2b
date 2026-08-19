# 나라장터 입찰 레이더

주식회사 인트윈의 입찰·영업 정보시스템입니다. 조달청 OpenAPI 로 나라장터
입찰공고를 모아, 공고문을 직접 읽어 참가자격을 따지고 심사표로 자가채점합니다.

**모집·신청 레이더는 다른 저장소입니다** (`srajjihun/sraj`). 한 폴더에 같이 있던
것을 2026-08 에 갈랐습니다. 그쪽 파일은 여기 없고, 여기서 그쪽을 건드리지도
않습니다. 두 시스템은 서로의 코드를 부르지 않습니다.

## 손대기 전에 알아야 할 것

- **.bat 파일은 100% ASCII 로 유지합니다.** 주석에도 한글을 넣지 않습니다.
  cmd.exe 는 .bat 을 덩어리로 읽으면서 이어 읽을 위치를 *바이트 오프셋*으로
  기억하는데, `chcp 65001` 에서 여러 바이트 글자가 덩어리 경계에 걸리면
  오프셋이 어긋나 다음 줄을 글자 중간부터 읽습니다(`'로' is not recognized`).
  한글 안내문은 전부 `scripts/g2b/say.mjs` 가 출력합니다.
  한글 *파일 이름*은 괜찮습니다 — 한글 이름 .bat 은 ASCII 이름 .bat 을
  한 줄로 부르기만 합니다(`코드받기.bat` → `getcode.bat`).
- **바깥 라이브러리를 쓰지 않습니다.** node 기본 기능만 씁니다. HWP·HWPX·
  DOCX·PDF·ZIP·CFB 읽기와 DOCX 쓰기를 형식 문서만 보고 직접 만들었습니다.
- **고치면 `node scripts/g2b/selftest.mjs` 를 돌립니다.** 66개 점검이 있습니다.
- **이 저장소는 공개입니다.** `config/실적DB.md`(사업명·발주기관·계약금액)와
  `config/회사정보.md` 가 인터넷에 보입니다 — 사용자가 알고 정한 것입니다.
- `data/g2b/` 와 `g2b-live.html` 은 gitignore 입니다. PC 에만 있습니다.

## 구조

```
수집    scripts/g2b/collect.mjs      API -> data/g2b/raw/ (원본 전부 보관)
분류    scripts/g2b/lib/keywords.mjs config/g2b-keywords.md 의 규칙으로 판정
        scripts/g2b/reclassify.mjs   재수집 없이 과거분에 새 규칙 소급
공고문  scripts/g2b/docs.mjs         첨부파일을 받아 읽습니다
        lib/hwp.mjs cfb.mjs hwpx.mjs docx.mjs pdf.mjs zip.mjs
판정    lib/require.mjs              참가자격·심사표를 뽑아냅니다
        lib/selfscore.mjs            정량 항목만 자가채점
        lib/records.mjs              config/실적DB.md 를 건별로 셉니다
화면    g2b.html -> build-page.mjs -> g2b-live.html
```

키워드를 왜 그렇게 골랐는지는 `docs/키워드-기준.md` 에 있습니다.
설계 배경은 `docs/g2b-design.md` 입니다.
