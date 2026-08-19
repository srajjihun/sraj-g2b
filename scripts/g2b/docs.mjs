// 공고문 분석기 — 첨부파일을 내려받아 참가자격과 배점표를 뽑습니다.
//
// 왜 필요한가:
//   목록 API 는 "지역제한 있음(Y)" 까지만 알려주고 어느 지역인지는 안 줍니다.
//   그 내용은 공고문 안에만 있습니다. 그걸 읽어야 "우리가 들어갈 수 있는가"를
//   추측이 아니라 확정으로 말할 수 있습니다.
//
// 무엇을 하는가:
//   ① 예산 큰 순으로 N건을 고른다 (전부 받을 필요가 없습니다)
//   ② 첨부파일을 내려받아 형식을 판별한다 (PDF / HWPX / HWP)
//   ③ 형식별로 직접 읽는다 — 한글(한컴오피스)이 없어도 됩니다
//   ④ 참가자격·배점표를 뽑아 data/g2b/docs.json 에 쌓는다
//
// 한 번 읽은 공고는 다시 읽지 않습니다 — 해석기가 좋아진 경우(VERSION)만 예외입니다.
// 원본 파일은 남기지 않고 뽑아낸 것만 보관합니다.
//
// 사용법:
//   node scripts\g2b\docs.mjs         ← 상위 20건
//   node scripts\g2b\docs.mjs 50      ← 상위 50건
//   node scripts\g2b\docs.mjs --all   ← 전부 (오래 걸립니다)
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { download, readDocument, sniff } from "./lib/doc.mjs";
import { extractRequirements } from "./lib/require.mjs";
import { loadCompany } from "./lib/company.mjs";

const DATA_DIR = new URL("../../data/g2b/", import.meta.url);
const POSTS = new URL("posts.json", DATA_DIR);
const OUT = new URL("docs.json", DATA_DIR);

// 해석기 판(版). 해석 방식이 좋아지면 이 숫자를 올립니다. 그러면 예전에
// 읽어 둔 공고도 다시 읽습니다 — 안 그러면 "이미 읽음"으로 남아서 개선된
// 결과가 영원히 반영되지 않습니다. 실제로 그 일이 있었습니다: 한글 자동화가
// 막혀 HWP 를 못 읽은 100건이 전부 "읽음"으로 저장돼 있었습니다.
//   1 → 최초
//   2 → HWP 를 한글 없이 직접 읽음 / 업종 오탐(나라장터 상투문구) 제거
//   (그 뒤로는 실패한 건만 골라 다시 읽습니다 — needsRetry 참고)
const VERSION = 2;

const DEFAULT_LIMIT = 20;
// 공고문은 보통 첫 두어 개 첨부에 들어 있습니다. 전부 받으면 시간만 걸립니다.
// 제안요청서가 네 번째 첨부인 공고가 실제로 있습니다. 정렬로 앞에 끌어오지만,
// 산출내역서 같은 것이 여러 개 붙은 공고도 있어 한 칸 여유를 둡니다.
const MAX_FILES_PER_NOTICE = 4;
const MAX_BYTES = 30 * 1024 * 1024;

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

/**
 * 공고문일 가능성이 높은 첨부부터 봅니다.
 *
 * 순서를 두 단으로 나눈 이유:
 *   심사표(배점표)는 대개 **제안요청서·과업지시서**에 있고, 참가자격(지역·업종)은
 *   **입찰공고문**에 있습니다. 예: "국민건강보험 일산병원 온라인홍보 사업 협력사
 *   선정" 은 배점표가 제안요청서에만 있습니다. 첨부 개수 제한에 걸려 제안요청서를
 *   아예 못 열면 그 공고는 영영 자가채점이 안 됩니다. 그래서 제안요청서를 먼저 봅니다.
 */
function rankFiles(files) {
  const score = (name) => {
    const n = String(name ?? "");
    if (/제안요청|과업지시|과업내용|제안안내|입찰설명/.test(n)) return 0; // 심사표가 여기 있습니다
    if (/입찰공고|공고문|규격서|안내서/.test(n)) return 1;               // 참가자격이 여기 있습니다
    if (/산출|내역|서약|청렴|양식|서식|위임|증명|동의|확약/.test(n)) return 4;
    return 2;
  };
  return [...(files ?? [])].sort((a, b) => score(a.name) - score(b.name));
}

/** 공고 1건 처리 */
/* deps 는 자체점검용 구멍입니다. 이 함수의 핵심은 "여러 첨부에서 조각을 모으는
   순서와 규칙" 인데, 진짜 파일을 내려받아야만 시험할 수 있으면 그 규칙을 영영
   시험하지 못합니다. 평소에는 기본값이 그대로 쓰입니다. */
async function analyze(item, workDir, deps = {}) {
  const dl = deps.download ?? download;
  const rd = deps.readDocument ?? readDocument;
  const files = rankFiles(item.files).slice(0, MAX_FILES_PER_NOTICE);
  if (!files.length) {
    return { ok: false, note: "첨부파일이 없습니다", kinds: [] };
  }

  const kinds = [];

  /* 첨부 하나만 골라 쓰지 않고 **필드별로 합칩니다.**
     예전에는 "가장 많이 알아낸 파일 하나"를 골라 나머지를 버렸습니다. 그런데
     참가자격은 입찰공고문에, 심사표는 제안요청서에 나뉘어 있는 것이 흔합니다.
     그러면 항목 수로는 입찰공고문이 이기고, 제안요청서에만 있던 심사표가
     통째로 버려집니다 — 자가채점이 안 되는 공고의 큰 몫이 이 경우였습니다.
     이제 각 항목을 처음 찾아낸 파일에서 가져오고, 어느 파일에서 나왔는지도
     같이 남깁니다. */
  const merged = { region: null, industry: [], record: null, rate: null,
                   scoreTable: null, credits: [], directItems: null };
  const sources = {};
  let readAny = false;
  let chars = 0;

  const take = (key, value, from) => {
    if (merged[key] || !value) return;
    merged[key] = value;
    sources[key] = from;
  };
  // 여러 파일에 흩어져 나오는 목록은 합칩니다 (업종·인증은 공고문과 제안요청서에 나뉘어 적히기도 합니다)
  const join = (key, list, keyOf, from) => {
    if (!list?.length) return;
    const seen = new Set(merged[key].map(keyOf));
    for (const x of list) {
      if (seen.has(keyOf(x))) continue;
      seen.add(keyOf(x));
      merged[key].push(x);
    }
    if (!sources[key]) sources[key] = from;
  };

  for (const f of files) {
    let buf;
    try {
      buf = await dl(f.url);
    } catch (err) {
      kinds.push({ name: f.name, kind: "?", note: `내려받기 실패: ${err.message}` });
      continue;
    }
    if (buf.length > MAX_BYTES) {
      kinds.push({ name: f.name, kind: sniff(buf), note: "파일이 너무 큽니다" });
      continue;
    }

    const doc = await rd(buf, { workDir });
    kinds.push({ name: f.name, kind: doc.kind, note: doc.note });
    if (!doc.ok || !doc.text) continue;

    const req = extractRequirements(doc.text, doc.tables);
    readAny = true;
    chars += doc.text.length;

    take("region", req.region, f.name);
    take("record", req.record, f.name);
    take("rate", req.rate, f.name);
    take("directItems", req.directItems?.length ? req.directItems : null, f.name);
    join("industry", req.industry, (x) => x.value, f.name);
    join("credits", req.credits, (x) => x.term, f.name);

    /* 심사표는 여러 파일에 있을 수 있습니다(공고문의 요약표 + 제안요청서의 상세표).
       합이 100 에 가까운 쪽이 진짜 배점표입니다 — 요약표는 항목이 잘려 합이 안 맞습니다. */
    if (req.scoreTable) {
      const near = (t) => Math.abs((t?.total ?? 0) - 100);
      if (!merged.scoreTable || near(req.scoreTable) < near(merged.scoreTable)) {
        merged.scoreTable = req.scoreTable;
        sources.scoreTable = f.name;
      }
    }

    /* 그만 볼 조건은 "심사표를 실제로 찾았을 때" 입니다.
       예전에는 배점 비율 한 줄("기술 80 : 가격 20")만 있어도 다 찾은 것으로 보고
       멈췄습니다. 그 한 줄은 입찰공고문에 거의 항상 있으므로, 정작 심사표가 든
       제안요청서를 한 번도 열지 않고 끝나는 일이 생겼습니다. */
    if (merged.region && merged.scoreTable) break;
  }

  if (!readAny) return { ok: false, note: "읽을 수 있는 공고문이 없습니다", kinds };

  const found = {
    region: !!merged.region,
    industry: merged.industry.length > 0,
    record: !!merged.record,
    score: !!merged.scoreTable || !!merged.rate,
  };
  return {
    ok: true,
    note: "",
    kinds,
    // 심사표를 준 파일이 이 공고를 대표합니다. 없으면 자격을 준 파일.
    source: sources.scoreTable || sources.region || Object.values(sources)[0] || files[0]?.name || "",
    sources,
    chars,
    ...merged,
    found,
  };
}

async function main() {
  const arg = process.argv[2];
  const all = arg === "--all";
  const limit = all ? Infinity : Number(arg) > 0 ? Number(arg) : DEFAULT_LIMIT;

  const payload = await loadJson(POSTS, null);
  if (!payload) throw new Error("data/g2b/posts.json 이 없습니다. 먼저 수집을 실행하세요.");

  const company = await loadCompany();
  const store = await loadJson(OUT, {});
  const items = [...(payload.posts ?? []), ...(payload.prespecs ?? [])];

  // 예산 큰 순으로 (규모가 큰 건부터 확인하는 편이 이득입니다).
  const byBudget = (a, b) => (b.budget ?? b.price ?? 0) - (a.budget ?? a.price ?? 0);
  const withFiles = items.filter((it) => it.bidNo && (it.files ?? []).length);
  const fresh = withFiles.filter((it) => !store[it.bidNo]).sort(byBudget);
  // 다시 읽을 대상 고르기.
  //   ① 해석기 판이 올라갔거나
  //   ② 지난번에 못 읽은 형식이 이번에 읽을 수 있게 된 경우
  // 판(VERSION)만 기준으로 하면 잘 읽힌 380건까지 통째로 다시 받게 됩니다.
  // 실제로 필요한 건 실패한 30여 건뿐이라, 그것만 골라 시간을 아낍니다.
  // 다만 배포용·암호 문서처럼 영영 못 읽는 것도 있어서 두 번까지만 시도합니다.
  const RETRYABLE = /^(zip|ole|unknown|hwp|pdf|docx|hwpx)$/;
  const needsRetry = (d) => {
    if ((d.v ?? 0) < VERSION) return true;
    // 직접생산확인을 요구하는데 품목 이름이 없는 건 — 예전 방식은 한 줄만
    // 봐서 153건 중 63건이 이름 미상이었습니다. 품목을 모르면 우리가 들어갈
    // 수 있는지 판단이 안 되므로 이 건들은 다시 읽습니다.
    if (d.ok && !d.directItems && (d.credits ?? []).some((c) => c.term === "직접생산확인")) return true;
    // "중소기업" 안의 "소기업" 을 소기업 가점으로 잘못 저장한 건들.
    // 그대로 두면 예측점수에서 계속 감점됩니다. 규칙을 고쳤으니 다시 읽습니다.
    // (오탐이 든 건만 골라 다시 읽습니다 — 잘 읽힌 360건은 건드리지 않습니다)
    if (d.ok && (d.credits ?? []).some((c) => c.term === "소기업")) return true;
    if ((d.tries ?? 1) >= 2) return false;
    return (d.kinds ?? []).some((k) => k.note && RETRYABLE.test(k.kind ?? ""));
  };
  const stale = withFiles.filter((it) => store[it.bidNo] && needsRetry(store[it.bidNo])).sort(byBudget);

  /* 다시 읽을 자리를 따로 떼어 둡니다.
     처음에는 "안 읽은 것 먼저, 남으면 다시 읽기"로 했는데, 안 읽은 공고가
     300건 넘게 남아 있어서 다시 읽기 차례가 영영 오지 않았습니다(0건).
     그래서 3분의 1을 다시 읽기 몫으로 남깁니다. */
  // 새로 읽을 것에 자리를 먼저 주되,
  // 그리고 새로 읽을 게 그만큼 없으면 남는 자리를 다시 읽기가 다 씁니다 —
  // 예전에는 그 처리가 없어서, 62건을 다시 읽어야 하는데 한 번에 6건씩만
  // 줄어들었습니다(20건 중 3분의 1). 그 속도면 열 번을 돌려야 합니다.
  const keepForStale = limit === Infinity ? Infinity : Math.max(1, Math.floor(limit / 3));
  const freshRoom = limit === Infinity ? Infinity : Math.max(0, limit - Math.min(keepForStale, stale.length));
  const pickFresh = fresh.slice(0, freshRoom === Infinity ? undefined : freshRoom);
  const staleRoom = limit === Infinity ? stale.length : Math.max(0, limit - pickFresh.length);
  const pickStale = stale.slice(0, staleRoom);
  const todo = [...pickFresh, ...pickStale];

  console.log(
    `[공고문] 전체 ${items.length}건 · 이미 읽음 ${Object.keys(store).length}건 · ` +
      `이번에 ${todo.length}건 (새로 ${pickFresh.length} · 다시 읽기 ${pickStale.length})`
  );
  if (stale.length) {
    console.log(`         해석기가 좋아져서 예전에 읽은 ${stale.length}건도 차례로 다시 읽습니다.`);
  }
  if (!todo.length) {
    console.log("새로 읽을 공고가 없습니다.");
    return;
  }

  const workDir = `${tmpdir()}/g2b-doc-${process.pid}`;
  let ok = 0;
  let fail = 0;

  for (const it of todo) {
    process.stdout.write(`  ${String(it.title).slice(0, 34).padEnd(34)} … `);
    try {
      const r = await analyze(it, workDir);
      const tries = (store[it.bidNo]?.tries ?? 0) + 1;
      store[it.bidNo] = { ...r, v: VERSION, tries, title: it.title, org: it.org, at: new Date().toISOString() };
      if (r.ok) {
        ok += 1;
        const bits = [];
        if (r.region) bits.push(`지역 ${r.region.value}`);
        if (r.industry?.length) bits.push(`업종 ${r.industry[0].value}`);
        if (r.record?.amount) bits.push(`실적 ${Math.round(r.record.amount / 1e6)}백만`);
        if (r.rate) bits.push(`기술${r.rate.tech}:가격${r.rate.price}`);
        if (r.scoreTable) bits.push(`배점표 ${r.scoreTable.items.length}항목`);
        if (r.credits?.length) bits.push(`신인도 ${r.credits.map((c) => c.term).join("·")}`);
        if (r.directItems?.length) bits.push(`직생품목 ${r.directItems.map((i) => i.name).join("·")}`);
        console.log(bits.length ? bits.join(" · ") : "읽었으나 자격·배점 문구를 못 찾음");
      } else {
        fail += 1;
        console.log(r.note);
      }
    } catch (err) {
      fail += 1;
      const tries = (store[it.bidNo]?.tries ?? 0) + 1;
      store[it.bidNo] = { ok: false, v: VERSION, tries, note: err.message, title: it.title, at: new Date().toISOString() };
      console.log(`실패: ${err.message}`);
    }
    await saveJson(OUT, store); // 중간에 멈춰도 읽은 것은 남습니다
  }

  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n[완료] 읽음 ${ok}건 · 못 읽음 ${fail}건 · 누적 ${Object.keys(store).length}건`);

  // 어떤 형식이 실제로 읽히고 있는지. HWP 가 0 이면 뭔가 잘못된 것입니다.
  const byKind = new Map();
  for (const d of Object.values(store)) {
    for (const k of d?.kinds ?? []) {
      const key = k.kind ?? "?";
      const cur = byKind.get(key) ?? { ok: 0, no: 0 };
      if (k.note) cur.no += 1; else cur.ok += 1;
      byKind.set(key, cur);
    }
  }
  if (byKind.size) {
    const parts = [...byKind.entries()]
      .sort((a, b) => b[1].ok - a[1].ok)
      .map(([k, v]) => `${k} ${v.ok}건${v.no ? `(못 읽음 ${v.no})` : ""}`);
    console.log(`       읽은 첨부 형식 — ${parts.join(" · ")}`);
  }
  console.log(`       화면-새로고침.bat 을 실행하면 공고 카드에 반영됩니다.`);
  if (!company.filled) {
    console.log(`       config/회사정보.md 를 채우면 "우리가 들어갈 수 있는가"까지 판정합니다.`);
  }

  // 지금까지 읽은 전체(누적)에서 신인도 인증이 몇 번 나왔는지.
  // "인증서류 뭐가 더 필요해?"에 추측이 아니라 실제 빈도로 답하기 위한 것입니다.
  const tally = new Map();
  let scored = 0;
  for (const d of Object.values(store)) {
    if (!d?.ok) continue;
    scored += 1;
    for (const c of d.credits ?? []) tally.set(c.term, (tally.get(c.term) ?? 0) + 1);
  }
  if (tally.size) {
    const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n[신인도] 지금까지 읽은 공고문 ${scored}건 중 언급된 인증 (많은 순):`);
    for (const [term, n] of rows) console.log(`       ${term} — ${n}건`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n[오류] ${err.message}`);
    process.exitCode = 1;
  });
}

export { analyze, rankFiles };
