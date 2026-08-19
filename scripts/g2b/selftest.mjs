// 문서 해석기 자체 점검.
//
// 왜 필요한가:
//   HWP 해석기는 남의 라이브러리 없이 형식 문서만 보고 만들었습니다. 그런데
//   이 작업 환경에서는 나라장터에 접속할 수 없어 진짜 공고문으로 시험해 볼
//   수가 없습니다. 그래서 규격대로 HWP 파일을 직접 만들어 넣고, 넣은 내용이
//   그대로 나오는지 봅니다. 이러면 적어도 "껍데기를 여는 부분"과 "글자를
//   꺼내는 부분"이 맞는지는 확인됩니다.
//
//   확인되지 않는 것: 한컴이 실제로 쓰는 세부 관행. 그건 진짜 공고문으로만
//   알 수 있어서, 못 읽으면 못 읽었다고 말하도록 만들어 두었습니다.
//
// 사용법: node scripts\g2b\selftest.mjs
import { deflateRawSync, crc32 } from "node:zlib";
import { parseHwp } from "./lib/hwp.mjs";
import { openCfb } from "./lib/cfb.mjs";

const SEC = 512;
const MINI = 64;
const FREE = 0xffffffff;
const EOC = 0xfffffffe;
const FATSECT = 0xfffffffd;

/* ────────── HWP 기록 만들기 ────────── */

function record(tag, level, data) {
  const big = data.length >= 0xfff;
  const head = Buffer.alloc(big ? 8 : 4);
  head.writeUInt32LE((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : data.length) << 20), 0);
  if (big) head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

const utf16 = (s) => Buffer.from(s, "utf16le");

function paraRecords(text, level = 0) {
  return [record(66, level, Buffer.alloc(22)), record(67, level + 1, utf16(text))];
}

/** 표 하나를 기록들로. cells 는 [{row,col,text}] */
function tableRecords(rows, cols, cells, level = 1) {
  const ctrl = Buffer.alloc(4);
  // 컨트롤 종류는 파일에 거꾸로 들어갑니다.
  ctrl.write([..."tbl "].reverse().join(""), 0, "latin1");
  const out = [record(71, level, ctrl)];

  const tbl = Buffer.alloc(16);
  tbl.writeUInt32LE(0, 0);
  tbl.writeUInt16LE(rows, 4);
  tbl.writeUInt16LE(cols, 6);
  out.push(record(76, level + 1, tbl));

  for (const c of cells) {
    const lh = Buffer.alloc(32);
    lh.writeInt32LE(1, 0);
    lh.writeUInt32LE(0, 4);
    lh.writeUInt16LE(c.col, 8);
    lh.writeUInt16LE(c.row, 10);
    lh.writeUInt16LE(c.colSpan ?? 1, 12);
    lh.writeUInt16LE(c.rowSpan ?? 1, 14);
    out.push(record(72, level + 1, lh));
    out.push(...paraRecords(c.text, level + 2));
  }
  return out;
}

/* ────────── 복합 문서 껍데기 만들기 ────────── */

function buildCfb(streams) {
  // streams: [{ path, data }] — path 는 "FileHeader" 또는 "BodyText/Section0"
  const sectors = [];
  const addSectors = (buf) => {
    const start = sectors.length;
    for (let o = 0; o < buf.length; o += SEC) {
      const s = Buffer.alloc(SEC);
      buf.copy(s, 0, o, Math.min(buf.length, o + SEC));
      sectors.push(s);
    }
    return start;
  };

  const big = streams.filter((s) => s.data.length >= 4096);
  const small = streams.filter((s) => s.data.length < 4096);

  // 큰 스트림은 일반 구역에
  const placed = new Map();
  for (const s of big) placed.set(s.path, { start: addSectors(s.data), size: s.data.length });

  // 작은 스트림은 미니 구역에 모아서
  const miniParts = [];
  let miniIdx = 0;
  for (const s of small) {
    const need = Math.ceil(s.data.length / MINI) || 1;
    const chunk = Buffer.alloc(need * MINI);
    s.data.copy(chunk, 0);
    miniParts.push(chunk);
    placed.set(s.path, { start: miniIdx, size: s.data.length, mini: true });
    miniIdx += need;
  }
  const miniStream = Buffer.concat(miniParts);
  const miniStart = miniStream.length ? addSectors(miniStream) : EOC;

  // 미니 FAT — 미니 구역들의 사슬
  const miniFat = Buffer.alloc(SEC, 0xff);
  for (const s of small) {
    const p = placed.get(s.path);
    const need = Math.ceil(s.data.length / MINI) || 1;
    for (let i = 0; i < need; i += 1) {
      miniFat.writeUInt32LE(i === need - 1 ? EOC : p.start + i + 1, (p.start + i) * 4);
    }
  }
  const miniFatStart = addSectors(miniFat);

  // 디렉터리
  const order = ["Root Entry", "BodyText", "FileHeader", "Section0"];
  const dir = Buffer.alloc(SEC, 0);
  const put = (i, name, type, { left = FREE, right = FREE, child = FREE, start = 0, size = 0 }) => {
    const off = i * 128;
    const nb = Buffer.from(`${name}\0`, "utf16le");
    nb.copy(dir, off);
    dir.writeUInt16LE(nb.length, off + 64);
    dir[off + 66] = type;
    dir[off + 67] = 1;
    dir.writeUInt32LE(left, off + 68);
    dir.writeUInt32LE(right, off + 72);
    dir.writeUInt32LE(child, off + 76);
    dir.writeUInt32LE(start, off + 116);
    dir.writeBigUInt64LE(BigInt(size), off + 120);
  };
  const fh = placed.get("FileHeader");
  const sec0 = placed.get("BodyText/Section0");
  put(0, order[0], 5, { child: 1, start: miniStart, size: miniStream.length });
  put(1, order[1], 1, { right: 2, child: 3 });                       // BodyText 폴더
  put(2, order[2], 2, { start: fh.start, size: fh.size });           // FileHeader
  put(3, order[3], 2, { start: sec0.start, size: sec0.size });       // BodyText/Section0
  const dirStart = addSectors(dir);

  // FAT — 자기 자신도 구역을 차지하므로 몇 장이 필요한지 먼저 셉니다.
  // (한 장이 128 구역을 가리킵니다. 압축을 안 한 문서는 금방 넘깁니다)
  const dataSectors = sectors.length;
  let fatCount = 1;
  while (dataSectors + fatCount > fatCount * (SEC / 4)) fatCount += 1;
  const fatStart = dataSectors;

  const fat = Buffer.alloc(SEC * fatCount, 0xff);
  const setChain = (start, byteLen) => {
    const n = Math.max(1, Math.ceil(byteLen / SEC));
    for (let i = 0; i < n; i += 1) fat.writeUInt32LE(i === n - 1 ? EOC : start + i + 1, (start + i) * 4);
  };
  for (const s of big) setChain(placed.get(s.path).start, s.data.length);
  if (miniStream.length) setChain(miniStart, miniStream.length);
  setChain(miniFatStart, SEC);
  setChain(dirStart, SEC);
  for (let i = 0; i < fatCount; i += 1) fat.writeUInt32LE(FATSECT, (fatStart + i) * 4);
  for (let i = 0; i < fatCount; i += 1) sectors.push(fat.subarray(i * SEC, (i + 1) * SEC));

  const header = Buffer.alloc(SEC, 0);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);   // 구역 512
  header.writeUInt16LE(6, 32);   // 미니 구역 64
  header.writeUInt32LE(fatCount, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(1, 64);
  header.writeUInt32LE(EOC, 68);
  header.writeUInt32LE(0, 72);
  header.fill(0xff, 76, 512);
  if (fatCount > 109) throw new Error("점검용 파일이 너무 큽니다");
  for (let i = 0; i < fatCount; i += 1) header.writeUInt32LE(fatStart + i, 76 + i * 4);

  return Buffer.concat([header, ...sectors]);
}

function buildHwp(bodyRecords, { compress = true } = {}) {
  const fileHeader = Buffer.alloc(256);
  fileHeader.write("HWP Document File", 0, "latin1");
  fileHeader.writeUInt32LE(0x05000300, 32);
  fileHeader.writeUInt32LE(compress ? 1 : 0, 36);
  const body = Buffer.concat(bodyRecords);
  return buildCfb([
    { path: "FileHeader", data: fileHeader },
    { path: "BodyText/Section0", data: compress ? deflateRawSync(body) : body },
  ]);
}

/* ────────── 점검 ────────── */

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("[자체점검] 문서 해석기 (HWP · DOCX)\n");

// 진짜 공고문에 나오는 문장들로 만듭니다. 뽑아낸 뒤 require.mjs 가
// 이걸 실제로 알아보는지까지 봐야 의미가 있습니다.
const LINES = [
  "2026년 창업지원 행사 대행 용역 입찰공고",
  "가. 본 입찰은 공고일 전일부터 계약 체결일까지 본점의 소재지를 서울특별시로 하며 제한합니다.",
  "나. 기타자유업(행사대행업, 업종코드 9901)으로 등록을 필한 업체",
  "다. 최근 3년 이내 유사용역 1억5천만원 이상 수행실적을 보유한 업체",
  "※ 협상에 의한 계약 배점은 기술능력평가",
  "90 점 (정량적 평가 20, 정성적 평가 70 점 ), 입찰가격평가 10 점임",
  "신인도 가점: 여성기업 2점, 벤처기업 1점, 이노비즈 1점을 가점한다.",
];
// 큰 문서에서도 되는지 보려고 부풀립니다(일반 구역 사슬을 타게 됩니다).
const filler = Array.from({ length: 3000 }, (_, i) => `제${i}조 세부 과업 내용은 과업지시서에 따른다.`);

const body = [
  ...LINES.flatMap((l) => paraRecords(l)),
  ...filler.flatMap((l) => paraRecords(l)),
  ...tableRecords(4, 2, [
    { row: 0, col: 0, text: "평가항목" },
    { row: 0, col: 1, text: "배점" },
    { row: 1, col: 0, text: "사업수행능력" },
    { row: 1, col: 1, text: "40" },
    { row: 2, col: 0, text: "사업이해도" },
    { row: 2, col: 1, text: "35" },
    { row: 3, col: 0, text: "신인도" },
    { row: 3, col: 1, text: "15" },
  ]),
  ...paraRecords("이상 끝."),
];

// ① 압축된 문서
{
  const buf = buildHwp(body);
  const r = parseHwp(buf);
  check("압축 문서를 읽는다", r.ok, r.note);
  for (const l of LINES) {
    check(`문장이 그대로 나온다: ${l.slice(0, 22)}…`, r.text.includes(l));
  }
  check("표를 1개 찾는다", r.tables.length === 1, `${r.tables.length}개`);
  const g = r.tables[0]?.grid ?? [];
  check("표 크기 4행 2열", g.length === 4 && g[0]?.length === 2, `${g.length}행 ${g[0]?.length}열`);
  check("표 내용이 맞다", g[3]?.[0] === "신인도" && g[3]?.[1] === "15", JSON.stringify(g));
  check("큰 문서도 끝까지 읽는다", r.text.includes("제2999조"));
  check("본문 끝이 잘리지 않는다", r.text.includes("이상 끝."));
}

// ② 압축 안 한 문서
{
  const r = parseHwp(buildHwp(body, { compress: false }));
  check("압축 안 된 문서도 읽는다", r.ok && r.text.includes("이상 끝."), r.note);
}

// ③ 뽑은 글자를 require.mjs 가 실제로 알아보는가 — 여기까지 돼야 값이 있습니다
{
  const { extractRequirements } = await import("./lib/require.mjs");
  const r = parseHwp(buildHwp(body));
  const req = extractRequirements(r.text, r.tables);
  check("지역제한을 찾는다", req.region?.value === "서울특별시", JSON.stringify(req.region));
  check("업종을 찾는다", req.industry.some((i) => i.value.includes("9901")), JSON.stringify(req.industry));
  check("실적요건을 찾는다", req.record?.amount === 150000000, JSON.stringify(req.record));
  check("배점을 찾는다", req.rate?.tech === 90 && req.rate?.price === 10, JSON.stringify(req.rate));
  check("배점표를 찾는다", req.scoreTable?.items?.length === 3, JSON.stringify(req.scoreTable?.items));
  check(
    "신인도 인증을 찾는다",
    ["여성기업", "벤처기업", "이노비즈"].every((t) => req.credits.some((c) => c.term === t)),
    JSON.stringify(req.credits.map((c) => c.term))
  );
}

// ④ 이상한 파일을 조용히 통과시키지 않는가
{
  check("HWP 가 아니면 거절한다", !parseHwp(Buffer.alloc(600)).ok);
  const notHwp = buildCfb([
    { path: "FileHeader", data: Buffer.alloc(256) },
    { path: "BodyText/Section0", data: Buffer.alloc(8000) },
  ]);
  check("서명이 없으면 거절한다", !parseHwp(notHwp).ok);
}

// ⑤ 껍데기 자체
{
  const cfb = openCfb(buildHwp(body));
  check("스트림 목록이 맞다", cfb.has("FileHeader") && cfb.has("BodyText/Section0"), cfb.names().join(", "));
}

/* ────────── DOCX ────────── */

/** 아주 작은 ZIP 쓰기(무압축). zip.mjs 읽기까지 같이 확인됩니다. */
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

{
  const { parseDocx } = await import("./lib/docx.mjs");
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>2026년 창업지원 행사 대행 용역 입찰공고</w:t></w:r></w:p>
    <w:p><w:r><w:t>나. 기타자유업(행사대행업, 업종코드 9901)으로 등록을 필한 업체</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>평가항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>배점</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>사업수행능력</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>60</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>신인도</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>이상 끝.</w:t></w:r></w:p>
  </w:body></w:document>`;
  const buf = buildZip([{ name: "word/document.xml", data: xml }]);
  const r = parseDocx(buf);
  check("DOCX 를 읽는다", r.ok, r.note);
  check("DOCX 문장이 나온다", r.text.includes("업종코드 9901") && r.text.includes("이상 끝."));
  check("DOCX 표를 찾는다", r.tables[0]?.grid?.length === 3, JSON.stringify(r.tables[0]?.grid));
  const req = (await import("./lib/require.mjs")).extractRequirements(r.text, r.tables);
  check("DOCX 배점표를 알아본다", req.scoreTable?.items?.length === 2, JSON.stringify(req.scoreTable?.items));
}

/* ⑥ 심사표 항목 분류 — 교차 검증에서 확인된 결함 세 가지를 그대로 시험합니다.
   전에는 2열짜리 표만 시험해서 이 경우들을 하나도 못 잡았습니다(통과 27인데
   무의미했습니다). 실제 협상에의한계약 심사표는 "세부 배점기준" 열이 붙고
   소계·합계 행이 들어갑니다. */
{
  const { extractRequirements } = await import("./lib/require.mjs");
  const { selfScore } = await import("./lib/selfscore.mjs");

  const grid = [
    ["평가부문", "평가항목", "배점", "세부 배점기준"],
    ["정량적 평가", "유사용역 수행실적", "10", "최근 3년간 5억원 이상 10점, 3억원 이상 8점, 1억원 이상 6점"],
    ["정량적 평가", "참여인력 구성", "15", "참여인력의 동종 용역 수행실적 및 자격증 보유 현황"],
    ["정량적 평가", "경영상태", "10", "기업신용평가등급 AAA 이상 만점 · 최근 3년 경영실적 반영"],
    ["정량적 평가", "지역업체 참여도", "5", "관내 소재 업체 참여 시 가점"],
    ["정량적 평가", "신인도", "5", "최근 3년간 계약이행 실적 관련 제재 없을 것"],
    ["정량적 평가", "소 계", "45", ""],
    ["정성적 평가", "사업이해도 및 제안내용의 적정성", "45", ""],
    ["가격", "입찰가격", "10", ""],
    ["합 계", "합 계", "100", ""],
  ];
  const req = extractRequirements("", [{ grid }]);
  const kinds = Object.fromEntries((req.scoreTable?.items ?? []).map((i) => [i.name.split(" / ").pop(), i.kind]));

  check("세부기준의 '경영실적' 에 끌려가지 않는다", kinds["경영상태"] === "경영", JSON.stringify(kinds["경영상태"]));
  check("세부기준의 '수행실적' 에 끌려가지 않는다", kinds["참여인력 구성"] === "인력", JSON.stringify(kinds["참여인력 구성"]));
  check("세부기준의 '실적' 에 끌려가지 않는다(신인도)", kinds["신인도"] === "신인도", JSON.stringify(kinds["신인도"]));
  check("'가점' 이 붙어도 지역은 지역이다", kinds["지역업체 참여도"] === "지역", JSON.stringify(kinds["지역업체 참여도"]));
  check("실적 항목은 실적이다", kinds["유사용역 수행실적"] === "실적", JSON.stringify(kinds["유사용역 수행실적"]));
  check("정성·가격도 제자리", kinds["입찰가격"] === "가격" && kinds["사업이해도 및 제안내용의 적정성"] === "정성",
        JSON.stringify([kinds["입찰가격"], kinds["사업이해도 및 제안내용의 적정성"]]));
  check("소계·합계 행은 항목이 아니다", (req.scoreTable?.items ?? []).length === 7, `${req.scoreTable?.items?.length}개`);
  check("총점이 부풀지 않는다", req.scoreTable?.total === 100, `${req.scoreTable?.total}`);

  // 자가채점까지 이어서 — 채점 못하는 항목이 실적으로 지어내지지 않아야 합니다.
  const company = { region: "서울특별시", maxRecord: 8e8, certs: ["벤처기업"], directProduce: ["기타행사기획및대행서비스"] };
  const s = selfScore({ scoreTable: req.scoreTable, credits: [{ term: "여성기업" }, { term: "벤처기업" }, { term: "직접생산확인" }], region: null, directItems: null }, company, 3e8);
  check("채점 대상은 실적·신인도뿐 (지역은 요구지역 미상이라 제외)", s.max === 15, `max=${s.max}`);
  // 인력 15 + 경영 10 + 지역 5(요구 지역을 못 읽었으므로) = 30.
  // 지역도 미확인으로 가는 것이 맞습니다 — 어디를 요구하는지 모르면 채점할 수 없습니다.
  check("채점 못하는 항목은 미확인으로 빠진다", s.unknown === 30, `unknown=${s.unknown}`);
  check("실적은 등급표대로 만점", s.items.find((i) => i.kind === "실적")?.got === 10,
        JSON.stringify(s.items.find((i) => i.kind === "실적")));
  check("신인도는 보유 비율", Math.abs((s.items.find((i) => i.kind === "신인도")?.got ?? 0) - 3.3) < 0.1,
        JSON.stringify(s.items.find((i) => i.kind === "신인도")));
}

/* ⑦ 실적DB — 건별 실적을 실제로 세는지, 건수 등급을 읽는지. */
{
  const { loadRecords } = await import("./lib/records.mjs");
  const { parseCountTiers, parseYears, extractRequirements } = await import("./lib/require.mjs");
  const { selfScore } = await import("./lib/selfscore.mjs");

  const r = await loadRecords();
  check("실적DB 를 읽는다", r.ok && r.count > 0, `${r.count}건`);
  check("최대단일실적을 찾는다", r.maxRecord > 0, `${(r.maxRecord / 1e8).toFixed(1)}억`);
  check("금액 요건별 건수를 센다", r.countAtLeast(1e8, 3) <= r.since(3).length,
        `1억 이상 ${r.countAtLeast(1e8, 3)}건 / 최근3년 ${r.since(3).length}건`);
  check("분야별 건수를 센다", ["행사·교육", "창업지원"].some((g) => r.fieldCount(g, 3) > 0),
        `행사·교육 ${r.fieldCount("행사·교육", 3)} · 창업지원 ${r.fieldCount("창업지원", 3)}`);

  check("건수 등급을 읽는다",
    JSON.stringify(parseCountTiers("최근 3년간 유사용역 3건 이상 10점, 2건 이상 8점, 1건 이상 6점"))
      === JSON.stringify([{min:3,score:10},{min:2,score:8},{min:1,score:6}]),
    JSON.stringify(parseCountTiers("최근 3년간 유사용역 3건 이상 10점, 2건 이상 8점, 1건 이상 6점")));
  check("등급이 아닌 문장은 안 읽는다", parseCountTiers("참여인력 3건 이상 경력").length === 0);
  check("기간을 읽는다", parseYears("최근 5년간 실적") === 5);

  // 건수 등급이 있는 심사표로 끝까지
  const grid = [
    ["평가항목", "배점", "세부 배점기준"],
    ["유사용역 수행실적", "20", "최근 3년간 1억원 이상 실적 3건 이상 20점, 2건 이상 15점, 1건 이상 10점"],
    ["사업이해도", "70", ""],
    ["입찰가격", "10", ""],
  ];
  const req = extractRequirements("", [{ grid }]);
  const item = req.scoreTable.items.find((i) => i.kind === "실적");
  check("실적 항목의 건수 등급이 붙는다", item?.countTiers?.length === 3, JSON.stringify(item?.countTiers));
  check("금액 문턱도 같이 읽는다", item?.countAmount === 1e8, String(item?.countAmount));
  check("기간도 같이 읽는다", item?.years === 3, String(item?.years));

  const company = { region: "서울특별시", maxRecord: r.maxRecord, certs: [], directProduce: [] };
  const s = selfScore({ scoreTable: req.scoreTable, credits: [], region: null, directItems: null }, company, 3e8, r);
  const got = s.items.find((i) => i.kind === "실적");
  const have = r.countAtLeast(1e8, 3);
  const want = have >= 3 ? 20 : have >= 2 ? 15 : have >= 1 ? 10 : 0;
  check("건수로 채점한다", got?.got === want, `${got?.got}점 (1억 이상 ${have}건 → ${want}점 이어야 함) · ${got?.why}`);
  check("근거에 실제 건수가 적힌다", /\d+건/.test(got?.why ?? ""), got?.why);
}

/* ⑧ 키워드 설정 — 안내문이 키워드로 새어 들어가지 않는지.
      g2b-keywords.md 는 설명과 항목이 한 파일에 섞여 있습니다. 설명 한 줄이
      키워드 목록에 섞이면 조용히 잘못된 판정을 하므로 여기서 막습니다. */
{
  const { loadKeywords, matchGroups, excludedBy } = await import("./lib/keywords.mjs");
  const cfg = await loadKeywords();
  const all = [...Object.values(cfg.groups).flat(), ...cfg.exclude, ...cfg.allow, ...cfg.kwAllow];
  const 긴것 = all.filter((w) => w.length > 20);
  const 설명 = all.filter((w) => /^(예|참고|주의)\s*[:：]/.test(w) || / .* .* /.test(w));
  check("설명문이 항목으로 새지 않는다", 긴것.length === 0 && 설명.length === 0,
        [...긴것, ...설명].join(" | "));
  check("여섯 분야가 다 있다", Object.keys(cfg.groups).length === 6, Object.keys(cfg.groups).join(","));

  // 실제로 문제였던 판정들이 지금도 맞는지 (문서 docs/키워드-기준.md 의 근거)
  const g = (t) => matchGroups({ title: t }, cfg);
  const ex = (t) => excludedBy({ title: t }, cfg);
  check("수집 예외: 직무역량 안의 무역은 무시한다", !g("직무역량 강화 교육 용역").includes("수출·해외진출"),
        g("직무역량 강화 교육 용역").join(","));
  check("진짜 무역 공고는 그대로 잡는다", g("무역사절단 파견 대행 용역").includes("수출·해외진출"));
  check("우선순위: 수출이 마케팅보다 먼저", g("수출마케팅 협력사업(무역사절단)")[0] === "수출·해외진출",
        g("수출마케팅 협력사업(무역사절단)").join(","));
  check("제외 예외: 기관명 안의 공사는 봐준다", !ex("한국도로공사 SNS 홍보 용역").includes("공사"),
        ex("한국도로공사 SNS 홍보 용역").join(","));
  check("진짜 공사는 그대로 막는다", ex("청사 리모델링 공사").includes("공사"));
  check("제외 해제: 창업 맥락의 제작은 살린다", !ex("로컬창업 아이디어 시제품 제작 지원").includes("제작"),
        ex("로컬창업 아이디어 시제품 제작 지원").join(","));
  check("맥락 없는 제작은 그대로 막는다", ex("기관 홍보 브로슈어 제작 용역").includes("제작"));
}

/* ⑨ 마크다운 → 워드. 우리가 만든 .docx 를 우리 docx 읽기로 되읽어 봅니다.
      워드는 XML 안의 순서가 규격과 다르면 "읽을 수 없는 내용"이라며 열지
      않습니다. 눈으로는 안 보이는 종류라 여기서 순서를 검사합니다. */
{
  const { mdToDocx } = await import("../md-to-docx.mjs");
  const { parseDocx } = await import("./lib/docx.mjs");
  const md = [
    "# 제목", "", "본문 **굵게** 와 `코드` 가 든 문단.", "",
    "- 첫째", "- 둘째", "", "1. 하나", "2. 둘", "",
    "| 항목 | 값 |", "|---|---|", "| 실적 | 20 |", "",
    "```", "코드 줄", "```",
  ].join("\n");
  const buf = mdToDocx(md);
  const r = parseDocx(buf);
  check("워드 파일이 다시 읽힌다", r.ok && r.text.includes("제목"), r.note ?? "");
  check("굵게·코드가 한 문단으로 붙는다", r.text.includes("본문 굵게 와 코드 가 든 문단."),
        JSON.stringify(r.text.split("\n").find((l) => l.includes("본문"))));
  check("표가 살아 있다", r.tables[0]?.grid?.[1]?.join("/") === "실적/20",
        JSON.stringify(r.tables[0]?.grid));

  // 규격 순서 검사 — 워드가 파일을 여는지 여부가 여기 달려 있습니다.
  const { readZipText } = await import("./lib/zip.mjs");
  const doc = readZipText(buf, "word/document.xml");
  const PPR = ["keepNext","numPr","pBdr","shd","spacing","ind","jc"];
  const RPR = ["rFonts","b","color","sz","szCs","shd"];
  const ordered = (tag, order) => {
    for (const m of doc.matchAll(new RegExp(`<w:${tag}>(.*?)</w:${tag}>`, "gs"))) {
      const flat = m[1].replace(/<w:(pBdr|numPr)>.*?<\/w:\1>/gs, "");
      const kids = [...flat.matchAll(/<w:([a-zA-Z]+)[ />]/g)].map((k) => k[1]).filter((k) => order.includes(k));
      for (let k = 1; k < kids.length; k += 1)
        if (order.indexOf(kids[k - 1]) > order.indexOf(kids[k])) return `${kids[k - 1]}→${kids[k]}`;
    }
    return null;
  };
  check("문단 속성이 규격 순서다", ordered("pPr", PPR) === null, ordered("pPr", PPR) ?? "");
  check("글자 속성이 규격 순서다", ordered("rPr", RPR) === null, ordered("rPr", RPR) ?? "");
  check("번호 목록이 1부터 다시 센다", /w:numId w:val="2"/.test(doc) && !/w:numId w:val="3"/.test(doc));
}

/* ⑩ 제안 분석 문서 — 사람이 쓴 파일이라 형식이 흔들립니다.
      머리말·검토표·원문 세 구역이 각각 제자리로 들어가는지 봅니다. */
{
  const { parseProposal, miniMd, loadProposals } = await import("./lib/proposals.mjs");
  // 심사표 항목 분류 — 제안서를 읽고 매기는 항목이 "기타"로 떨어지면
  // 화면이 "채점 못한 정량"이라고 사실과 다른 말을 합니다.
  {
    const { extractRequirements } = await import("./lib/require.mjs");
    const grid = [
      ["평가항목", "배점", "세부기준"],
      ["기술능력(개발·제작·구현 가능성)", "25", ""],
      ["유사용역실적", "20", "최근 3년 1억 이상 3건 이상 20점"],
      ["사업수행능력", "10", "경영상태·인력 종합"],
      ["입찰가격", "45", ""],
    ];
    const t = extractRequirements("", [{ grid }]).scoreTable;
    const kind = (n) => t.items.find((i) => i.name.startsWith(n))?.kind;
    check("기술능력은 정성으로 분류한다", kind("기술능력") === "정성", kind("기술능력"));
    check("사업수행능력은 정성으로 끌려가지 않는다", kind("사업수행능력") !== "정성", kind("사업수행능력"));
    check("실적·가격 분류는 그대로", kind("유사용역실적") === "실적" && kind("입찰가격") === "가격",
          `${kind("유사용역실적")}/${kind("입찰가격")}`);
  }
  const d = parseProposal([
    "# 시험 공고명",
    "",
    "기관: 한라대학교 (총무처)",
    "금액: 50,000,000원 (부가세 포함)",
    "마감: 2026-08-18",
    "공고번호: 20260800123",
    "출처: 외부 도구",
    "",
    "## 검토",
    "- 치명 | 기관을 잘못 붙였다 | 033 은 강원이다 | 원주 한라대학교",
    "- 몰라 | 등급 오타 | 근거",
    "- 형식이 틀린 줄",
    "",
    "## 원문",
    "## 요약",
    "- 첫째 **굵게**",
    "본문 문단.",
  ].join("\n"), "t.md");

  check("제목·기관을 읽는다", d.title === "시험 공고명" && d.org === "한라대학교 (총무처)", `${d.title} / ${d.org}`);
  check("금액에서 숫자만 뽑는다", d.budget === 50000000, String(d.budget));
  check("마감·공고번호를 읽는다", d.deadline === "2026-08-18" && d.bidNo === "20260800123");
  check("검토표를 읽는다", d.findings.length === 2, `${d.findings.length}건`);
  check("등급 오타는 사소로 떨어진다", d.findings[1].impact === "사소", d.findings[1].impact);
  check("바로잡은 값이 붙는다", d.findings[0].correction === "원주 한라대학교", d.findings[0].correction);
  check("원문만 본문이 된다", /<h3>요약<\/h3>/.test(d.html) && !/검토/.test(d.html), d.html.slice(0, 60));
  check("굵게가 살아난다", /<b>굵게<\/b>/.test(d.html));
  // 머리말이 본문으로 새면 화면에 "기관: ..." 이 두 번 나옵니다.
  check("머리말이 본문으로 새지 않는다", !/기관/.test(d.html), d.html.slice(0, 80));
  check("태그를 이스케이프한다", miniMd("<script>x</script>").includes("&lt;script&gt;"));
  check("폴더가 없어도 죽지 않는다", (await loadProposals(new URL("no-such-dir/", import.meta.url))).length === 0);
}

/* ⑪ 화면 틀 — 제안서 분석 화면이 붙어 있는지. 사람이 손으로 고치다
      한쪽만 지우면 메뉴는 있는데 화면이 없는 상태가 됩니다. */
{
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../../g2b.html", import.meta.url), "utf8");
  check("제안서 분석 메뉴가 있다", /data-view="prop"/.test(html));
  check("제안서 분석 화면이 있다", /id="view-prop"/.test(html));
  check("메뉴와 화면의 이름이 맞다", /titles=\{[^}]*prop:/.test(html));
  check("점수 배지를 누르면 갈 수 있다", /data-prop=/.test(html) && /window\.showView/.test(html));
  check("데이터 마커가 살아 있다", html.includes("<!--G2B_DATA_START-->") && html.includes("<!--G2B_DATA_END-->"));
}

console.log(`\n[자체점검] 통과 ${pass} · 실패 ${fail}`);
if (fail) process.exitCode = 1;
