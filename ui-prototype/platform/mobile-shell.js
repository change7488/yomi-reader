// Only the shell varies between Android and Windows; library/reader logic is shared.
export function isAndroidApp(capacitor = globalThis.window?.Capacitor) {
  return Boolean(capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android');
}

export function swipeDirection(dx, dy, elapsedMs) {
  if (elapsedMs > 950 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return 0;
  return dx < 0 ? 1 : -1;
}

export function initMobileShell({ navigate, closeReader, readerIsOpen, movePage, canTurnPage, showHelp }) {
  if (!isAndroidApp()) return () => {};
  document.body.classList.add('platform-android');
  document.querySelector('.search-box kbd')?.remove();
  document.getElementById('dashboardImportFolderBtn')?.classList.remove('hidden');
  document.getElementById('chooseLibraryPathBtn')?.classList.add('hidden');
  const nav = document.createElement('nav');
  nav.id = 'yomiMobileNav';
  nav.setAttribute('aria-label', '手机底部导航');
  nav.innerHTML = [
    ['home','⌂','首页'], ['all','▤','书库'], ['favorites','♡','收藏'],
    ['history','◷','记录'], ['settings','⚙','设置']
  ].map(([view,icon,label]) => `<button type="button" data-mobile-view="${view}"><span aria-hidden="true">${icon}</span><small>${label}</small></button>`).join('');
  document.body.appendChild(nav);
  function updateActive(view) {
    nav.querySelectorAll('[data-mobile-view]').forEach(item => item.setAttribute('aria-current', item.dataset.mobileView === view ? 'page' : 'false'));
  }
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-mobile-view]');
    if (button) { navigate(button.dataset.mobileView); updateActive(button.dataset.mobileView); }
  });
  updateActive('home');
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => updateActive(item.dataset.view)));
  // Avoid requiring another navigation stack or duplicating reader state.
  const stage = document.getElementById('readerStage');
  let start = null;
  const onStart = event => {
    if (event.touches.length !== 1) { start = null; return; }
    const p = event.touches[0];
    start = { x: p.clientX, y: p.clientY, at: Date.now() };
  };
  const onEnd = event => {
    if (!start || !readerIsOpen() || !canTurnPage()) { start = null; return; }
    const p = event.changedTouches[0], dx = p.clientX - start.x, dy = p.clientY - start.y;
    const direction = swipeDirection(dx, dy, Date.now() - start.at);
    start = null;
    if (direction && !window.getSelection()?.toString()) movePage(direction);
  };
  stage.addEventListener('touchstart', onStart, { passive: true });
  stage.addEventListener('touchend', onEnd, { passive: true });
  const onBack = () => {
    const folderDialog = document.getElementById('folderImportModal');
    if (folderDialog && !folderDialog.classList.contains('hidden')) {
      folderDialog.classList.add('hidden');
      return;
    }
    const tutorial = document.querySelector('.yomi-guide-layer');
    if (tutorial) {
      const dismiss = tutorial.querySelector('[data-guide-close],[data-guide-skip],[data-guide-complete]');
      if (dismiss) dismiss.click();
      return;
    }
    const openPanel = [...document.querySelectorAll('#readerModal .open')].reverse()
      .find(el => el.classList.contains('reader-toc') || el.classList.contains('reader-settings') ||
        el.classList.contains('reader-gallery') || el.classList.contains('reader-notes-panel') ||
        el.classList.contains('reader-position-history') || el.classList.contains('reader-search-panel'));
    if (openPanel) { openPanel.classList.remove('open'); return; }
    if (readerIsOpen()) { void closeReader(); return; }
    navigate('home'); updateActive('home');
  };
  // Hardware volume keys are intercepted by a small native Capacitor plugin only while reading.
  // On the bookshelf the buttons retain their normal system-volume behavior.
  const readerKeys = window.Capacitor?.Plugins?.ReaderKeys;
  const immersivePreference = 'yomi-immersive-bars';
  const immersiveLabel = document.createElement('label');
  immersiveLabel.className = 'yomi-immersive-toggle';
  immersiveLabel.innerHTML = '<input id="yomiImmersiveToggle" type="checkbox"> 沉浸阅读：隐藏系统状态栏和底部导航条';
  document.getElementById('readerSettings')?.append(immersiveLabel);
  const immersiveCheckbox = immersiveLabel.querySelector('input');
  immersiveCheckbox.checked = localStorage.getItem(immersivePreference) !== '0';
  immersiveCheckbox.onchange = () => {
    localStorage.setItem(immersivePreference, immersiveCheckbox.checked ? '1' : '0');
    readerKeys?.setImmersive?.({ enabled: readerIsOpen() && immersiveCheckbox.checked })
      ?.catch?.(error => console.warn('切换系统状态栏失败', error));
  };
  const setNativeKeys = event => {
    readerKeys?.setEnabled?.({ enabled: Boolean(event.detail?.active) })
      ?.catch?.(error => console.warn('切换音量键翻页失败', error));
    readerKeys?.setImmersive?.({ enabled: Boolean(event.detail?.active) && immersiveCheckbox.checked })
      ?.catch?.(error => console.warn('沉浸式状态栏切换失败', error));
  };
  const onVolumeTurn = event => {
    if (!readerIsOpen() || !canTurnPage()) return;
    const direction = Number(event.direction);
    if (direction === 1 || direction === -1) movePage(direction);
  };
  window.addEventListener('yomi:reader-active', setNativeKeys);
  let readerKeysListener = null;
  if (readerKeys?.addListener) {
    Promise.resolve(readerKeys.addListener('pageTurn', onVolumeTurn))
      .then(handle => { readerKeysListener = handle; })
      .catch(error => console.warn('绑定音量键翻页失败', error));
  }
  const appPlugin = window.Capacitor?.Plugins?.App;
  let nativeListener = null;
  if (appPlugin?.addListener) {
    Promise.resolve(appPlugin.addListener('backButton', onBack))
      .then(handle => { nativeListener = handle; }).catch(error => console.warn('Android 返回键绑定失败', error));
  }
  document.addEventListener('backbutton', onBack);
  const avatar = document.getElementById('profileBtn');
  if (avatar) avatar.onclick = () => { navigate('settings'); updateActive('settings'); };
  return () => {
    readerKeys?.setEnabled?.({ enabled: false })?.catch?.(() => {});
    readerKeys?.setImmersive?.({ enabled: false })?.catch?.(() => {});
    window.removeEventListener('yomi:reader-active', setNativeKeys);
    readerKeysListener?.remove?.();
    document.removeEventListener('backbutton', onBack);
    stage.removeEventListener('touchstart', onStart);
    stage.removeEventListener('touchend', onEnd);
    nativeListener?.remove?.();
    immersiveLabel.remove();
    nav.remove();
    document.body.classList.remove('platform-android');
  };
}
