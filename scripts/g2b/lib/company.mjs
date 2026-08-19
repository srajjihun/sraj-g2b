// config/회사정보.md 를 읽어 예측점수 계산에 쓸 형태로 바꿉니다.
//
// 형식은 "항목: 값" 한 줄씩입니다. 값이 비면 그 항목은 없는 것으로 봅니다.
// 사용자가 직접 손으로 고치는 파일이라 형식이 조금 틀려도 죽지 않게 씁니다.
import { readFile, writeFile } from "node:fs/promises";
import { loadRecords } from "./records.mjs";

const CONFIG = new URL("../../../config/회사정보.md", import.meta.url);
// 예시 파일은 저장소에 커밋되고, 실제 파일(회사정보.md)은 각 PC 에만 남습니다.
// 업데이트가 회사 정보를 덮어쓰지 않게 하기 위해서입니다.
const SAMPLE = new URL("../../../config/회사정보.예시.md", import.meta.url);

// "1,200,000,000" / "12억" / "3천만" / "50억9천만" → 숫자
// 단위를 조합해 적는 경우(억+천만 등)가 있어 전체를 한 번에 매치하지 않고
// 나오는 단위를 전부 더합니다.
function money(v) {
  const s = String(v ?? "").replace(/[\s,원]/g, "");
  if (!s) return null;
  let total = 0;
  let matched = false;
  const eok = /([\d.]+)억/.exec(s);
  if (eok) { total += Number(eok[1]) * 1e8; matched = true; }
  const cheonman = /([\d.]+)천만/.exec(s);
  if (cheonman) { total += Number(cheonman[1]) * 1e7; matched = true; }
  const baekman = /(?:^|[^천])([\d.]+)백만/.exec(s);
  if (baekman) { total += Number(baekman[1]) * 1e6; matched = true; }
  if (matched) return Math.round(total);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function int(v) {
  const n = Number(String(v ?? "").replace(/[\s,건]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 쉼표로만 나눕니다. 가운뎃점(·)은 나누는 기호가 아니라 "마케팅·홍보"
// "수출·해외진출" 같은 분야 이름 자체에 들어 있어, 그것까지 나누면
// 이름이 깨져 분야 일치 판정이 전부 틀어집니다.
function list(v) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 마크다운에서 "항목: 값" 을 뽑습니다. 설명문(들여쓴 줄)은 무시합니다. */
export function parseCompany(text) {
  const raw = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s/.test(line)) continue; // 들여쓴 줄은 설명입니다
    const m = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key) raw[key] = val;
  }

  const profile = {
    region: raw["소재지"] || "",
    founded: int(raw["설립연도"]),
    size: raw["기업규모"] || "",
    staff: int(raw["상시근로자"]),
    maxRecord: money(raw["최대단일실적"]),
    recordCount: int(raw["최근3년실적건수"]),
    recordAmount: money(raw["최근3년실적금액"]),
    fields: list(raw["주력분야"]),
    directProduce: list(raw["직접생산확인"]),
    licenses: list(raw["업종등록"]),
    certs: list(raw["인증"]),
    credit: (raw["신용등급"] || "").trim().toUpperCase(),
    // 참여인력 항목을 어떻게 볼지. 지금은 "만점" 하나뿐이고, 비면 미확인입니다.
    people: /만점/.test(raw["참여인력"] || "") ? "만점" : "",
  };

  // 몇 개나 채워졌는지 — 화면에서 "정보 부족" 안내를 띄우는 데 씁니다.
  profile.filled = Object.entries(profile).filter(([k, v]) => {
    if (k === "filled") return false;
    return Array.isArray(v) ? v.length > 0 : v !== null && v !== "";
  }).length;

  return profile;
}

/**
 * 실적DB 가 있으면 실적 숫자를 거기서 다시 셉니다.
 *
 * 손으로 적은 요약값보다 건별 원본이 정확하고, 무엇보다 둘이 어긋날 수가
 * 없습니다. 실적을 한 건 더하고 회사정보.md 의 숫자를 안 고치면 화면이
 * 거짓말을 하게 됩니다. 셀 수 있는 것은 세는 쪽이 낫습니다.
 * DB 가 없으면 손으로 적은 값을 그대로 씁니다.
 */
function withRecords(profile, records) {
  if (!records?.ok) return profile;
  return {
    ...profile,
    maxRecord: records.maxRecord || profile.maxRecord,
    recordCount: records.since(3).length,
    recordAmount: records.sum(3),
    recordsFrom: "실적DB",
  };
}

export async function loadCompany() {
  const records = await loadRecords().catch(() => null);
  try {
    return withRecords(parseCompany(await readFile(CONFIG, "utf8")), records);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // 처음 실행이면 예시 파일을 복사해 둡니다 — 어디에 적어야 하는지 보이도록.
  try {
    const sample = await readFile(SAMPLE, "utf8");
    await writeFile(CONFIG, sample, "utf8");
    console.log("[회사정보] config/회사정보.md 를 만들었습니다. 열어서 채우시면 예측점수가 정확해집니다.");
    return withRecords(parseCompany(sample), records);
  } catch {
    return withRecords(parseCompany(""), records);
  }
}
