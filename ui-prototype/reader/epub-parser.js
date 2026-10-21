import { dirname, openZipFile, resolveBookPath } from './archive.js';

const xml = text => new DOMParser().parseFromString(text, 'application/xml');
const xmlText = doc => doc.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim();
const mimeFor = path => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream');

async function packageInfo(zip) {
  const container = xml(new TextDecoder().decode(await zip.read('META-INF/container.xml')));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 缺少 OPF 书目信息');
  const opf = xml(new TextDecoder().decode(await zip.read(opfPath)));
  return { opfPath, opf, base: dirname(opfPath), items: [...opf.getElementsByTagName('item')] };
}

export async function validateEpub(file) {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new Error('EPUB 压缩包无效');
  const zip = await openZipFile(file);
  const { opfPath } = await packageInfo(zip);
  await zip.read(opfPath);
}

export async function readEpubMetadata(file) {
  const zip = await openZipFile(file), info = await packageInfo(zip);
  const { opf, base, items } = info;
  const title = xmlText(opf);
  const author = opf.getElementsByTagNameNS('*', 'creator')[0]?.textContent?.trim();
  let cover = items.find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (!cover) {
    const coverId = [...opf.getElementsByTagName('meta')].find(item => item.getAttribute('name') === 'cover')?.getAttribute('content');
    cover = items.find(item => item.getAttribute('id') === coverId);
  }
  let coverBlob = null;
  if (cover?.getAttribute('href')) {
    try { coverBlob = new Blob([await zip.read(resolveBookPath(base, cover.getAttribute('href')))], { type: cover.getAttribute('media-type') || mimeFor(cover.getAttribute('href')) }); }
    catch { /* EPUB cover is optional */ }
  }
  return { title, author, coverBlob };
}

async function collectToc(zip, info) {
  const { base, items } = info, titleByPath = new Map();
  const navItem = items.find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  if (navItem) {
    try {
      const navPath = resolveBookPath(base, navItem.getAttribute('href'));
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(await zip.read(navPath)), 'text/html');
      const nav = doc.querySelector('nav') || doc;
      nav.querySelectorAll('a[href]').forEach(anchor => {
        const title = anchor.textContent.trim(), href = anchor.getAttribute('href');
        if (!title || !href) return;
        let depth = 0, parent = anchor.closest('li')?.parentElement;
        while (parent && parent !== nav) { if (/^(ol|ul)$/i.test(parent.localName)) depth++; parent = parent.parentElement; }
        depth = Math.max(0, depth - 1);
        titleByPath.set(resolveBookPath(dirname(navPath), href), { title, depth });
      });
    } catch { /* malformed navigation: use spine headings */ }
  }
  const ncx = items.find(item => /ncx/i.test(item.getAttribute('media-type') || '') || /\.ncx(?:$|\?)/i.test(item.getAttribute('href') || ''));
  if (ncx && !titleByPath.size) {
    try {
      const ncxPath = resolveBookPath(base, ncx.getAttribute('href'));
      const doc = xml(new TextDecoder().decode(await zip.read(ncxPath)));
      [...doc.getElementsByTagName('navPoint')].forEach(point => {
        const title = point.querySelector('navLabel text')?.textContent.trim(), src = point.querySelector('content')?.getAttribute('src');
        if (title && src) titleByPath.set(resolveBookPath(dirname(ncxPath), src), { title, depth: 0 });
      });
    } catch { /* malformed NCX: use spine headings */ }
  }
  return titleByPath;
}

async function chapterBlocks(doc, chapterPath, zip, objectUrls) {
  const blocks = [], inline = [];
  const flush = () => {
    const value = inline.join('').replace(/\s+/g, ' ').trim(); inline.length = 0;
    if (value) blocks.push({ type: 'paragraph', value });
  };
  const walk = async node => {
    if (node.nodeType === Node.TEXT_NODE) { inline.push(node.nodeValue || ''); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName.toLowerCase();
    if (['script', 'style', 'nav', 'svg', 'noscript'].includes(tag)) return;
    if (tag === 'img') {
      flush();
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if (/^(?:https?:|data:|javascript:)/i.test(src)) return;
      try {
        const path = resolveBookPath(dirname(chapterPath), src), bytes = await zip.read(path);
        const blob = new Blob([bytes], { type: mimeFor(path) }), objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl); blocks.push({ type: 'image', src: objectUrl, alt: node.getAttribute('alt') || '' });
      } catch { /* missing illustration is omitted without breaking the chapter */ }
      return;
    }
    const block = /^(p|h[1-6]|blockquote|li|pre|figure|figcaption|section|div)$/.test(tag);
    if (block) flush();
    if (tag === 'br') { flush(); return; }
    for (const child of node.childNodes) await walk(child);
    if (block) flush();
  };
  await walk(doc.body);
  flush();
  return blocks;
}

export async function parseEpubChapters(file) {
  const zip = await openZipFile(file), info = await packageInfo(zip), titles = await collectToc(zip, info), objectUrls = [];
  const byId = new Map(info.items.map(item => [item.getAttribute('id'), item]));
  const chapters = [];
  for (const ref of [...info.opf.getElementsByTagName('itemref')]) {
    const item = byId.get(ref.getAttribute('idref'));
    if (!item?.getAttribute('href')) continue;
    try {
      const path = resolveBookPath(info.base, item.getAttribute('href'));
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(await zip.read(path)), 'text/html');
      const blocks = await chapterBlocks(doc, path, zip, objectUrls);
      if (!blocks.length) continue;
      const toc = titles.get(path);
      const headingBlock = blocks.find(block => block.type === 'paragraph' && /^\s*第.{0,30}[章节回卷部篇話话]|^(?:序章|序幕|终章|終章|尾声|番外|プロローグ|エピローグ)/.test(block.value));
      const title = toc?.title || headingBlock?.value || doc.querySelector('title')?.textContent.trim() || item.getAttribute('id') || `第 ${chapters.length + 1} 章`;
      if (headingBlock && headingBlock.value === title) blocks.splice(blocks.indexOf(headingBlock), 1);
      chapters.push({ id: item.getAttribute('id') || `epub-${chapters.length + 1}`, title, depth: toc?.depth || 0, blocks });
    } catch { /* skip malformed non-text spine items */ }
  }
  if (!chapters.length) throw new Error('没有找到可显示的 EPUB 正文');
  return { chapters, objectUrls };
}
