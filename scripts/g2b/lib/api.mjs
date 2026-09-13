// 조달청 나라장터 OpenAPI 호출 공통 계층.
//
// 세 서비스를 같은 방식으로 부른다:
//   BID     입찰공고정보서비스        BidPublicInfoService
//   PRESPEC 사전규격정보서비스        HrcspSsstndrdInfoService
//   AWARD   낙찰정보서비스            ScsbidInfoService
//
// ── 인증키 ──
// 환경변수 G2B_SERVICE_KEY 로 받는다. 커밋하지 않는다.
//   set G2B_SERVICE_KEY=공공데이터포털_일반인증키

const HOSTS = {
  BID: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService",
  PRESPEC: "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService",
  AWARD: "https://apis.data.go.kr/1230000/as/ScsbidInfoService",
};

/* 공공데이터포털은 **서비스마다 활용신청을 따로** 받습니다.
   입찰공고를 신청해 뒀어도 낙찰정보는 따로 신청하지 않으면
   SERVICE_KEY_IS_NOT_REGISTERED_ERROR 가 납니다. 같은 인증키인데도 그렇습니다.

   예전에는 그 영문 오류를 로그에 그대로 흘렸습니다. 무슨 뜻인지, 무엇을 해야
   하는지 알 수가 없어서 "작년 수행업체 0건" 의 원인을 오래 못 찾았습니다.
   그래서 어느 서비스가 막힌 것인지 이름과 신청 주소까지 적어 줍니다. */
const SERVICE_INFO = {
  BID: { name: "입찰공고정보서비스" },
  PRESPEC: { name: "공공기관 사전규격정보서비스" },
  AWARD: { name: "낙찰정보서비스" },
};

/** 활용신청이 안 된 서비스일 때 사람이 읽고 바로 조치할 수 있는 안내. */
function notRegisteredMessage(service) {
  const info = SERVICE_INFO[service] ?? { name: service };
  return [
    `나라장터 "${info.name}" 는 아직 활용신청이 안 돼 있습니다.`,
    ``,
    `공공데이터포털은 서비스마다 신청을 따로 받습니다. 입찰공고가 되는데`,
    `이것만 안 되는 것은 인증키가 틀린 게 아니라 이 서비스를 신청하지`,
    `않았기 때문입니다.`,
    ``,
    `  1. https://www.data.go.kr 로그인`,
    `  2. "조달청_${info.name}" 검색`,
    `  3. [활용신청] 누르고 사유 적어 제출`,
    `  4. 보통 즉시 승인됩니다. 마이페이지 > 오픈API > 활용신청 현황에서 확인`,
    ``,
    `승인된 뒤 다시 실행해 주세요. 인증키는 지금 쓰는 것을 그대로 씁니다.`,
  ].join("\n");
}

// 개발계정은 오퍼레이션당 하루 1,000회 제한. 페이지당 100건이 안전선으로 확인됐다.
// (999/1000 은 "입력범위값 초과 에러(07)" 로 거부된다)
export const ROWS_PER_PAGE = 100;

const MAX_RETRY = 5;
const RETRY_BASE_MS = 3000;
const THROTTLE_MIN_MS = 150; // 평상시 호출 간격
const THROTTLE_MAX_MS = 3000; // 429를 계속 맞을 때까지 늘어나는 상한

// 나라장터는 순간 속도뿐 아니라 누적 호출량에도 429(Too Many Requests)를 낸다.
// 고정 간격으로는 장시간 수집에서 반드시 걸리므로, 429가 나면 간격을 늘리고
// 성공이 이어지면 서서히 줄이는 적응형 방식을 쓴다.
let throttleMs = THROTTLE_MIN_MS;
let okStreak = 0;
let lastCallAt = 0;
// 이번 실행에서 한 번이라도 성공했는지. 첫 호출부터 429면 순간 속도 문제일 수
// 없으므로(아직 아무것도 안 보냈다) 하루 호출 한도를 소진한 것으로 본다.
let everSucceeded = false;

function slowDown() {
  throttleMs = Math.min(THROTTLE_MAX_MS, Math.max(500, Math.round(throttleMs * 2)));
  okStreak = 0;
  return throttleMs;
}

function speedUpGradually() {
  okStreak += 1;
  // 연속 성공이 쌓이면 조금씩 원래 속도로 되돌린다.
  if (okStreak >= 20 && throttleMs > THROTTLE_MIN_MS) {
    throttleMs = Math.max(THROTTLE_MIN_MS, Math.round(throttleMs * 0.8));
    okStreak = 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 인증키에는 Encoding/Decoding 두 종류가 있고 섞어 쓰면
// SERVICE_KEY_IS_NOT_REGISTERED_ERROR 가 난다.
// 이미 %2B 같은 이스케이프가 있으면 Encoding 키이므로 그대로 쓴다.
function encodeKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

export function serviceKey() {
  const key = process.env.G2B_SERVICE_KEY?.trim();
  if (!key) {
    throw new Error(
      "인증키가 없습니다. 공공데이터포털 일반 인증키를 환경변수로 설정하세요:\n" +
        "  set G2B_SERVICE_KEY=여기에인증키"
    );
  }
  return key;
}

// "YYYYMMDDHHMM" — API가 요구하는 조회일시 형식
export function stamp(date, endOfDay = false) {
  const p = (n) => String(n).padStart(2, "0");
  const hhmm = endOfDay ? "2359" : "0000";
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${hhmm}`;
}

function buildUrl(service, operation, params) {
  // serviceKey 는 인코딩 상태를 직접 제어해야 해서 URLSearchParams 를 쓰지 않는다.
  const pairs = [`serviceKey=${encodeKey(serviceKey())}`, "type=json"];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    pairs.push(`${k}=${encodeURIComponent(v)}`);
  }
  return `${HOSTS[service]}/${operation}?${pairs.join("&")}`;
}

// 응답의 items 는 배열이거나 { item: [...] } 이거나 { item: {...} } 일 수 있다.
function extractItems(body) {
  const items = body?.items;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.item)) return items.item;
  if (items?.item) return [items.item];
  return [];
}

// 응답 본문을 해석해 { items, totalCount } 로 돌려준다.
// 오류는 세 가지 형태로 오므로 모두 처리한다.
export function parseResponse(text, label, service) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 인증 오류 등은 type=json 을 줘도 XML 로 돌아온다.
    throw new Error(`${label} 응답을 JSON으로 읽지 못했습니다: ${text.slice(0, 200)}`);
  }

  // ① 포털 게이트웨이 오류 (인증키 문제, 일일 트래픽 초과 등)
  const gw = json.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) {
    const code = String(gw.returnReasonCode ?? "").trim();
    const auth = String(gw.returnAuthMsg ?? "");
    // 30 = 등록되지 않은 서비스키, 20 = 서비스 접근거부(승인 대기·해지)
    if (/NOT_REGISTERED/i.test(auth) || code === "30" || /ACCESS_DENIED/i.test(auth) || code === "20") {
      const err = new Error(notRegisteredMessage(service));
      err.notRegistered = true;
      err.service = service;
      throw err;
    }
    // 22 = 일일 트래픽 초과
    if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(auth) || code === "22") {
      const err = new Error(
        `나라장터 하루 호출 한도를 다 썼습니다 (${SERVICE_INFO[service]?.name ?? service}).\n` +
        `자정이 지나면 풀립니다.`
      );
      err.dailyQuota = true;
      throw err;
    }
    throw new Error(`${label} 인증/게이트웨이 오류: ${gw.errMsg} (${auth})`);
  }

  // ② 나라장터 백엔드 오류 (입력범위값 초과 등)
  const nk = json["nkoneps.com.response.ResponseError"]?.header;
  if (nk) {
    const err = new Error(`${label} 나라장터 오류 ${nk.resultCode}: ${nk.resultMsg}`);
    // resultCode "07" = 입력범위값 초과. 과거로 갈수록 반복 발생하면 조회 가능 기간의
    // 한계에 도달했다는 뜻이므로, 호출부(collect.mjs)가 이 코드로 구분해 대응한다.
    err.g2bCode = nk.resultCode;
    throw err;
  }

  // ③ 정상 응답
  const header = json.response?.header ?? {};
  if (String(header.resultCode ?? "").trim() !== "00") {
    throw new Error(`${label} API 오류 ${header.resultCode}: ${header.resultMsg}`);
  }

  const body = json.response?.body ?? {};
  return {
    items: extractItems(body),
    totalCount: Number(body.totalCount) || 0,
  };
}

async function fetchOnce(url, label) {
  // 호출 간격을 둔다. 429를 맞으면 이 간격이 자동으로 늘어난다.
  const wait = lastCallAt + throttleMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; g2b-radar/1.0)" },
  });
  if (!res.ok) {
    const err = new Error(`${label} HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  everSucceeded = true;
  speedUpGradually();
  return res.text();
}

// 재시도할 가치가 있는 오류인지 판단한다.
// 429(속도 제한)와 5xx(서버 일시 장애)는 기다렸다 다시 하면 대개 성공한다.
// 네트워크 예외(fetch 자체 실패)도 마찬가지다.
function isTransient(err) {
  const s = err.httpStatus;
  if (s === 429 || (s >= 500 && s < 600)) return true;
  return s === undefined; // 네트워크 오류 등 HTTP 응답 자체가 없던 경우
}

// 한 페이지를 가져온다. 일시적 오류는 지수 백오프로 재시도하되,
// API가 명시적으로 돌려준 오류(인증·범위 초과 등)는 재시도해도 소용없으므로 즉시 던진다.
async function fetchPage(service, operation, params, label) {
  const url = buildUrl(service, operation, params);
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    let text;
    try {
      text = await fetchOnce(url, label);
    } catch (err) {
      lastErr = err;
      // 한 번도 성공하지 못한 채 429가 나면 하루 한도(개발계정 1,000회/일)를
      // 소진한 것이다. 한도는 자정에야 초기화되므로 재시도는 시간 낭비다.
      if (err.httpStatus === 429 && !everSucceeded) {
        err.dailyQuota = true;
        break;
      }
      if (!isTransient(err) || attempt === MAX_RETRY) break;
      // 429면 앞으로의 호출 간격 자체를 늘려 같은 상황이 반복되지 않게 한다.
      if (err.httpStatus === 429) {
        const now = slowDown();
        console.log(`  ${label}: 호출 속도 제한(429) — 간격을 ${now}ms로 늦추고 재시도합니다`);
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }
    return parseResponse(text, label, service); // 여기서 나는 오류는 재시도 대상이 아니다
  }
  throw lastErr;
}

/**
 * 오퍼레이션 하나를 끝까지 훑어 전체 항목을 돌려준다.
 *
 * @param {"BID"|"PRESPEC"|"AWARD"} service
 * @param {string} operation  오퍼레이션명
 * @param {object} params     serviceKey/type/pageNo/numOfRows 를 뺀 조회 조건
 * @param {object} [opts]
 * @param {number} [opts.maxPages]  안전장치 (기본 200페이지 = 2만건)
 * @param {string} [opts.label]     로그에 쓸 이름
 * @param {(fetched:number,total:number)=>void} [opts.onPage]
 */
export async function fetchAll(service, operation, params, opts = {}) {
  const { maxPages = 200, label = operation, onPage } = opts;
  const collected = [];

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const { items, totalCount } = await fetchPage(
      service,
      operation,
      { ...params, pageNo, numOfRows: ROWS_PER_PAGE },
      `${label} p${pageNo}`
    );
    if (!items.length) break;
    collected.push(...items);
    onPage?.(collected.length, totalCount);
    if (collected.length >= totalCount) break;
    if (pageNo === maxPages) {
      // 조용히 잘리면 "전부 받았다"고 착각하게 되므로 반드시 알린다.
      console.warn(`[경고] ${label}: ${maxPages}페이지 상한에 걸려 ${totalCount}건 중 ${collected.length}건만 받았습니다`);
    }
  }

  return collected;
}

export { HOSTS, extractItems };
