// 낙찰업체(선정기업) 찾기 — "이 사업, 누가 따갔나"를 공고명으로 조회합니다.
//
// 왜 따로 있어야 하는가:
//   award.mjs 는 작년 1년치를 월 단위로 쓸어 담아 우리 6개 분야에 걸리는 것만
//   남깁니다. 그래서 "모두의 창업 홍보" 처럼 특정 사업명으로 지금 바로 찾고 싶을
//   때는 쓸 수가 없습니다 — 이미 모아둔 것 안에만 있고, 분야 밖이면 아예 없습니다.
//   이 파일은 모아둔 데이터를 보지 않고 나라장터에 직접 물어봅니다.
//
// 두 가지 방식:
//   빠른 조회(기본) — 나라장터에 공고명을 넘겨 그 말이 든 건만 받습니다.
//                     호출 몇 번으로 끝나 하루 한도를 거의 쓰지 않습니다.
//   전수 조회(--sweep) — 기간 전체를 받아 우리가 직접 걸러냅니다. 호출을 많이
//                     쓰지만, 나라장터의 공고명 검색이 못 잡는 표기까지 찾습니다.
//                     (띄어쓰기가 다르거나 사업명이 중간에 박힌 경우)
//
//   빠른 조회가 0건이어도 전수 조회에서 나오는 경우가 실제로 있습니다.
//   그래서 빠른 조회로 아무것도 못 찾으면 전수로 넘어가라고 안내합니다.
//
// 사용법 (PC, 한국 IP 필요):
//   set G2B_SERVICE_KEY=공공데이터포털_일반인증키
//   node scripts\g2b\winner-find.mjs 모두의창업
//   node scripts\g2b\winner-find.mjs "모두의 창업" 창업홍보 --months 36
//   node scripts\g2b\winner-find.mjs --org 경기창조경제혁신센터 홍보
//   node scripts\g2b\winner-find.mjs --org 경기창조경제혁신센터        ← 그 기관 전부
//   node scripts\g2b\winner-find.mjs 모두의창업 --sweep
import { pathToFileURL } from "node:url";
import { fetchAll } from "./lib/api.mjs";
import { normalizeAward } from "./lib/normalize.mjs";

// 낙찰목록현황. 업무구분별로 오퍼레이션이 다릅니다.
const OPS = {
  용역: "getScsbidListSttusServcPPSSrch",
  물품: "getScsbidListSttusThngPPSSrch",
  공사: "getScsbidListSttusCnstwkPPSSrch",
};

const DEFAULT_MONTHS = 24;
// 하루 한도(오퍼레이션당 1,000회)에 여유를 둡니다.
const CALL_BUDGET = 700;

let callsUsed = 0;

/** 띄어쓰기·괄호·가운뎃점을 지워 맞춥니다. "모두의 창업" 과 "모두의창업" 은 같은 말입니다. */
export const norm = (s) => String(s ?? "").replace(/[\s·()（）\[\]【】]/g, "").toLowerCase();

const p2 = (n) => String(n).padStart(2, "0");

/** 최근 N개월의 월 창 목록 (오래된 순) */
export function monthWindows(months, now = new Date()) {
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ ym: `${y}-${p2(m)}`, bgn: `${y}${p2(m)}010000`, end: `${y}${p2(m)}${p2(last)}2359` });
  }
  return out;
}

const 억 = (v) => (v ? (v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : `${Math.round(v / 1e6)}백만`) : "—");

function isQuotaError(err) {
  return err?.dailyQuota === true
    || /LIMITED_NUMBER_OF_SERVICE_REQUESTS|트래픽|초과/i.test(err?.message ?? "");
}

/**
 * 한 달치를 조회합니다.
 * @param name 나라장터에 넘길 공고명. null 이면 전수(기간 전체)로 받습니다.
 */
/** 공고명이 찾는 말 중 하나라도 품고 있는지. 띄어쓰기 차이는 무시합니다. */
export function matchTitle(title, words) {
  const t = norm(title);
  return words.some((x) => t.includes(norm(x)));
}

/**
 * 한 달치를 조회합니다.
 * @param ask 나라장터에 넘길 조건. { org } 또는 { name } 또는 {} (전수).
 *
 * 기관과 공고명을 같이 넘기지 않습니다. 나라장터의 공고명 검색은 띄어쓰기나
 * 부분일치를 놓치는 일이 있어, 둘을 같이 넘기면 그 때문에 진짜 건이 빠집니다.
 * 기관 쪽이 더 확실하고 건수도 적으니 기관만 넘기고 공고명은 우리가 걸러냅니다.
 */
async function fetchMonth(op, w, ask, call = fetchAll) {
  const params = {
    inqryDiv: 1, // 1 = 개찰일시 기준
    inqryBgnDt: w.bgn,
    inqryEndDt: w.end,
  };
  if (ask?.org) params.dminsttNm = ask.org;
  else if (ask?.name) params.bidNtceNm = ask.name;
  const name = ask?.org || ask?.name || null;

  return call("AWARD", op, params, {
    label: `${w.ym} ${name ? `"${name}"` : "전수"}`,
    maxPages: name ? 20 : 400,
    onPage: () => { callsUsed += 1; },
  });
}

/* deps 는 자체점검용 구멍입니다. 이 파일의 핵심은 "받은 것에서 무엇을 골라
   어떻게 보여주는가" 인데, 진짜 나라장터에 붙어야만 시험할 수 있으면 그 규칙을
   영영 시험하지 못합니다. 평소에는 기본값(fetchAll)이 그대로 쓰입니다. */
export async function main(argvIn = process.argv.slice(2), deps = {}) {
  const call = deps.fetchAll ?? fetchAll;
  const argv = argvIn;
  callsUsed = 0;
  const sweep = argv.includes("--sweep");
  const allKinds = argv.includes("--all");
  const mi = argv.indexOf("--months");
  const months = mi !== -1 && Number(argv[mi + 1]) > 0 ? Number(argv[mi + 1]) : DEFAULT_MONTHS;
  const oi = argv.indexOf("--org");
  const org = oi !== -1 ? (argv[oi + 1] ?? "") : "";
  // 옵션 값으로 쓰인 것은 찾는 말에서 빼야 합니다.
  const taken = new Set([mi + 1, oi + 1].filter((i) => i > 0));
  const words = argv.filter((a, i) => !a.startsWith("--") && !taken.has(i));

  if (!words.length && !org) {
    console.log("찾을 사업명이나 발주기관을 적어 주세요.");
    console.log('  예) node scripts\\g2b\\winner-find.mjs 모두의창업');
    console.log('      node scripts\\g2b\\winner-find.mjs --org 경기창조경제혁신센터 홍보');
    console.log('      node scripts\\g2b\\winner-find.mjs --org 경기창조경제혁신센터');
    process.exitCode = 1;
    return;
  }
  if (!process.env.G2B_SERVICE_KEY && !deps.fetchAll) {
    console.log("G2B_SERVICE_KEY 가 없습니다. G2B-설치.bat 을 먼저 실행해 인증키를 등록해 주세요.");
    process.exitCode = 1;
    return;
  }

  const kinds = allKinds ? Object.keys(OPS) : ["용역"];
  /* 전수 조회는 최근 달부터 훑습니다.
     기간 전체를 받으면 호출을 많이 써서 하루 한도에 걸려 중간에 멈춥니다.
     오래된 달부터 훑으면 멈췄을 때 정작 최근 것을 못 본 채 끝납니다 —
     "지금 누가 따갔나" 를 보려는 건데 거꾸로입니다.
     빠른 조회는 호출이 적어 다 도니 보기 좋은 순서(오래된 순)를 그대로 둡니다. */
  const wins = sweep ? monthWindows(months).reverse() : monthWindows(months);
  const covered = [];

  console.log(`낙찰업체 찾기`);
  if (org) console.log(`  발주기관  ${org}`);
  console.log(`  찾는 말   ${words.length ? words.join(" · ") : "(제한 없음 — 이 기관의 낙찰 건 전부)"}`);
  console.log(`  기간      최근 ${months}개월 (${wins[0].ym} ~ ${wins[wins.length - 1].ym}) · 개찰일 기준`);
  console.log(`  업무구분  ${kinds.join(" · ")}`);
  console.log(`  방식      ${sweep ? "전수 조회 — 기간 전체를 받아 직접 걸러냅니다" : "빠른 조회 — 나라장터에 공고명을 넘깁니다"}`);
  console.log(`${"─".repeat(70)}`);

  const hits = new Map(); // bidNo -> 낙찰 건
  let seen = 0;
  let quotaHit = false;
  // 나라장터가 공고명 검색을 무시하고 그냥 다 보내주는 경우를 잡기 위한 표시.
  let serverFiltered = 0;
  let serverIgnored = 0;
  let stoppedShort = false;

  outer:
  for (const kind of kinds) {
    for (const w of wins) {
      if (callsUsed >= CALL_BUDGET) {
        stoppedShort = true;
        break outer;
      }
      /* 무엇으로 물어볼지.
           전수     — 아무 조건 없이 기간 전체
           기관 있음 — 기관으로 한 번만. 공고명은 우리가 걸러냅니다
           기관 없음 — 찾는 말마다 따로 (나라장터는 한 번에 한 이름만 받습니다) */
      const asks = sweep ? [{}] : org ? [{ org }] : words.map((name) => ({ name }));
      for (const ask of asks) {
        const name = ask.name ?? null;
        let items;
        try {
          items = await fetchMonth(OPS[kind], w, ask, call);
        } catch (err) {
          if (isQuotaError(err)) { quotaHit = true; break outer; }
          console.log(`  [건너뜀] ${w.ym} ${kind}: ${err.message}`);
          continue;
        }
        seen += items.length;

        // 서버가 공고명 검색을 실제로 걸러 줬는지 확인합니다. 무시했다면 우리가 거른
        // 결과만 맞고, 호출은 전수만큼 쓰게 되므로 그 사실을 알려야 합니다.
        if (name && items.length) {
          const ok = items.filter((raw) => norm(normalizeAward(raw).title).includes(norm(name))).length;
          if (ok) serverFiltered += 1; else serverIgnored += 1;
        }

        for (const raw of items) {
          const it = normalizeAward(raw);
          if (!it.title) continue;
          // 기관을 지정했으면 수요기관·공고기관 어느 쪽이든 걸리면 인정합니다.
          if (org && !(norm(it.org).includes(norm(org)) || norm(it.noticeOrg).includes(norm(org)))) continue;
          // 찾는 말이 없으면(기관만 지정) 공고명은 안 봅니다.
          if (words.length && !matchTitle(it.title, words)) continue;
          if (!hits.has(it.bidNo)) hits.set(it.bidNo, { ...it, kind });
        }
      }
      covered.push(w.ym);
      process.stdout.write(`\r  조회 중… ${w.ym} · 받은 ${seen}건 · 걸린 ${hits.size}건 · 호출 ${callsUsed}회   `);
    }
  }
  process.stdout.write("\n");

  if (stoppedShort || quotaHit) {
    const done = new Set(covered);
    const missed = wins.map((w) => w.ym).filter((ym) => !done.has(ym)).sort();
    console.log(`\n[중단] 하루 호출 한도에 가까워져 멈췄습니다 (${callsUsed}회).`);
    if (covered.length) {
      const c = [...covered].sort();
      console.log(`       본 기간    ${c[0]} ~ ${c[c.length - 1]} (${covered.length}개월)`);
    }
    if (missed.length) {
      console.log(`       못 본 기간 ${missed[0]} ~ ${missed[missed.length - 1]} (${missed.length}개월)`);
      console.log(`       내일 --months ${missed.length + covered.length} 로 다시 돌리거나,`);
      console.log(`       빠른 조회로 바꾸면 한 번에 끝납니다(호출을 거의 안 씁니다).`);
    }
  }

  if (quotaHit) {
    console.log(`\n[안내] 나라장터 하루 호출 한도를 다 썼습니다. 자정이 지나면 풀립니다.`);
    console.log(`       지금까지 찾은 것만 아래에 보여드립니다.`);
  }

  const list = [...hits.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  console.log(`\n■ 찾은 낙찰 건: ${list.length}건   (받아본 낙찰공고 ${seen}건 · API 호출 ${callsUsed}회)`);
  console.log(`${"─".repeat(70)}`);

  if (!list.length) {
    console.log(`  ${org ? `${org} · ` : ""}${words.join(" · ") || "(조건 없음)"} 로는 나오지 않았습니다.\n`);
    if (org) {
      console.log(`  기관 이름이 나라장터 표기와 다를 수 있습니다.`);
      console.log(`  짧게 넣어 보세요 — "경기창조경제혁신센터" 대신 "경기창조" 처럼.\n`);
    }
    if (!sweep) {
      console.log(`  다음을 해보세요.`);
      console.log(`   1) 나라장터의 공고명 검색이 띄어쓰기·부분일치를 못 잡는 경우가 있습니다.`);
      console.log(`      전수 조회로 다시 — 낙찰업체-찾기.bat 에서 "전수" 라고 답하시면 됩니다.`);
      console.log(`   2) 사업명 일부만 넣어 보세요. "모두의창업" 대신 "모두의" 처럼.`);
      console.log(`   3) 개찰이 아직 안 됐으면 낙찰정보에 없습니다 — 진행 중인 공고는 화면에서 보세요.`);
    } else {
      console.log(`  기간 안에 그 이름으로 개찰된 건이 없습니다.`);
      console.log(`  --months 를 늘려 더 과거까지 보거나, 사업명 일부만 넣어 보세요.`);
    }
  }

  for (const it of list) {
    console.log(`\n  ${it.date || "개찰일 미상"}  [${it.kind}]`);
    console.log(`  ${it.title}`);
    console.log(`    발주  ${it.org || "—"}${it.noticeOrg && it.noticeOrg !== it.org ? ` (공고 ${it.noticeOrg})` : ""}`);
    console.log(`    선정  ${it.corp || "—"}${it.bizno ? ` · 사업자 ${it.bizno}` : ""}`);
    const bits = [`계약 ${억(it.amount)}`];
    if (it.rate) bits.push(`낙찰률 ${it.rate}%`);
    if (it.bidders) bits.push(`${it.bidders}곳 투찰`);
    console.log(`    ${bits.join(" · ")}`);
    console.log(`    공고번호 ${it.bidNo}`);
  }

  // 같은 업체가 여러 건을 가져갔는지 — 이게 제일 쓸모 있는 신호입니다.
  if (list.length > 1) {
    const byCorp = new Map();
    for (const it of list) {
      if (!it.corp) continue;
      const r = byCorp.get(it.corp) ?? { n: 0, sum: 0 };
      r.n += 1; r.sum += it.amount || 0;
      byCorp.set(it.corp, r);
    }
    const rows = [...byCorp.entries()].sort((a, b) => b[1].n - a[1].n || b[1].sum - a[1].sum);
    if (rows.length) {
      console.log(`\n\n■ 업체별 정리 — 누가 몇 건 가져갔나`);
      console.log(`${"─".repeat(70)}`);
      for (const [corp, r] of rows) {
        console.log(`  ${String(r.n).padStart(2)}건  ${억(r.sum).padStart(7)}  ${corp}`);
      }
    }
  }

  if (serverIgnored && !serverFiltered) {
    console.log(`\n\n[참고] 나라장터가 공고명 검색을 받아주지 않아 사실상 전수로 받았습니다.`);
    console.log(`       결과는 우리가 직접 걸러낸 것이라 정확합니다. 호출만 많이 썼습니다(${callsUsed}회).`);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`개찰이 끝난 건만 나옵니다. 진행 중인 공고는 이 조회에 안 잡힙니다.`);

  return { list, seen, calls: callsUsed, quotaHit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
