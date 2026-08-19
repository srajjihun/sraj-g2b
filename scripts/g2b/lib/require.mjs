// 공고문 본문에서 "참가 자격"과 "배점표"를 뽑습니다.
//
// 목록 API 는 "지역제한 있음(Y)" 까지만 알려주고 어느 지역인지는 안 줍니다.
// 그 내용은 공고문 안에만 있습니다. 실측 예:
//
//   가. …공고일 전일부터 계약 체결일까지 본점의 소재지를 부산광역시로 하며…
//   나. …기타자유업(행사대행업, 업종코드 9901)으로 등록을 필한 업체
//
// 원칙: 못 찾으면 못 찾았다고 합니다. 추정하지 않습니다.
//       찾은 것에는 반드시 원문 한 줄(evidence)을 붙입니다.
//       근거 없는 숫자는 시스템 전체의 신뢰를 무너뜨립니다.

const SIDO = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
  "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "강원도",
  "충청북도", "충청남도", "전북특별자치도", "전라북도", "전라남도",
  "경상북도", "경상남도", "제주특별자치도",
];

/** 문장 단위로 자릅니다. 근거로 보여줄 때 너무 길지 않게. */
function lines(text) {
  return String(text ?? "")
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 지역제한 — 본점 소재지를 어디로 요구하는가 */
function findRegion(ls) {
  for (const l of ls) {
    if (!/소재지|본점|주된 영업소|사업자등록/.test(l)) continue;
    const hit = SIDO.find((s) => l.includes(s));
    if (!hit) continue;
    // "부산광역시 소재 업체" 처럼 제한을 거는 문장인지 확인합니다.
    if (!/제한|로 하[며는]|소재|둔 자|둔 업체|등록.*업체|한정/.test(l)) continue;
    return { value: hit, evidence: clip(l) };
  }
  return null;
}

/**
 * 업종·면허 — 업종코드가 있으면 그것까지.
 *
 * 모든 공고에 똑같이 붙는 상투 문구는 걸러야 합니다. 실측 오탐:
 *   "국가종합전자조달시스템 입찰참가자격등록규정에 의하여 반드시 나라장터
 *    시스템에 입찰일 전일까지 입찰참가 등록을 필한 자"
 * 이건 업종 제한이 아니라 나라장터를 쓰라는 안내입니다. 그런데 "등록을 필한"
 * 이 걸려서 업종 요건으로 잡혔고, 카드에 140자짜리 문장이 붙었습니다.
 */
const NOT_INDUSTRY = /입찰참가자격등록|전자조달시스템|국가종합전자조달|나라장터\s*시스템|공동인증서|지문인식|청렴계약|부정당업자/;

function findIndustry(ls) {
  const out = [];
  const seen = new Set();
  const add = (value, evidence) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, evidence: clip(evidence) });
  };

  for (const l of ls) {
    if (NOT_INDUSTRY.test(l)) continue;

    // "기타자유업(행사대행업, 업종코드 9901)" / "업종코드: 9901"
    const code = /업종\s*코드\s*[:：]?\s*(\d{3,5})/.exec(l);
    if (code) {
      const name = /([가-힣]{2,12}업)\s*[,，(（]?\s*업종\s*코드/.exec(l);
      add(name ? `${name[1]}(${code[1]})` : `업종코드 ${code[1]}`, l);
      continue;
    }

    // "[창업기획자(6883)] 업종을 등록한 업체"
    const bracket = /([가-힣]{2,12})\s*[(（]\s*(\d{3,5})\s*[)）]\s*\]?\s*업종/.exec(l);
    if (bracket) {
      add(`${bracket[1]}(${bracket[2]})`, l);
      continue;
    }

    // 코드가 없는 경우. 문장을 통째로 담지 않고 "○○업" 한 낱말만 뽑습니다 —
    // 카드에 붙는 값이라 길면 읽을 수가 없고, 회사 보유 업종과 대조도 안 됩니다.
    if (!/(등록|면허|신고)를?을?\s*(필한|받은|한)/.test(l)) continue;
    const word = /([가-힣]{2,12}(?:업|업자|공사업|서비스업))\s*(?:등록|면허|신고|을|를|으로|로)/.exec(l);
    if (word) add(word[1], l);
  }
  // 같은 내용이 여러 번 나오므로 앞의 둘만 씁니다.
  return out.slice(0, 2);
}

/** 금액 표기를 숫자로. "5천만원" "50,000,000원" "1억5천만원" */
export function parseWon(s) {
  const t = String(s ?? "").replace(/[\s,]/g, "");
  let total = 0;
  let matched = false;
  const eok = /([\d.]+)억/.exec(t);
  if (eok) { total += Number(eok[1]) * 1e8; matched = true; }
  const chun = /([\d.]+)천만/.exec(t);
  if (chun) { total += Number(chun[1]) * 1e7; matched = true; }
  const baek = /([\d.]+)백만/.exec(t);
  if (baek) { total += Number(baek[1]) * 1e6; matched = true; }
  if (matched) return Math.round(total);
  const plain = /(\d{6,})원/.exec(t);
  return plain ? Number(plain[1]) : null;
}

/** 실적 요건 — "최근 3년 이내 유사용역 5천만원 이상" */
function findRecord(ls) {
  for (const l of ls) {
    if (!/실적/.test(l)) continue;
    if (!/이상|충족|보유|증명/.test(l)) continue;
    const years = /최근\s*(\d+)\s*년/.exec(l);
    const amount = parseWon(l);
    if (!years && amount === null) continue;
    return {
      years: years ? Number(years[1]) : null,
      amount,
      evidence: clip(l),
    };
  }
  return null;
}

/**
 * 기술:가격 배점 — 본문에 글로 적혀 있는 경우.
 *
 * 한 줄에 안 들어갑니다. 실측 예(두 줄에 걸침):
 *   ※ … 배점은 기술능력평가
 *     90 점 (정량적 평가 20, 정성적 평가 70 점 ), 입찰가격평가 10 점임
 * 그래서 두 줄씩 붙여 보고, 기술과 가격을 따로 찾은 뒤 합이 100 근처인지 확인합니다.
 * (그 사이 괄호 안에도 숫자가 있어서 "가까이 붙은 숫자" 규칙으로는 잘못 잡힙니다)
 */
function findRateLine(ls) {
  for (let i = 0; i < ls.length; i += 1) {
    const win = [ls[i], ls[i + 1] ?? ""].join(" ");
    const t = /기술(?:능력)?평가\s*([\d.]+)\s*점/.exec(win);
    const p = /(?:입찰)?가격평가\s*([\d.]+)\s*점/.exec(win);
    if (!t || !p) continue;
    const tech = Number(t[1]);
    const price = Number(p[1]);
    if (!Number.isFinite(tech) || !Number.isFinite(price)) continue;
    if (Math.abs(tech + price - 100) > 2) continue; // 합이 100 이 아니면 배점 문장이 아닙니다
    const detail = {};
    const q = /정량(?:적)?\s*평가\s*([\d.]+)/.exec(win);
    const s = /정성(?:적)?\s*평가\s*([\d.]+)/.exec(win);
    if (q) detail.정량 = Number(q[1]);
    if (s) detail.정성 = Number(s[1]);
    return { tech, price, detail, evidence: clip(win, 170) };
  }
  return null;
}


/* ───────── 심사표(배점표) 항목 읽기 ─────────
   자가채점을 하려면 "이 항목이 무엇을 보는 항목인가"를 알아야 합니다.
   정성평가(사업이해도·제안내용)는 제안서를 써봐야 아는 것이라 지금은 채점할 수
   없고, 가격평가는 우리가 얼마를 쓰느냐에 달린 것이라 공고끼리 비교할 값이
   아닙니다. 그래서 항목을 갈라 두고 채점 가능한 것만 씁니다. */
/* 목록의 순서가 곧 우선순위입니다(먼저 걸리는 것이 이깁니다).
   처음에는 "실적"이 맨 위에 있었는데, 그러면 넓은 낱말이 좁은 항목을 통째로
   삼킵니다. 실제로 이렇게 틀렸습니다:
     "참여인력 구성" + 세부기준 "참여인력의 동종 용역 수행실적…" → 실적으로 분류
     "경영상태"     + 세부기준 "최근 3년 경영실적 반영"          → 실적으로 분류
   그러면 채점할 수 없는 항목(인력·경영)에 회사 실적으로 점수가 매겨집니다.
   근거 없는 숫자를 지어내는 것이라, 이 시스템에서 제일 하면 안 되는 일입니다.
   그래서 좁고 분명한 것부터 놓고, 가장 넓은 "실적"을 맨 뒤로 뺐습니다.

   "가점·우대·인증"도 신인도 규칙에서 뺐습니다. 지역 항목에도 실적 항목에도
   붙는 말이라("지역업체 참여 가점"), 그것만으로는 신인도라고 볼 수 없습니다.
   신인도는 "신인도" 라는 말이나 실제 인증 이름으로만 판정합니다. */
const ITEM_KIND = [
  ["가격",   /가격|입찰\s?금액|견적/],
  // 기술능력 · 구현 가능성 처럼 "제안서를 읽고 매기는" 항목도 정성입니다.
  // 예전에는 여기 안 걸려 "기타"로 떨어졌고, 그러면 채점 못한 정량으로 세어져
  // "못 채점한 정량 25점" 같은 사실과 다른 말이 화면에 나왔습니다.
  // 바로 옆 "사업수행능력"은 넣지 않았습니다 — 그 이름은 경영·실적·인력을
  // 묶은 정량 표(PQ)의 제목으로도 쓰여서, 넣으면 정량이 통째로 사라집니다.
  ["정성",   /이해도|제안\s?내용|제안서|계획|적정성|창의|전략|방안|타당|우수성|충실|기대효과|아이디어|콘셉트|연출|기술\s?능력|기술\s?제안|구현|실현\s?가능성/],
  ["지역",   /지역\s?업체|관내\s?업체|지역\s?참여|지역\s?기여|본사\s?소재|소재지/],
  ["경영",   /경영\s?상태|재무|신용\s?평가|기업\s?신용|신용\s?등급|자본|부채/],
  ["인력",   /인력|조직|참여\s?기술|투입|전문가|인적/],
  ["신인도", /신인도|여성기업|장애인기업|사회적기업|사회적경제|벤처기업|이노비즈|메인비즈|직접생산|기업부설\s?연구소|ISO\s?\d{4,5}/],
  ["실적",   /실적|수행경험|유사용역|수행건수|납품실적/],
];

/* 항목 이름으로 먼저 판정하고, 이름만으로 못 정할 때만 세부기준을 봅니다.
   예전에는 이름과 세부기준을 붙여서 한꺼번에 봤는데, 그러면 이름이 분명한
   항목("경영상태")도 세부기준 문장 한 낱말("경영실적")에 끌려갑니다.
   이름은 그 항목이 무엇인지를 적은 것이고, 세부기준은 어떻게 채점하는지를
   적은 것이라 이름이 더 믿을 만합니다. */
function kindOf(name, detail = "") {
  for (const [kind, re] of ITEM_KIND) if (re.test(name)) return kind;
  if (detail) for (const [kind, re] of ITEM_KIND) if (re.test(detail)) return kind;
  return "기타";
}

/* 건수 등급. 금액 등급과 함께 실제 심사표에 자주 나옵니다.
     "최근 3년간 유사용역 3건 이상 10점, 2건 이상 8점, 1건 이상 6점"
   금액 조건이 앞에 붙는 경우도 있습니다("1억 이상 3건 이상 10점").
   금액 등급은 가장 큰 실적 한 건으로 판정하지만 건수 등급은 실적DB 를
   세어야 하므로, 둘을 따로 뽑아 둡니다. */
export function parseCountTiers(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out = [];
  for (const m of t.matchAll(/(\d{1,2})\s*건\s*(?:이상|초과)[^0-9]{0,12}?([\d.]+)\s*점?/g)) {
    const min = Number(m[1]);
    const score = Number(m[2]);
    if (!Number.isFinite(min) || !Number.isFinite(score)) continue;
    out.push({ min, score });
  }
  out.sort((a, b) => b.min - a.min);
  // 건수가 많을수록 점수가 높아야 등급표입니다.
  for (let i = 1; i < out.length; i += 1) if (out[i].score > out[i - 1].score) return [];
  return out.length >= 2 ? out : [];
}

/** "최근 3년" 처럼 기간이 적혀 있으면 그 햇수를. 없으면 null. */
export function parseYears(text) {
  const m = /최근\s*(\d)\s*년/.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}

/* 합계·소계 행은 배점 항목이 아닙니다.
   안 거르면 그 행이 항목으로 들어가 총점이 두세 배로 부풀고("채점 못한 정량
   125점" — 표 전체가 100점인데), 배점 합이 90~110 범위를 벗어나 표 자체를
   못 알아보기도 합니다. 같은 저장소의 credits.mjs 도 이미 같은 낱말을
   걸러내고 있습니다 — 실제 공고문에 이런 행이 들어온다는 뜻입니다. */
const SUMMARY_ROW = /^\s*(합\s*계|소\s*계|총\s*계|중\s*계|계|총\s*점|비\s*고)\s*$/;
/* 이름은 상위 칸까지 붙여 만듭니다("정량적 평가 / 소 계"). 그래서 전체가
   합계 낱말인지 보면 안 되고, 가장 마지막(가장 구체적인) 칸으로 판정해야
   합니다. 처음에 every 로 검사했더니 소계 행이 그대로 새어 총점이 145가
   됐습니다(표는 100점). */
const isSummaryRow = (name) => {
  const parts = String(name ?? "").split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return SUMMARY_ROW.test(parts[parts.length - 1]);
};

/* 세부 배점 기준에서 등급을 뽑습니다. 실측 표기:
     "최근 3년간 유사용역 5억원 이상 10점, 3억원 이상 8점, 1억원 이상 6점"
     "10억 이상: 20 / 5억 이상: 16 / 3억 이상: 12"
   금액과 점수가 짝지어 나오면 그 짝을 등급으로 봅니다. 짝이 안 맞으면
   등급을 못 읽은 것으로 두고 일반 규칙으로 채점합니다 — 억지로 맞추면
   근거 없는 점수가 됩니다. */
export function parseTiers(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out = [];
  const re = /([\d.,]+\s*(?:억|천만|백만|만)?\s*원?)\s*(?:이상|초과)[^0-9]{0,12}?([\d.]+)\s*점?/g;
  let m;
  while ((m = re.exec(t))) {
    const min = parseWon(m[1]);
    const score = Number(m[2]);
    if (min === null || !Number.isFinite(score)) continue;
    out.push({ min, score });
  }
  // 큰 금액이 높은 점수여야 등급표입니다. 아니면 잘못 읽은 것입니다.
  out.sort((a, b) => b.min - a.min);
  for (let i = 1; i < out.length; i += 1) if (out[i].score > out[i - 1].score) return [];
  return out.length >= 2 ? out : [];
}

/**
 * 배점표 — 표에서 찾습니다.
 * "평가항목 / 배점" 처럼 숫자 열이 있는 표를 배점표로 봅니다.
 * 배점 합이 100 근처면 신뢰도가 높습니다.
 */
function findScoreTable(tables) {
  let best = null;
  for (const t of tables ?? []) {
    const grid = t.grid ?? t.rows;
    if (!grid || grid.length < 2) continue;
    const width = Math.max(...grid.map((r) => r.length));
    if (width < 2) continue;

    // 배점처럼 보이는 열을 찾습니다 — 숫자만 든 칸이 많은 열
    for (let c = 1; c < width; c += 1) {
      // 합계·소계 행은 배점에서도 항목에서도 뺍니다(총점이 부풀지 않도록).
      const rows = grid.slice(1).map((r) => {
        const name = (r.slice(0, c).filter(Boolean).join(" / ") || "").trim();
        const v = (r[c] ?? "").trim();
        const score = /^\d{1,3}(\.\d+)?$/.test(v) ? Number(v) : null;
        return { r, name, score, summary: isSummaryRow(name) };
      });
      const scored = rows.filter((x) => x.score !== null && !x.summary);
      if (scored.length < 2) continue;
      const sum = scored.reduce((a, x) => a + x.score, 0);
      const header = (grid[0][c] ?? "").trim();
      const looksLikeScore = /배점|점수|평점|가중치/.test(header) || (sum >= 90 && sum <= 110);
      if (!looksLikeScore) continue;

      const items = scored
        .map(({ r, name, score }) => {
          // 세부 배점 기준은 보통 배점 열 뒤에, 없으면 항목 이름 칸에 같이 적힙니다.
          const detail = [...r.slice(c + 1), name].filter(Boolean).join(" ").trim();
          const tiers = parseTiers(detail);
          return {
            name, score, kind: kindOf(name, detail), tiers,
            countTiers: parseCountTiers(detail),
            // 건수 등급에 "1억 이상 3건" 처럼 금액 문턱이 같이 붙는 경우
            countAmount: tiers.length ? null : parseWon(detail),
            years: parseYears(detail),
          };
        })
        .filter((x) => x.name);
      if (!items.length) continue;

      const cand = { items, total: sum, column: header || "배점", rows: grid };
      // 합이 100 에 가까운 쪽을 고릅니다.
      if (!best || Math.abs(sum - 100) < Math.abs(best.total - 100)) best = cand;
    }
  }
  return best;
}

// 신인도 가점으로 쓰이는 인증들.
// "인증서류 뭐가 더 필요해?"에 추측 대신 실제 공고문 빈도로 답하기 위한
// 목록입니다. 공고문을 여러 건 읽으면 어떤 인증이 몇 번 나왔는지 쌓입니다.
//
// 이름 하나에 여러 표기를 묶습니다. 예전에는 "ISO9001" 과 "ISO 9001" 을
// 따로 세어서 같은 인증이 둘로 갈라졌습니다. 대표 이름으로 모읍니다.
const CREDIT_TERMS = [
  { term: "직접생산확인", re: /직접생산확인/ },
  { term: "벤처기업", re: /벤처기업/ },
  { term: "여성기업", re: /여성기업/ },
  { term: "장애인기업", re: /장애인기업/ },
  { term: "중증장애인생산품", re: /중증장애인\s?생산(품|시설)/ },
  { term: "사회적기업", re: /사회적기업/ },
  { term: "사회적경제기업", re: /사회적경제\s?기업/ },
  { term: "사회적협동조합", re: /사회적\s?협동조합/ },
  { term: "마을기업", re: /마을기업/ },
  { term: "자활기업", re: /자활기업/ },
  { term: "이노비즈", re: /이노비즈|INNO-?BIZ/i },
  { term: "메인비즈", re: /메인비즈|MAIN-?BIZ/i },
  // "중소기업" 안의 "소기업" 이 걸려 거의 모든 공고가 소기업 가점으로
  // 잡혔습니다(실측: 20건 중 11건). 앞 글자가 "중" 이면 제외합니다.
  { term: "소기업", re: /(?<!중)소기업/ },
  { term: "소상공인", re: /소상공인\s?확인/ },
  { term: "가족친화인증", re: /가족친화/ },
  { term: "고용우수기업", re: /고용우수기업|고용창출\s?우수/ },
  { term: "청년친화강소기업", re: /청년친화\s?강소기업/ },
  { term: "노사문화우수기업", re: /노사문화\s?우수/ },
  { term: "기업부설연구소", re: /기업부설\s?연구소/ },
  { term: "지식재산경영인증", re: /지식재산경영\s?인증/ },
  { term: "우수조달물품", re: /우수조달\s?(물품|기업)/ },
  { term: "성과공유기업", re: /성과공유\s?기업/ },
  { term: "ISO9001", re: /ISO\s?9001/i },
  { term: "ISO14001", re: /ISO\s?14001/i },
  { term: "ISO27001", re: /ISO\s?27001|정보보호\s?경영/i },
  { term: "ISO45001", re: /ISO\s?45001|안전보건\s?경영/i },
];


/* 직접생산확인 "품목" 뽑기.
   직접생산확인은 회사 단위가 아니라 품목 단위로 받습니다. 그래서 공고가
   요구하는 품목 이름을 알아야 우리가 실제로 들어갈 수 있는지 판단됩니다.

   자유롭게 찾으면 양쪽으로 틀립니다. 붙여쓴 덩어리만 찾으면
   「행사기획 및 대행서비스」에서 앞이 잘려 "대행서비스"가 되고, 공백을
   허용하면 "본 용역은 축제기획및…"처럼 앞 낱말까지 삼킵니다.
   그래서 품목 이름에 실제로 쓰이는 낱말만 목록으로 두고 "서비스"에서
   거꾸로 훑습니다. 목록에 없는 낱말을 만나면 멈춥니다.
   목록에 없는 품목은 못 찾겠지만, 없는 것을 지어내지는 않습니다. */
const ITEM_PARTS = [
  "전시홍보관", "기타행사", "국제행사", "전시부스", "동영상", "박람회", "전시회",
  "홍보관", "이벤트", "시상식", "디자인", "마케팅", "축제", "행사", "회의", "전시",
  "국제", "기타", "부스", "설치", "제작", "광고", "인쇄", "운영", "공연", "대행",
  "기획", "영상", "홍보", "및",
].sort((a, b) => b.length - a.length);

/* 품목 이름은 반드시 "무엇에 대한" 서비스인지로 시작합니다(축제·전시회·동영상…).
   앞이 잘리면 "및대행서비스" "기획및대행서비스" 같은 껍데기가 남는데, 이걸
   품목으로 세면 없는 품목이 있는 것처럼 보입니다(실측 5건·3건).
   첫 낱말이 주제어가 아니면 이름을 못 뽑은 것으로 처리합니다. */
const ITEM_TOPICS = new Set([
  "전시홍보관", "기타행사", "국제행사", "전시부스", "동영상", "박람회", "전시회",
  "홍보관", "이벤트", "시상식", "디자인", "마케팅", "축제", "행사", "회의", "전시",
  "국제", "기타", "부스", "광고", "공연", "영상", "홍보", "인쇄",
]);

/* 같은 품목을 "국제행사기획및대행서비스" 로도, "국제행사기획대행서비스" 로도
   씁니다. 그대로 두면 보유 품목인데 "없음"으로 잡힙니다(실측 2건·1건).
   비교할 때는 "및"과 띄어쓰기를 지운 형태를 씁니다. */
export const itemKey = (s) => String(s ?? "").replace(/[\s및]/g, "");

export function itemNames(line) {
  const out = [];
  let at = -1;
  while ((at = String(line).indexOf("서비스", at + 1)) >= 0) {
    const chunks = [];
    let end = at;
    for (let guard = 0; guard < 8; guard += 1) {
      let j = end;
      while (j > 0 && /\s/.test(line[j - 1])) j -= 1;
      const part = ITEM_PARTS.find((v) => j >= v.length && line.slice(j - v.length, j) === v);
      if (!part) break;
      chunks.unshift(part);
      end = j - part.length;
    }
    if (!chunks.length) continue;
    if (!ITEM_TOPICS.has(chunks[0])) continue;
    out.push(chunks.join("") + "서비스");
  }
  return [...new Set(out)];
}

/**
 * 공고문 전체에서 직접생산확인 품목을 모읍니다. 근거 줄을 같이 남깁니다.
 *
 * 같은 줄만 보면 안 됩니다. 실제 공고문은 이렇게 줄이 나뉩니다:
 *   가. 중소기업자간 경쟁제품에 해당하므로
 *   「축제기획 및 대행서비스」
 *   직접생산확인증명서를 보유한 업체에 한합니다.
 * 품목 이름과 "직접생산"이 다른 줄에 있어서, 한 줄만 보던 방식으로는
 * 153건 중 63건(41%)이 "이름 미상"으로 남았습니다.
 * 그래서 "직접생산"이 든 줄의 앞뒤 두 줄까지 함께 봅니다.
 */
const ITEM_WINDOW = 2;

function findDirectItems(ls) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < ls.length; i += 1) {
    if (!/직접생산/.test(ls[i])) continue;
    const from = Math.max(0, i - ITEM_WINDOW);
    const to = Math.min(ls.length - 1, i + ITEM_WINDOW);
    for (let j = from; j <= to; j += 1) {
      for (const name of itemNames(ls[j])) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, evidence: clip(ls[j] === ls[i] ? ls[i] : `${ls[j]} … ${ls[i]}`) });
      }
    }
  }
  return out;
}

/** 공고문에 언급된 신인도 가점 인증들. 근거 문장을 같이 남깁니다. */
function findCredits(ls) {
  const found = [];
  const seen = new Set();
  for (const l of ls) {
    for (const { term, re } of CREDIT_TERMS) {
      if (seen.has(term)) continue;
      if (re.test(l)) {
        found.push({ term, evidence: clip(l) });
        seen.add(term);
      }
    }
  }
  return found;
}

/**
 * 공고문 하나에서 뽑아낼 수 있는 것을 전부 뽑습니다.
 * @param {string} text   본문
 * @param {Array}  tables 표(HWPX 에서만 나옵니다)
 */
export function extractRequirements(text, tables) {
  const ls = lines(text);
  const region = findRegion(ls);
  const industry = findIndustry(ls);
  const record = findRecord(ls);
  const rate = findRateLine(ls);
  const scoreTable = findScoreTable(tables);
  const credits = findCredits(ls);
  const directItems = findDirectItems(ls);

  return {
    region,        // { value:"부산광역시", evidence } | null
    industry,      // [{ value, evidence }]
    record,        // { years, amount, evidence } | null
    rate,          // { tech, price, evidence } | null
    scoreTable,    // { items:[{name,score}], total } | null
    credits,       // [{ term, evidence }] — 언급된 신인도 인증
    directItems,   // [{ name, evidence }] — 직접생산확인 요구 품목
    found: {
      region: !!region,
      industry: industry.length > 0,
      record: !!record,
      score: !!scoreTable || !!rate,
    },
  };
}

/**
 * 회사 정보와 대조해 "들어갈 수 있는가"를 판정합니다.
 * 판정은 셋뿐입니다: 가능 / 불가 / 확인필요. 애매하면 확인필요입니다.
 */
export function judgeEligibility(req, company) {
  const checks = [];

  if (req.region) {
    if (!company?.region) {
      checks.push({ key: "지역", verdict: "확인필요", detail: `${req.region.value} 제한 · 우리 소재지 미입력`, evidence: req.region.evidence });
    } else {
      const ok = company.region.includes(req.region.value.slice(0, 2)) || req.region.value.includes(company.region.slice(0, 2));
      checks.push({
        key: "지역",
        verdict: ok ? "가능" : "불가",
        detail: `${req.region.value} 제한 · 우리 ${company.region}`,
        evidence: req.region.evidence,
      });
    }
  }

  for (const ind of req.industry) {
    const have = (company?.licenses ?? []).some((l) => ind.value.includes(l) || l.includes(ind.value.split("(")[0]));
    checks.push({
      key: "업종",
      verdict: have ? "가능" : (company?.licenses ?? []).length ? "불가" : "확인필요",
      detail: ind.value,
      evidence: ind.evidence,
    });
  }

  if (req.record?.amount) {
    if (!company?.maxRecord) {
      checks.push({ key: "실적", verdict: "확인필요", detail: `${Math.round(req.record.amount / 1e6)}백만원 이상 요구 · 우리 실적 미입력`, evidence: req.record.evidence });
    } else {
      const ok = company.maxRecord >= req.record.amount;
      checks.push({
        key: "실적",
        verdict: ok ? "가능" : "불가",
        detail: `${Math.round(req.record.amount / 1e6)}백만원 이상 요구 · 우리 최대 ${Math.round(company.maxRecord / 1e6)}백만원`,
        evidence: req.record.evidence,
      });
    }
  }

  const verdict = checks.some((c) => c.verdict === "불가")
    ? "불가"
    : checks.some((c) => c.verdict === "확인필요")
      ? "확인필요"
      : checks.length
        ? "가능"
        : "정보없음";

  return { verdict, checks };
}
