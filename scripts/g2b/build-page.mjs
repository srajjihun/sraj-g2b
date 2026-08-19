// g2b.html(페이지 틀)에 data/g2b/posts.json 을 심어 g2b-live.html 을 만듭니다.
//
// g2b.html 은 데이터가 빈 채로 저장소에 커밋되고,
// g2b-live.html 은 수집 데이터가 담긴 로컬 전용 파일입니다(.gitignore).
// 브라우저에서 g2b-live.html 을 더블클릭하면 열립니다.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadCompany } from "./lib/company.mjs";
import { selfScore } from "./lib/selfscore.mjs";
import { loadRecords } from "./lib/records.mjs";
import { judgeEligibility } from "./lib/require.mjs";
import { loadProposals } from "./lib/proposals.mjs";

const TEMPLATE = new URL("../../g2b.html", import.meta.url);
const DATA = new URL("../../data/g2b/posts.json", import.meta.url);
const DOCS = new URL("../../data/g2b/docs.json", import.meta.url); // docs.mjs 가 만듭니다
const OUT = new URL("../../g2b-live.html", import.meta.url);

const START = "<!--G2B_DATA_START-->";
const END = "<!--G2B_DATA_END-->";

async function main() {
  const html = await readFile(TEMPLATE, "utf8");

  let payload;
  try {
    payload = JSON.parse(await readFile(DATA, "utf8"));
  } catch (err) {
    throw new Error(`data/g2b/posts.json 을 읽지 못했습니다 (${err.message}). 먼저 collect.mjs 를 실행하세요.`);
  }

  // 예측점수는 화면에서 계산합니다. 회사 정보를 같이 심어 두면
  // config/회사정보.md 만 고치고 이 스크립트를 다시 돌려도 점수가 갱신됩니다.
  // (수집을 다시 할 필요가 없습니다)
  const records = await loadRecords();
  payload.company = await loadCompany();
  if (records.ok) {
    console.log(
      `[실적DB] ${records.count}건 · 최근 3년 ${records.since(3).length}건 ` +
        `· 최대단일실적 ${(records.maxRecord / 1e8).toFixed(1)}억`
    );
  }

  // 공고문에서 읽어낸 자격·배점을 각 공고에 붙입니다.
  // 목록 API 는 "지역제한 있음"까지만 알려주므로, 여기까지 와야 "우리가 들어갈 수
  // 있는가"를 추측이 아니라 확정으로 말할 수 있습니다.
  let docs = {};
  try {
    docs = JSON.parse(await readFile(DOCS, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // 경쟁사 분석 화면이 쓸 낙찰 원본도 같이 심습니다.
  try {
    const aw = JSON.parse(await readFile(new URL("../../data/g2b/awards.json", import.meta.url), "utf8"));
    payload.awards = Array.isArray(aw?.awards) ? aw.awards : [];
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    payload.awards = [];
  }

  let attached = 0;
  for (const it of [...(payload.posts ?? []), ...(payload.prespecs ?? [])]) {
    const d = docs[it.bidNo];
    if (!d?.ok) continue;
    it.doc = {
      region: d.region ?? null,
      industry: d.industry ?? [],
      record: d.record ?? null,
      rate: d.rate ?? null,
      scoreTable: d.scoreTable ?? null,
      credits: d.credits ?? [],
      directItems: d.directItems ?? null,
      source: d.source ?? "",
      eligibility: judgeEligibility(d, payload.company),
    };
    // 심사표 자가채점. 공고의 실제 채점표로 "우리가 몇 점 받나"를 셉니다.
    it.self = selfScore(it.doc, payload.company, it.budget ?? it.price ?? null, records);
    attached += 1;
  }
  const scored = [...(payload.posts ?? []), ...(payload.prespecs ?? [])];
  const selfN = scored.filter((it) => it.self?.mode === "심사표").length;
  const blockN = scored.filter((it) => it.self?.blocked).length;
  if (selfN || blockN) {
    console.log(
      `[자가채점] 심사표로 채점 ${selfN}건 · 자격 미달로 목록에서 제외 ${blockN}건`
    );
  }
  console.log(
    attached
      ? `[공고문] ${attached}건에 자격·배점을 붙였습니다`
      : `[공고문] 아직 읽은 공고문이 없습니다 — 공고문-분석.bat 을 돌리면 자격 판정이 확정됩니다`
  );
  console.log(
    payload.company.filled
      ? `[회사정보] ${payload.company.filled}개 항목 반영 — 예측점수를 계산합니다`
      : `[회사정보] config/회사정보.md 가 비어 있습니다 — 예측점수는 공고 정보만으로 잠정 계산합니다`
  );
  /* 유사과업사례를 화면에서 보여주려면 건별 실적이 페이지에 있어야 합니다.
     지금까지는 건수·합계 같은 요약값만 넘겼는데, 제안서에 붙일 사례를 고르려면
     "어느 해에 어느 기관에 얼마짜리를 했는지" 가 한 줄씩 보여야 합니다.
     data/g2b/ 와 g2b-live.html 은 gitignore 라 이 목록이 저장소로 나가지 않습니다. */
  payload.records = records.ok
    ? records.all.map((r) => ({ year: r.year, amount: r.amount, org: r.org, title: r.title, type: r.type, kw: r.kw }))
    : [];

  // 사람이 쓴(또는 다른 도구가 만든) 제안 분석 문서. 제안서 분석 화면에 실립니다.
  payload.proposals = await loadProposals();
  if (payload.proposals.length) {
    const n = payload.proposals.reduce((a, d) => a + d.findings.length, 0);
    console.log(`[제안분석] 문서 ${payload.proposals.length}건 · 대조 지적 ${n}건`);
  }

  const data = JSON.stringify(payload);

  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s === -1 || e === -1) throw new Error("g2b.html 에서 데이터 마커를 찾지 못했습니다.");

  // </script> 조기 종료 방지
  const safe = data.replace(/<\/script/gi, "<\\/script");
  const block = `${START}\n<script id="g2b-data" type="application/json">\n${safe}\n</script>\n${END}`;
  const out = html.slice(0, s) + block + html.slice(e + END.length);

  await writeFile(OUT, out, "utf8");
  console.log(`[완료] g2b-live.html 생성 (${(out.length / 1024).toFixed(0)}KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
