// 해석기 지문 — "코드를 고쳤으면 판(VERSION)을 올렸는가"를 기계로 검사합니다.
//
// docs.mjs 의 VERSION 은 이미 읽은 공고를 다시 읽게 하는 유일한 스위치입니다.
// 해석 규칙을 고치고 판을 안 올리면, 새 규칙은 새 공고에만 적용되고 이미
// 읽은 공고는 옛 결과로 영영 남습니다. 조용히 틀리는 종류라 사람이 기억에
// 의존하면 반드시 빼먹습니다(실제로 두 번 빼먹었습니다). 그래서 추출에
// 영향을 주는 파일들의 해시를 analyzer-stamp.json 에 적어 두고, 자체점검이
// 다시 계산해 대조합니다. 다르면 실패하고, 고치는 법을 알려줍니다.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** 추출 결과(docs.json 에 저장되는 내용)에 영향을 주는 파일들 */
export const ANALYZER_FILES = [
  "../docs.mjs",
  "./require.mjs",
  "./doc.mjs",
  "./hwp.mjs",
  "./hwpx.mjs",
  "./docx.mjs",
  "./pdf.mjs",
  "./zip.mjs",
  "./cfb.mjs",
];

export async function analyzerHash() {
  const h = createHash("sha256");
  for (const f of ANALYZER_FILES) {
    h.update(f);
    h.update(await readFile(new URL(f, import.meta.url), "utf8"));
  }
  return h.digest("hex").slice(0, 16);
}
