// 시험용 메일 디코더: 렌더링된 RFC 5322 메시지를 받는 쪽처럼 읽는다 (헤더 펼치기, RFC 2047 B 제목, base64 본문).
export interface DecodedMail {
  headers: Map<string, string>;
  /** 헤더 이름 순서와 접힌 원문 줄 (펼치기 전) */
  headerLines: string[];
  subject: string;
  /** 본문 디코드 결과: \r\n 을 \n 으로 되돌린 글 */
  text: string;
}

export function decodeMail(raw: string): DecodedMail {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('no header/body separator');
  const headerBlock = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const headerLines = headerBlock.split('\r\n');
  const unfolded: string[] = [];
  for (const line of headerLines) {
    if (/^[ \t]/.test(line)) unfolded[unfolded.length - 1] += line;
    else unfolded.push(line);
  }
  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon), line.slice(colon + 1).replace(/^[ \t]+/, ''));
  }
  const subjectRaw = headers.get('Subject') ?? '';
  // encoded-word 사이의 공백은 무시한다 (RFC 2047 §6.2)
  const subject = /^=\?UTF-8\?B\?/.test(subjectRaw)
    ? subjectRaw.split(/(?<=\?=)[ \t]+(?==\?)/).map((word) => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(word);
      if (m === null) throw new Error(`bad encoded-word: ${word}`);
      return Buffer.from(m[1]!, 'base64');
    }).reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0)).toString('utf8')
    : subjectRaw;
  const text = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
  return { headers, headerLines, subject, text };
}
