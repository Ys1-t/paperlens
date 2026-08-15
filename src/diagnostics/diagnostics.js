import {
  formatRuntimeDiagnostics,
  loadRuntimeDiagnostics,
  RUNTIME_DIAGNOSTICS_KEY,
} from '../lib/runtime-diagnostics.js';

const report = document.getElementById('diagnostic-report');
const status = document.getElementById('status');

async function refreshDiagnostics() {
  const entries = await loadRuntimeDiagnostics(chrome.storage.local);
  report.value = formatRuntimeDiagnostics(entries);
  status.textContent = entries.length
    ? `已捕获 ${entries.length} 条记录。请复现问题后刷新，再复制诊断。`
    : '尚未捕获异常。请打开阅读器复现问题后再回来刷新。';
}

document.getElementById('copy-diagnostics').addEventListener('click', async () => {
  await navigator.clipboard.writeText(report.value);
  status.textContent = '诊断已复制。';
});

document.getElementById('clear-diagnostics').addEventListener('click', async () => {
  await chrome.storage.local.remove(RUNTIME_DIAGNOSTICS_KEY);
  await refreshDiagnostics();
  status.textContent = '诊断记录已清空。';
});

document.getElementById('refresh-diagnostics').addEventListener('click', refreshDiagnostics);
refreshDiagnostics().catch((error) => { status.textContent = `读取诊断失败：${error.message || String(error)}`; });
