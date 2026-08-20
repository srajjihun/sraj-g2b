// 심사표 자가채점 — "이 공고에서 우리가 몇 점 받나"를 공고의 실제 심사표로 계산합니다.
//
// 왜 바꾸는가:
//   예전 예측점수는 참가가능성 40 / 유사실적 35 / 평가유리도 25 라는 가중치를
//   제가 정해서 썼습니다. 근거가 없는 숫자였습니다. 이제 공고문에서 심사표를
//   뽑아낼 수 있으니, 남의 기준이 아니라 그 공고가 실제로 쓰는 채점표로 셉니다.
//
// 무엇을 채점하고 무엇을 안 하는가:
//   채점함   실적 · 신인도 · 지역   — 지금 확인 가능하고, 회사마다 다른 항목
//   채점 안 함 정성평가(사업이해도·제안내용) — 제안서를 써봐야 아는 것이고,
//              어차피 공고끼리 차이가 없어 넣으면 변별력만 사라집니다
//   채점 안 함 가격평가 — 우리가 얼마를 쓰느냐에 달린 것이라 공고 비교값이 아닙니다
//   채점함   경영상태 — 회사정보의 신용등급을 공고의 등급별 배점 구간에 맞춥니다.
//   채점함   참여인력 — 회사정보.md 의 "참여인력: 만점" 설정에 따라 만점으로 봅니다.
//              제안서를 쓸 때 요구 조건에 맞는 인력을 편성해 넣는 것이 우리가
//              통제할 수 있는 일이라 그렇게 정했습니다(2026-08). 이것은 공고문에서
//              읽어낸 사실이 아니라 가정이므로 설정 파일에 두고, 근거 문구에도
//              방침이라고 밝힙니다 — 사실과 가정은 구분되어야 합니다.
//
// 그래서 나오는 값은 "총점 예상"이 아니라 "정량 항목 득점률"입니다.
// 총점처럼 보이게 만들 수도 있었지만, 그러면 정성 배점이 큰 공고일수록
// 점수가 다 비슷해져서 무엇을 먼저 볼지 가려낼 수 없습니다.
import { itemKey, creditScore } from "./require.mjs";

/** 우리가 지금 채점할 수 있는 항목들 */
const SCORABLE = new Set(["실적", "신인도", "지역", "경영", "인력"]);
/** 채점 대상에서 아예 빼는 항목들 (위 설명 참고) */
const EXCLUDED = new Set(["정성", "가격"]);

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

const 억 = (v) => `${Math.round((v / 1e8) * 10) / 10}억`;

/**
 * 실적 항목 채점.
 *
 * 심사표에 등급이 적혀 있으면 그것을 그대로 씁니다. 등급에는 두 가지가
 * 있습니다 — 금액 등급("5억 이상 10점")과 건수 등급("3건 이상 10점").
 * 예전에는 금액 등급만 봤고, 그나마도 "가장 큰 실적 한 건" 으로만 따졌습니다.
 * 실적DB 를 건별로 들고 있으니 건수도 셀 수 있습니다.
 *
 * 금액 등급을 단일 최대 실적으로 판정하는 것은 보수적인 선택입니다. 공고에
 * 따라 누적 금액을 뜻할 수도 있는데, 그때는 우리가 더 유리해집니다.
 * 낮게 잡아 놓치는 편이 높게 잡아 헛수고하는 것보다 낫습니다. 그래서 근거
 * 문구에 "단일 최대" 라고 밝혀 둡니다.
 */
function scoreRecord(item, company, budget, records) {
  const mine = company?.maxRecord ?? null;
  if (!mine) return { got: null, why: "우리 실적 미입력" };

  // ① 건수 등급 — 실적DB 가 있어야 셀 수 있습니다.
  if (item.countTiers?.length && records?.ok) {
    const years = item.years ?? 3;
    const min = item.countAmount ?? 0;
    const have = min ? records.countAtLeast(min, years) : records.since(years).length;
    const hit = item.countTiers.find((t) => have >= t.min);
    const got = hit ? Math.min(hit.score, item.score) : 0;
    const what = min ? `${억(min)} 이상 ` : "";
    return { got, why: `최근 ${years}년 ${what}${have}건 — ${hit ? `${hit.min}건 이상 등급 ${got}점` : "최저 등급 미달"}` };
  }

  // ② 금액 등급
  if (item.tiers?.length) {
    const hit = item.tiers.find((t) => mine >= t.min);
    const got = hit ? Math.min(hit.score, item.score) : 0;
    const need = item.tiers[item.tiers.length - 1].min;
    return {
      got,
      why: hit
        ? `단일 최대 ${억(mine)} → ${억(hit.min)} 이상 등급 ${got}점`
        : `단일 최대 ${억(mine)} · 최저 등급 ${억(need)}에 미달`,
    };
  }

  // ③ 등급을 못 읽었으면 사업 규모 대비 비율로 봅니다.
  if (!budget) return { got: null, why: "사업금액 미상" };
  const r = mine / budget;
  const ratio = r >= 3 ? 1 : r >= 1.5 ? 0.9 : r >= 1 ? 0.8 : r >= 0.7 ? 0.65 : r >= 0.5 ? 0.5 : 0.3;
  // 이 사업 규모를 넘는 실적이 몇 건이나 되는지도 같이 말합니다.
  // "8억짜리 하나 있음" 과 "이 규모 이상을 6건 했음" 은 전혀 다른 이야기입니다.
  const over = records?.ok ? records.countAtLeast(budget, 3) : null;
  return {
    got: Math.round(item.score * ratio * 10) / 10,
    why: `단일 최대 ${억(mine)} (사업금액의 ${Math.round(r * 100)}%)`
      + (over === null ? "" : ` · 최근 3년 이 규모 이상 ${over}건`),
  };
}

/** 신인도 항목 채점. 이 공고가 인정하는 인증 중 우리가 가진 비율입니다. */
function scoreCredit(item, company, credits) {
  const asked = (credits ?? []).map((c) => c.term);
  if (!asked.length) return { got: null, why: "인정 인증 목록을 못 읽음" };
  const held = new Set([
    ...(company?.certs ?? []),
    ...((company?.directProduce ?? []).length ? ["직접생산확인"] : []),
  ].map(norm));
  const hit = asked.filter((t) => held.has(norm(t)));
  // 신인도는 해당 항목을 합산하는 방식이라, 인정 항목 중 보유 비율로 봅니다.
  const ratio = hit.length / asked.length;
  return {
    got: Math.round(item.score * ratio * 10) / 10,
    why: hit.length ? `${asked.length}개 중 ${hit.join("·")} 보유` : `${asked.length}개 중 보유 없음`,
  };
}

/**
 * 경영상태 항목 채점.
 *
 * 공고마다 등급별 배점 구간이 다릅니다("A0 이상 10점, BBB 구간 8점"). 구간표를
 * 읽어냈으면 우리 등급이 어느 칸에 드는지 맞춥니다. 구간표를 못 읽었으면
 * 채점하지 않습니다 — 등급만 알고 배점표를 모르면 점수를 지어내는 셈입니다.
 */
function scoreManage(item, company) {
  const grade = company?.credit;
  if (!grade) return { got: null, why: "우리 신용등급 미입력" };
  if (!item.creditTiers?.length) return { got: null, why: `${grade} 보유 · 이 공고의 등급별 배점 구간을 못 읽음` };
  const hit = creditScore(item.creditTiers, grade);
  if (!hit) return { got: null, why: `${grade} · 이 공고의 등급 구간 어디에도 들어가지 않습니다` };
  /* 사다리를 딴 표에서 가져왔으면 만점이 이 항목 배점과 다를 수 있습니다
     (10점짜리 사다리인데 이 항목은 5점). 그때는 비율로 환산합니다 —
     그냥 자르면 낮은 등급이 만점처럼 보입니다. */
  const ladderMax = Math.max(...item.creditTiers.map((t) => t.score));
  const got = ladderMax > item.score
    ? Math.round((item.score * hit.score / ladderMax) * 10) / 10
    : Math.min(hit.score, item.score);
  const from = item.creditFrom ? " (등급표는 공고문 다른 곳에서 찾았습니다)" : "";
  return { got, why: `${grade} → ${hit.tier.grades.join("·")} 칸 ${got}점${from}` };
}

/**
 * 참여인력 항목 채점.
 *
 * 실적이나 인증과 달리 인력은 제안서를 쓸 때 요구 조건에 맞춰 편성해 넣을 수
 * 있습니다. 우리가 통제할 수 있는 항목이라 만점을 전제로 둡니다.
 *
 * 다만 이것은 공고문에서 읽어낸 사실이 아니라 우리가 정한 가정입니다. 그래서
 *   ① 코드에 박아 두지 않고 config/회사정보.md 의 "참여인력" 에서 읽습니다.
 *      방침이 바뀌면 그 한 줄만 고치면 되고, 무엇을 가정했는지가 눈에 보입니다.
 *   ② 근거 문구에 "회사 방침" 이라고 밝힙니다.
 * 사실과 가정이 같은 얼굴을 하면 안 됩니다.
 */
function scorePeople(item, company) {
  if (company?.people !== "만점") return { got: null, why: "참여인력 방침 미설정 (회사정보.md)" };
  return { got: item.score, why: `요구 조건에 맞춰 인력을 편성한다는 전제로 만점 (회사 방침)` };
}

/** 지역 항목 채점. 어느 지역을 요구하는지 읽힌 공고만 채점합니다. */
function scoreRegion(item, company, region) {
  if (!region?.value || !company?.region) return { got: null, why: "요구 지역 또는 우리 소재지 미상" };
  const ok = company.region.slice(0, 2) === region.value.slice(0, 2);
  return { got: ok ? item.score : 0, why: `${region.value} 기준 · 우리 ${company.region}` };
}

/**
 * 참가 자격 판정. 여기서 "불가"가 나오면 목록에서 뺍니다.
 * 뺀다는 건 되돌리기 어려운 일이라, 확실한 근거가 있을 때만 불가로 봅니다.
 * 애매하면 불가로 하지 않습니다 — 놓친 기회는 눈에 보이지도 않습니다.
 */
export function judgeBlocked(doc, company) {
  const why = [];

  // ① 공고문에서 읽어낸 지역·업종·실적 판정
  for (const c of doc?.eligibility?.checks ?? []) {
    if (c.verdict === "불가") why.push(`${c.key}: ${c.detail}`);
  }

  // ② 직접생산확인은 품목이 맞아야 합니다. 품목이 다르면 증명서가 있어도 못 냅니다.
  const need = doc?.directItems ?? [];
  if (need.length && (company?.directProduce ?? []).length) {
    const ours = new Set(company.directProduce.map(itemKey));
    const missing = need.filter((i) => !ours.has(itemKey(i.name)));
    // 요구 품목을 하나도 못 맞추면 참가 불가입니다.
    if (missing.length === need.length) {
      why.push(`직접생산확인 품목: ${missing.map((i) => i.name).join("·")} 미보유`);
    }
  }

  return { blocked: why.length > 0, why };
}

/**
 * 공고 하나를 자가채점합니다.
 * @returns {{mode, pct, got, max, unknown, items, blocked, blockWhy}|null}
 */
export function selfScore(doc, company, budget, records) {
  const table = doc?.scoreTable;
  const { blocked, why: blockWhy } = judgeBlocked(doc, company);
  if (!table?.items?.length) {
    return blocked ? { mode: "없음", blocked, blockWhy } : null;
  }

  const items = [];
  let got = 0;
  let max = 0;
  let unknown = 0;
  // 무엇을 못 채점했는지도 남깁니다. 화면에 "경영상태·인력" 이라고 고정으로
  // 박아 두었더니 지역이 미확인일 때도 그 문구가 나왔습니다 — 사실이 아닙니다.
  const unknownKinds = new Set();
  /* 왜 못 셌는지도 항목별로 남깁니다.
     예전에는 사유를 버리고 화면에서 종류별 상투 문구를 붙였는데, 그러면
     "구간표를 못 읽었다" 인 경우에도 "신용등급이 회사정보에 없습니다" 라고
     사실과 다른 말이 나옵니다. 실제로 그것 때문에 헤맸습니다. */
  const skipped = [];

  for (const it of table.items) {
    if (EXCLUDED.has(it.kind)) continue;
    if (!SCORABLE.has(it.kind)) {
      unknown += it.score; unknownKinds.add(it.kind);
      skipped.push({ name: it.name, kind: it.kind, score: it.score, why: "우리가 분류하지 못한 항목입니다" });
      continue;
    }

    const r =
      it.kind === "실적" ? scoreRecord(it, company, budget, records)
      : it.kind === "신인도" ? scoreCredit(it, company, doc.credits)
      : it.kind === "경영" ? scoreManage(it, company)
      : it.kind === "인력" ? scorePeople(it, company)
      : scoreRegion(it, company, doc.region);

    if (r.got === null) {
      unknown += it.score; unknownKinds.add(it.kind);
      skipped.push({ name: it.name, kind: it.kind, score: it.score, why: r.why });
      continue;
    }
    got += r.got;
    max += it.score;
    items.push({ name: it.name, kind: it.kind, score: it.score, got: r.got, why: r.why });
  }

  if (!max) return blocked ? { mode: "없음", blocked, blockWhy } : null;

  return {
    mode: "심사표",
    pct: Math.round((got / max) * 100),
    got: Math.round(got * 10) / 10,
    max,
    unknown,
    unknownKinds: [...unknownKinds],
    skipped,
    items,
    blocked,
    blockWhy,
  };
}
