// config/제안분석/*.md 를 읽어 "제안서 분석" 화면에 실을 문서로 만듭니다.
//
// 왜 파일로 두는가:
//   제안 분석은 사람이 쓰거나 다른 도구가 만들어 옵니다. 화면에 박아 넣으면
//   한 건 늘 때마다 코드를 고쳐야 하고, 고치다 다른 공고 것을 건드립니다.
//   파일 하나 = 공고 하나로 두면 추가·삭제가 파일 조작이 됩니다.
//
// 파일 형식:
//   # 공고명
//
//   기관: ...
//   금액: 50000000        (숫자만. 쉼표·"원" 은 지웁니다)
//   마감: 2026-08-18
//   공고번호: ...          (있으면 이걸로 공고에 붙입니다. 없으면 제목으로)
//   출처: ...
//
//   ## 검토
//   - 치명 | 문서가 주장한 것 | 우리가 확인한 근거 | 바로잡은 값
//
//   ## 원문
//   (마크다운 본문 — 화면에 그대로 싣습니다)
import { readFile, readdir } from "node:fs/promises";

const DIR = new URL("../../../config/제안분석/", import.meta.url);

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 화면에 실을 만큼만 다루는 마크다운 → HTML. 링크·이미지·표는 쓰지 않습니다. */
export function miniMd(text) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push("</ul>"); list = null; } };
  const inline = (t) =>
    esc(t).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<b>$1</b>");

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { close(); out.push(`<h3>${inline(h[1])}</h3>`); continue; }
    const li = /^[-*·]\s+(.*)$/.exec(line);
    if (li) { if (!list) { out.push("<ul>"); list = 1; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    close();
    out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join("");
}

/** "50,000,000원" → 50000000. 못 읽으면 null. */
const won = (s) => {
  const n = String(s ?? "").replace(/[^\d]/g, "");
  return n ? Number(n) : null;
};

export function parseProposal(text, file = "") {
  const lines = String(text ?? "").split("\n");
  const doc = { file, title: "", org: "", budget: null, deadline: "", bidNo: "", source: "", findings: [], html: "" };
  const body = [];
  let section = "head";

  for (const raw of lines) {
    const line = raw.trim();
    if (/^#\s+/.test(line) && section === "head" && !doc.title) { doc.title = line.replace(/^#\s+/, "").trim(); continue; }
    if (/^##\s*검토/.test(line)) { section = "audit"; continue; }
    if (/^##\s*원문/.test(line)) { section = "body"; continue; }

    if (section === "head") {
      const m = /^(기관|금액|마감|공고번호|출처)\s*[:：]\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim();
      if (m[1] === "기관") doc.org = v;
      else if (m[1] === "금액") doc.budget = won(v);
      else if (m[1] === "마감") doc.deadline = v;
      else if (m[1] === "공고번호") doc.bidNo = v;
      else doc.source = v;
      continue;
    }

    if (section === "audit") {
      if (!/^[-*]\s+/.test(line)) continue;
      const cols = line.replace(/^[-*]\s+/, "").split("|").map((c) => c.trim());
      if (cols.length < 3) continue;
      const [impact, claim, evidence, correction = ""] = cols;
      // 등급은 셋뿐입니다. 오타로 색이 엉뚱하게 나가는 것보다 "사소" 로 떨어지는 편이 낫습니다.
      doc.findings.push({
        impact: ["치명", "중요", "사소"].includes(impact) ? impact : "사소",
        claim, evidence, correction,
      });
      continue;
    }

    body.push(raw);
  }

  doc.html = miniMd(body.join("\n"));
  return doc;
}

/** config/제안분석/ 의 문서를 전부 읽습니다. 폴더가 없으면 빈 배열입니다. */
export async function loadProposals(dir = DIR) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const n of names) {
    const text = await readFile(new URL(n, dir), "utf8");
    const doc = parseProposal(text, n);
    if (doc.title) out.push(doc);
  }
  return out;
}
