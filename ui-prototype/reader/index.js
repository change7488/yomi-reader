import { parseEpubChapters, readEpubMetadata, validateEpub } from './epub-parser.js';
import { parseTextChapters } from './text-parser.js';

/** Format adapter boundary. Reader UI consumes a common chapter/block model. */
export async function parseReaderDocument(file, format, options = {}) {
  if (format === 'txt') {
    const buffer = await file.arrayBuffer();
    const bom = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 3));
    const detected = bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf ? 'utf-8'
      : bom[0] === 0xff && bom[1] === 0xfe ? 'utf-16le'
      : bom[0] === 0xfe && bom[1] === 0xff ? 'utf-16be' : '';
    const encoding = detected || options.encoding || 'utf-8';
    let text;
    try { text = new TextDecoder(encoding).decode(buffer); }
    catch { throw new Error(`当前环境不支持 ${encoding} 编码，请选择其他编码。`); }
    return { chapters: parseTextChapters(text, options.pattern), objectUrls: [], encoding };
  }
  if (format === 'epub') return parseEpubChapters(file);
  throw new Error(`暂不支持 ${format.toUpperCase()} 的流式章节解析`);
}

export async function readBookMetadata(file, format) {
  if (format === 'epub') return readEpubMetadata(file);
  return {};
}

export async function validateBookFile(file, format) {
  if (format === 'epub') return validateEpub(file);
  if (format === 'pdf') {
    const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (new TextDecoder().decode(signature) !== '%PDF-') throw new Error('PDF 文件头无效');
  }
  if (format === 'txt' && !file.size) throw new Error('TXT 文件为空');
}
