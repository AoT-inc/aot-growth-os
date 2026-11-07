// 화면에 보이지 않는 문자 검사. 사람이 보는 글과 실제로 나가는 글이 다르게 만드는 문자(태그 문자, 폭 없는 문자, 방향 제어, 변형 선택자 보충 등)를 찾는다.
// 서식 문자(Cf)·사용자 지정(Co)·미할당(Cn)과 U+E0100–E01EF 를 막되, 이모지·한글 등 글자 조합에 필요한 U+200C(ZWNJ)·U+200D(ZWJ)는 허용한다.
// 변형 선택자 U+FE0F 는 Mn 이라 막지 않는다.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u{E0100}-\u{E01EF}]/gu;

export function hasInvisibleText(text: string): boolean {
  for (const match of text.matchAll(INVISIBLE)) {
    if (match[0] !== '\u200c' && match[0] !== '\u200d') return true;
  }
  return false;
}
