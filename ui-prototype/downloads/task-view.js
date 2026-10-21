// View layer for download queue, independent of Electron's file monitor.
export function createTaskView({ state, $, esc }) {
  function renderTasks() {
    $('taskCount').textContent = state.tasks.filter(t => t.status !== 'done').length;
    $('downloadBadge').textContent = state.tasks.filter(t => t.status !== 'done').length;
    $('downloadBadge').classList.toggle('hidden', !state.tasks.some(t => t.status !== 'done'));
    const recent = state.tasks.slice(0, 3);
    $('taskList').innerHTML = recent.map(t => `<div class="dock-task"><div class="task-file-icon">${esc(t.ext.toUpperCase().slice(0,4))}</div><div class="task-info"><div class="task-name">${esc(t.name)}</div><div class="task-status ${t.status === 'done' ? 'done' : ''}">${esc(t.message || (t.status === 'done' ? '已完成' : t.status === 'error' ? '失败' : '等待文件完成'))}</div></div><div class="task-progress"><i style="width:${t.progress || 0}%"></i></div></div>`).join('');
    $('dockMessage').textContent = '下载完成后自动添加到本地图书馆';
    $('dockOpen').style.display = state.tasks.length ? 'inline-block' : '';
    const done = state.tasks.filter(t => t.status === 'done').length, active = state.tasks.filter(t => t.status === 'active' || t.status === 'waiting').length, imported = state.tasks.filter(t => t.imported).length;
    $('activeStat').textContent = active; $('completeStat').textContent = done; $('importedStat').textContent = imported;
    $('downloadTable').innerHTML = state.tasks.map(t => `<div class="download-row"><div class="task-file-icon">${esc(t.ext.toUpperCase().slice(0,4))}</div><div class="task-info"><div class="task-name">${esc(t.name)}</div><div class="task-status ${t.status === 'done' ? 'done' : ''}">${esc(t.message || t.status)}</div></div><div class="task-progress"><i style="width:${t.progress || 0}%"></i></div>${t.nativePath && t.status === 'waiting' ? `<button class="text-button import-task" data-import-task="${esc(t.id)}">导入</button>` : `<span class="row-date" style="color:#858a90;font-size:10px">${new Date(t.createdAt).toLocaleDateString()}</span>`}</div>`).join('');
    $('downloadEmpty').classList.toggle('hidden', state.tasks.length > 0); $('downloadTable').classList.toggle('hidden', state.tasks.length === 0);
  }

  return { renderTasks };
}
