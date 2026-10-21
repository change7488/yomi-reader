// Shared font library for Electron and Capacitor.
// Built-in fonts are verified, licensed assets installed by scripts/sync-fonts.mjs.
// Imported fonts live only in IndexedDB; they are never uploaded.
import { BUILTIN_FONTS } from './catalog.js';

const MAX_FONT_SIZE = 16 * 1024 * 1024;
const MAX_CUSTOM_FONTS = 40;
const SYSTEM_STACK = 'Georgia, "Noto Serif SC", "Microsoft YaHei", serif';
const FILE_TYPES = {
  ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2'
};
const FALLBACK_NAME = '跟随系统';
const FONT_EXAMPLE = '让阅读回到文字本身，山川星河皆入书。';

export function isSupportedFont(fileName, header) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  if (!(ext in FILE_TYPES)) return false;
  const bytes = new Uint8Array(header);
  if (bytes.length < 4) return false;
  const sig = [...bytes.slice(0, 4)];
  const magic = String.fromCharCode(...sig);
  return (ext === 'ttf' && sig[0] === 0 && sig[1] === 1 && sig[2] === 0 && sig[3] === 0)
    || (ext === 'otf' && magic === 'OTTO')
    || (ext === 'woff' && magic === 'wOFF')
    || (ext === 'woff2' && magic === 'wOF2');
}
export function fontOptionLabel(font) {
  return `${font.name}${font.coverage && font.coverage < 8000 ? ' · 部分中文字符回退系统字体' : ''}`;
}
export function safeFontId(id) {
  return typeof id === 'string' && /^(?:built:[a-z0-9-]+|user:[a-f0-9-]{36}|system)$/.test(id) ? id : 'system';
}
export function formatFontSize(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function createFontManager({ all, put, dbRequest, toast }) {
  const installed = new Map();
  const activeLoads = new Map();
  const custom = new Map();
  const panels = [];
  let defaultId = 'system';
  let readerSelection = 'system';
  let readerOnSelect = null;
  let filePicker = null;
  let ready = false;

  function list() {
    return [
      { id: 'system', name: FALLBACK_NAME, description: '使用当前设备提供的字体', category: 'novel', bytes: 0, cjk: true },
      ...BUILTIN_FONTS.map(f => ({ ...f, id: 'built:' + f.id })),
      ...[...custom.values()].map(f => ({
        id: f.id, name: f.name, description: '本地导入 · 仅本机保存',
        category: 'custom', bytes: f.size, cjk: true
      }))
    ];
  }
  function metadata(id) { return list().find(x => x.id === id); }
  function resolvedId(id) { const value = safeFontId(id || defaultId); return metadata(value) ? value : 'system'; }
  function faceName(id) { return 'YomiFont_' + resolvedId(id).replace(/[^a-z0-9]/gi, '_'); }
  function cssFamily(id) {
    const value = resolvedId(id);
    return value === 'system' ? SYSTEM_STACK : `"${faceName(value)}", ${SYSTEM_STACK}`;
  }
  async function ensure(id) {
    const value = resolvedId(id);
    if (value === 'system') return true;
    if (installed.has(value)) return true;
    if (activeLoads.has(value)) return activeLoads.get(value);
    const load = (async () => {
      const built = value.startsWith('built:');
      const meta = built ? BUILTIN_FONTS.find(f => 'built:' + f.id === value) : custom.get(value);
      if (!meta) throw new Error('字体已被移除，请重新选择');
      const url = built ? new URL('./builtin/' + meta.file, import.meta.url).href
        : URL.createObjectURL(meta.blob);
      try {
        const face = new FontFace(faceName(value), `url("${url}")`, { style: 'normal', weight: 'normal', display: 'swap' });
        await face.load();
        document.fonts.add(face);
        installed.set(value, face);
        return true;
      } finally {
        if (!built) URL.revokeObjectURL(url);
      }
    })();
    activeLoads.set(value, load);
    try { return await load; }
    finally { activeLoads.delete(value); }
  }
  function applyToStage(stage, id) {
    const actual = resolvedId(id);
    stage.style.fontFamily = cssFamily(actual);
  }
  async function initialize() {
    const rows = await all('customFonts');
    rows.forEach(row => custom.set(row.id, row));
    try {
      const pref = await dbRequest('settings', 'readonly', s => s.get('defaultReaderFont'));
      defaultId = resolvedId(pref?.value);
    } catch (error) {
      console.warn('读取默认字体失败', error);
    }
    ready = true;
    refresh();
  }
  async function installFontFile(file) {
    if (!file || file.size < 12 || file.size > MAX_FONT_SIZE) {
      throw new Error('字体文件必须小于 16 MB 且不能为空');
    }
    if (custom.size >= MAX_CUSTOM_FONTS) throw new Error('最多可保存 40 款自定义字体');
    if (!isSupportedFont(file.name, await file.slice(0, 4).arrayBuffer())) {
      throw new Error('文件不是有效的 TTF / OTF / WOFF / WOFF2 字体');
    }
    const binary = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', binary))]
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const previous = [...custom.values()].find(f => f.hash === hash);
    if (previous) return { id: previous.id, duplicate: true };
    const name = String(file.name).replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[\\/<>]/g, '').slice(0, 60) || '自定义字体';
    const entry = {
      id: 'user:' + crypto.randomUUID(), name, size: file.size,
      hash, blob: new Blob([binary], { type: 'font/' + file.name.split('.').pop().toLowerCase() }),
      createdAt: Date.now()
    };
    await put('customFonts', entry);
    custom.set(entry.id, entry);
    refresh();
    return { id: entry.id, duplicate: false };
  }
  async function importFiles(files) {
    if (!files || !files.length) return;
    let successful = 0, repeated = 0, failed = 0, last = null;
    for (const file of files) {
      try {
        const result = await installFontFile(file);
        if (result.duplicate) repeated++;
        else successful++;
        last = result.id;
      } catch (error) {
        failed++;
        console.warn('字体导入失败：', file?.name, error);
        toast(`${file?.name || '字体'}：${error.message || error}`, 'error');
      }
    }
    toast(`字体导入：新增 ${successful}、已有 ${repeated}、失败 ${failed}`);
    if (last && readerOnSelect) await choose(last);
    refresh();
  }
  async function removeCustom(id) {
    if (!custom.has(id)) return;
    const pending = activeLoads.get(id);
    if (pending) await pending.catch(() => {});
    if (id === readerSelection) {
      readerSelection = 'system';
      if (readerOnSelect) await readerOnSelect('system');
    }
    if (id === defaultId) await setDefault('system');
    await dbRequest('customFonts', 'readwrite', s => s.delete(id));
    custom.delete(id);
    const face = installed.get(id);
    if (face) { document.fonts.delete(face); installed.delete(id); }
    refresh();
    toast('已移除自定义字体；其他书籍如使用此字体，会自动回退系统字体。');
  }
  async function setDefault(id) {
    const value = resolvedId(id);
    defaultId = value;
    await put('settings', { key: 'defaultReaderFont', value });
    refresh();
    toast('默认阅读字体已更新，新导入的书籍也可以直接使用。');
  }
  async function choose(id) {
    const resolved = resolvedId(id);
    try {
      await ensure(resolved);
      readerSelection = resolved;
      if (readerOnSelect) await readerOnSelect(resolved);
      refresh();
    } catch (error) { toast(`字体无法加载：${error.message || error}`, 'error'); }
  }
  function setReaderSelection(id) {
    readerSelection = resolvedId(id || defaultId);
    refresh();
  }
  function renderPanel(target, isReader) {
    const items = list();
    const filter = target.dataset.fontFilter || 'all';
    const visible = items.filter(item => filter === 'all' ||
      (filter === 'custom' ? item.category === 'custom' : (filter === 'novel' ? item.category === 'serif' || item.category === 'novel' : item.category === filter)));
    const grid = target.querySelector('.yomi-font-grid');
    grid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of visible) {
      const selected = item.id === (isReader ? readerSelection : defaultId);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yomi-font-card' + (selected ? ' selected' : '');
      button.dataset.fontId = item.id;
      button.setAttribute('aria-pressed', String(selected));
      const header = document.createElement('span');
      header.className = 'yomi-font-card-name';
      header.textContent = item.name;
      const sample = document.createElement('span');
      sample.className = 'yomi-font-card-sample';
      sample.textContent = item.cjk === false ? 'The road ahead · Aa 2026' : FONT_EXAMPLE;
      const desc = document.createElement('small');
      desc.textContent = item.description || '';
      const tail = document.createElement('span');
      tail.className = 'yomi-font-card-tail';
      tail.textContent = item.id === 'system' ? '系统' : item.id.startsWith('user:') ? formatFontSize(item.bytes) : '已内置 · ' + formatFontSize(item.bytes);
      button.append(header, sample, desc, tail);
      if (item.category === 'custom') {
        const remove = document.createElement('button');
        remove.className = 'yomi-font-remove';
        remove.dataset.fontDelete = item.id;
        remove.setAttribute('aria-label', '删除字体 ' + item.name);
        remove.textContent = '×';
        const wrap = document.createElement('div');
        wrap.className = 'yomi-font-card-wrap';
        wrap.append(button, remove);
        fragment.appendChild(wrap);
      } else fragment.appendChild(button);
    }
    grid.append(fragment);
    const count = target.querySelector('.yomi-font-count');
    count.textContent = `20 款已内置 · 自定义 ${custom.size} 款`;
    const defaultButton = target.querySelector('[data-font-default]');
    defaultButton.hidden = !isReader;
    if (isReader) defaultButton.disabled = readerSelection === defaultId;
    target.querySelectorAll('[data-font-filter]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.fontFilter === filter));
    });
  }
  async function loadVisiblePreviews(target) {
    if (target._fontObserver) target._fontObserver.disconnect();
    const observer = new IntersectionObserver(entries => {
      entries.forEach(async entry => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        const id = entry.target.dataset.fontId;
        if (id === 'system') return;
        try {
          await ensure(id);
          const node = entry.target.querySelector('.yomi-font-card-sample');
          if (node?.isConnected) node.style.fontFamily = cssFamily(id);
        } catch (error) {
          const node = entry.target.querySelector('.yomi-font-card-tail');
          if (node?.isConnected) node.textContent = '字体文件缺失，使用系统字体';
        }
      });
    }, { root: target.closest('.reader-settings') || null, rootMargin: '100px' });
    target._fontObserver = observer;
    target.querySelectorAll('[data-font-id]').forEach(button => observer.observe(button));
  }
  function refresh() {
    for (const item of panels) {
      if (item.root.isConnected) {
        renderPanel(item.root, item.reader);
        loadVisiblePreviews(item.root);
      }
    }
  }
  function attach(container, { reader = false, onSelect = null, chooseFiles = null } = {}) {
    if (!container) return;
    if (reader) readerOnSelect = onSelect;
    if (chooseFiles) filePicker = chooseFiles;
    const root = document.createElement('section');
    root.className = 'yomi-font-manager';
    root.dataset.fontFilter = 'all';
    root.innerHTML = `<div class="yomi-font-heading"><div><strong>阅读字体</strong><small class="yomi-font-count">20 款已内置</small></div><span>离线可用</span></div>
      <div class="yomi-font-filters" role="group" aria-label="字体类别">
        <button type="button" data-font-filter="all" aria-pressed="true">全部</button>
        <button type="button" data-font-filter="novel">小说正文</button>
        <button type="button" data-font-filter="display">个性标题</button>
        <button type="button" data-font-filter="custom">我的字体</button>
      </div>
      <div class="yomi-font-grid" aria-label="字体列表"></div>
      <div class="yomi-font-footer">
        <button type="button" class="secondary-button" data-font-import>＋ 导入字体文件</button>
        <button type="button" class="secondary-button" data-font-default>设为默认字体</button>
      </div>
      <p class="yomi-font-hint">可导入 TTF / OTF / WOFF / WOFF2（单个最多 16MB），字体只保存在本机。个别艺术字体不包含所有汉字，将自动回退系统字形。</p>
      <input type="file" data-font-file accept=".ttf,.otf,.woff,.woff2" multiple hidden />`;
    container.appendChild(root);
    panels.push({ root, reader });
    root.addEventListener('click', async e => {
      const filter = e.target.closest('[data-font-filter]');
      if (filter) {
        root.dataset.fontFilter = filter.dataset.fontFilter;
        renderPanel(root, reader);
        loadVisiblePreviews(root);
        return;
      }
      const remove = e.target.closest('[data-font-delete]');
      if (remove) { await removeCustom(remove.dataset.fontDelete).catch(error => toast(error.message, 'error')); return; }
      if (e.target.closest('[data-font-import]')) {
        if (filePicker) {
          try { await importFiles(await filePicker()); } catch (error) { toast('导入字体失败：' + (error.message || error), 'error'); }
        } else root.querySelector('[data-font-file]').click();
        return;
      }
      if (e.target.closest('[data-font-default]')) { await setDefault(readerSelection); return; }
      const card = e.target.closest('[data-font-id]');
      if (!card) return;
      if (reader) await choose(card.dataset.fontId);
      else await setDefault(card.dataset.fontId);
    });
    root.querySelector('[data-font-file]').addEventListener('change', async e => {
      await importFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });
    if (ready) refresh();
  }
  return {
    initialize, attach, ensure, cssFamily, applyToStage, setReaderSelection, importFiles,
    getDefaultId: () => defaultId,
    count: () => custom.size,
    list
  };
}
