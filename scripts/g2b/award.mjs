// 작년 낙찰정보 수집기 — "이 사업, 작년엔 누가 얼마에 했나"를 채웁니다.
//
// 왜 따로 도는가:
//   낙찰정보(ScsbidInfoService)도 개발계정 하루 1,000회 제한이 걸립니다.
//   입찰공고 수집과 같은 한도를 쓰지는 않지만(오퍼레이션별 한도), 한 번에
//   1년치를 다 받기는 어려워 월 단위로 나눠 받고 진행 상태를 남깁니다.
//
// 무엇을 남기는가:
//   우리 6개 분야 키워드에 걸리는 건만 남깁니다. 분야 밖 사업의 낙찰업체는
//   볼 일이 없고, 다 남기면 파일만 커집니다.
//
// 사용법 (PC, 한국 IP 필요):
//   set G2B_SERVICE_KEY=공공데이터포털_일반인증키
//   node scripts\g2b\award.mjs             ← 작년 1월부터
//   node scripts\g2b\award.mjs 2024-01     ← 시작 월 지정
//   node scripts\g2b\award.mjs --reset     ← 진행 상태 초기화
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchAll } from "./lib/api.mjs";
import { normalizeAward } from "./lib/normalize.mjs";
import { loadKeywords, matchGroups, isExcluded } from "./lib/keywords.mjs";

const DATA_DIR = new URL("../../data/g2b/", import.meta.url);
const RAW_AWARD = new URL("raw/award.json", DATA_DIR);
const STATE = new URL("raw/award-state.json", DATA_DIR);
const OUT = new URL("awards.json", DATA_DIR);

// 낙찰목록현황 · 용역 (조달청 검색). 개찰결과가 확정된 건이 여기 들어옵니다.
const AWARD_OP = "getScsbidListSttusServcPPSSrch";

// 하루 한도에 여유를 두고 멈춥니다.
const CALL_BUDGET = 850;

let callsUsed = 0;

async function loadJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function saveJson(url, value) {
  await mkdir(new URL("./", url), { recursive: true });
  await writeFile(url, JSON.stringify(value) + "\n", "utf8");
}

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, "0");
  return { bgn: `${y}${p(m)}010000`, end: `${y}${p(m)}${p(last)}2359` };
}

// 시작 월부터 이번 달까지 (오래된 순)
function monthsFrom(startYm, now = new Date()) {
  const [sy, sm] = startYm.split("-").map(Number);
  const out = [];
  let y = sy;
  let m = sm;
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function isQuotaError(err) {
  return err?.dailyQuota === true || /LIMITED_NUMBER_OF_SERVICE_REQUESTS|트래픽|초과/i.test(err?.message ?? "");
}

/** 한 달치를 받아 store 에 누적합니다. 우리 분야에 걸리는 건만 남깁니다. */
async function collectMonth(ym, store, config) {
  const w = monthWindow(ym);
  let added = 0;
  let seen = 0;

  const items = await fetchAll("AWARD", AWARD_OP, {
    /* 3 = 개찰일시. 예전에는 1 을 쓰면서 주석에 "개찰일시" 라고 적어 뒀는데
       1 은 등록일시입니다(docs/g2b-design.md 3.3). 낙찰정보 등록은 개찰보다
       최대 8~9개월 늦으므로, 작년 1년치 백필을 등록일 기준으로 훑으면
       작년에 개찰된 건을 제대로 못 모읍니다. */
    inqryDiv: 3,
    inqryBgnDt: w.bgn,
    inqryEndDt: w.end,
  }, {
    label: `${ym} 낙찰`,
    maxPages: 400,
    onPage: () => { callsUsed += 1; },
  });

  // 낙찰정보는 오퍼레이션마다 필드 이름이 달라, 우리가 찾는 이름이 실제 응답에
  // 없으면 낙찰업체가 통째로 빈칸이 됩니다. 조용히 0건이 되면 원인을 못 찾으므로
  // 실제로 어떤 이름이 오는지 한 번 찍어 줍니다.
  if (items.length && !items.some((raw) => normalizeAward(raw).corp)) {
    console.log(`\n  [확인 필요] ${ym}: 낙찰업체 이름을 못 찾았습니다. 응답에 실제로 온 필드는 아래와 같습니다.`);
    console.log(`  ${Object.keys(items[0]).join(", ")}`);
    console.log(`  이 줄을 그대로 알려 주시면 필드 이름을 맞추겠습니다.\n`);
  }

  for (const raw of items) {
    const it = normalizeAward(raw);
    seen += 1;
    if (!it.title || !it.corp) continue;
    // 화면에 쓰는 것과 같은 키워드 규칙을 그대로 씁니다.
    if (isExcluded(it, config)) continue;
    const kw = matchGroups(it, config);
    if (!kw.length) continue;
    if (!store[it.bidNo]) added += 1;
    store[it.bidNo] = { ...it, kw };
  }

  return { added, seen };
}

/** 원본 저장소에서 화면이 쓰는 awards.json 을 만듭니다. */
async function buildIndex(store) {
  const list = Object.values(store);
  await saveJson(OUT, { generatedAt: new Date().toISOString(), awards: list });
  return list.length;
}

async function main() {
  const arg = process.argv[2];
  const reset = arg === "--reset";
  const lastYear = new Date().getFullYear() - 1;
  const startYm = !arg || reset ? `${lastYear}-01` : arg;

  if (!/^\d{4}-\d{2}$/.test(startYm)) {
    throw new Error(`시작 월 형식이 잘못됐습니다: ${startYm} (예: 2025-01)`);
  }

  const config = await loadKeywords();
  const state = reset ? { done: [] } : await loadJson(STATE, { done: [] });
  const store = reset ? {} : await loadJson(RAW_AWARD, {});

  const months = monthsFrom(startYm);
  const todo = months.filter((m) => !state.done.includes(m));

  console.log(`[낙찰정보] ${startYm} ~ ${months[months.length - 1]} · 전체 ${months.length}개월`);
  console.log(`[진행] 완료 ${state.done.length}개월 · 남은 ${todo.length}개월`);
  console.log(`[분야] ${Object.keys(config.groups).join(" · ")}`);
  if (!todo.length) {
    console.log(`\n모든 기간을 이미 받았습니다. 다시 받으시려면 --reset 을 붙여 실행하세요.`);
    console.log(`[완료] 보관 ${await buildIndex(store)}건`);
    return;
  }
  console.log(`[보관] 현재 ${Object.keys(store).length}건\n`);

  let stopped = false;
  for (const ym of todo) {
    if (callsUsed >= CALL_BUDGET) {
      console.log(`\n[중단] 오늘 사용량이 한도에 가까워 여기서 멈춥니다.`);
      stopped = true;
      break;
    }
    try {
      process.stdout.write(`  ${ym} … `);
      const { added, seen } = await collectMonth(ym, store, config);
      state.done.push(ym);
      await saveJson(RAW_AWARD, store);
      await saveJson(STATE, state);
      console.log(`조회 ${seen}건 중 우리 분야 신규 ${added}건 (누적 호출 ${callsUsed}회)`);
    } catch (err) {
      console.log(`실패`);
      if (isQuotaError(err)) {
        console.log(`\n[중단] 오늘 호출 한도를 다 썼습니다. 한도는 자정에 초기화됩니다.`);
        console.log(`       내일 같은 명령을 다시 실행하시면 ${ym} 부터 이어받습니다.`);
        stopped = true;
        break;
      }
      throw err;
    }
  }

  const total = await buildIndex(store);
  console.log(`\n[완료] 낙찰정보 ${total}건 보관 · data/g2b/awards.json 생성`);
  if (stopped) {
    console.log(`남은 기간이 있습니다. 내일 다시 실행하세요.`);
  } else {
    console.log(`이제 수집.bat 을 실행하면 공고 카드에 "작년" 줄이 채워집니다.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n[오류] ${err.message}`);
    process.exitCode = 1;
  });
}

export { monthsFrom, monthWindow, AWARD_OP };
