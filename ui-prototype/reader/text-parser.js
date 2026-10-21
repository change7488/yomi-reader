/** TXT adapter: turns raw lines into a stable chapter/block document model. */
export const DEFAULT_CHAPTER_PATTERN = String.raw`^\s*(?:第\s*[0-9零〇一二三四五六七八九十百千万两廿卅]+\s*[章节回卷部篇話话].{0,48}|(?:序章|序幕|序言|终章|終章|尾声|終話|后记|後記|番外(?:篇|編)?(?:第.{1,8})?|楔子|引子|幕间|幕間|插章|间章|閑話|プロローグ|エピローグ|前書き|あとがき)|(?:chapter|ch\.?)\s+(?:[0-9ivxlcdm]+|one|two|three)\b.{0,70}|(?:prologue|epilogue|interlude|afterword|foreword)\b.*)\s*$`;

export function toParagraphs(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = source.split(/\n\s*\n+/).map(s => s.replace(/[\t\u3000 ]+/g, ' ').trim()).filter(Boolean);
  if (blocks.length === 1 && source.includes('\n')) return source.split('\n').map(s => s.replace(/[\t\u3000 ]+/g, ' ').trim()).filter(Boolean);
  return blocks;
}

function paragraphRecords(lines) {
  const groups = []; let group = [];
  for (const line of lines) {
    if (!line.value.trim()) { if (group.length) groups.push(group); group = []; }
    else group.push(line);
  }
  if (group.length) groups.push(group);
  const records = groups.length === 1 && lines.length > 1
    ? lines.filter(line => line.value.trim()).map(line => [line])
    : groups;
  return records.map(rows => {
    const raw = rows.map(row => row.value).join('\n');
    const value = raw.replace(/[\t\u3000 ]+/g, ' ').trim();
    const leading = raw.search(/\S|$/);
    return value ? { value, sourceOffset: rows[0].sourceOffset + Math.max(0, leading) } : null;
  }).filter(Boolean);
}

function sourceLines(text) {
  const original = String(text || ''), bomOffset = original.startsWith('\uFEFF') ? 1 : 0, source = original.slice(bomOffset), lines = [];
  let start = 0;
  for (let index = 0; index <= source.length; index++) {
    if (index !== source.length && source[index] !== '\n' && source[index] !== '\r') continue;
    lines.push({ value: source.slice(start, index), sourceOffset: start + bomOffset });
    if (index === source.length) break;
    if (source[index] === '\r' && source[index + 1] === '\n') index++;
    start = index + 1;
  }
  return lines;
}

export function parseTextChapters(text, pattern = DEFAULT_CHAPTER_PATTERN) {
  const lines = sourceLines(text);
  const headingRegex = new RegExp(pattern || DEFAULT_CHAPTER_PATTERN, 'i');
  const cuts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].value.trim();
    if (line && line.length < 90 && headingRegex.test(line)) cuts.push({ line: i, title: line });
  }
  if (!cuts.length) return [{ id: 'body', title: '正文', blocks: paragraphRecords(lines).map(record => ({ type: 'paragraph', ...record })) }];
  const chapters = [];
  if (cuts[0].line > 0) {
    const lead = paragraphRecords(lines.slice(0, cuts[0].line));
    if (lead.length) chapters.push({ id: 'intro', title: '前言', blocks: lead.map(record => ({ type: 'paragraph', ...record })) });
  }
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1].line : lines.length;
    const body = paragraphRecords(lines.slice(cuts[i].line + 1, end));
    if (body.length) chapters.push({ id: `txt-${i + 1}`, title: cuts[i].title, blocks: body.map(record => ({ type: 'paragraph', ...record })) });
  }
  return chapters;
}
