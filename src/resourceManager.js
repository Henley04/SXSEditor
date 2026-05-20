import './resourceManager.css';
import { t, initI18n, applyLocale, getLocale } from './i18n/index.js';

const gpuInfoContent = document.getElementById('gpuInfoContent');
const modelGroupsContent = document.getElementById('modelGroupsContent');
const summaryContent = document.getElementById('summaryContent');
const refreshBtn = document.getElementById('refreshBtn');

let autoRefreshTimer = null;

// ===== Helpers =====

function formatBytes(bytes) {
    if (bytes === 0 || bytes == null) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    if (i >= 2) {
        return val.toFixed(i >= 3 ? 2 : 0) + ' ' + units[i];
    }
    return Math.round(val) + ' ' + units[i];
}

function getLocalizedName(item) {
    if (getLocale() === 'en' && item.nameEn) return item.nameEn;
    return item.name;
}

function getLocalizedDesc(item) {
    if (getLocale() === 'en' && item.descriptionEn) return item.descriptionEn;
    return item.description;
}

function getEPLabel(ep) {
    if (!ep) return '';
    const map = {
        dml: 'DML',
        cpu: 'CPU',
        tfjs: 'TFJS',
    };
    return map[ep.toLowerCase()] || ep.toUpperCase();
}

function getEPBadgeClass(ep) {
    if (!ep) return 'none';
    const map = {
        dml: 'dml',
        cpu: 'cpu',
        tfjs: 'tfjs',
    };
    return map[ep.toLowerCase()] || 'none';
}

// ===== GPU Info Rendering =====

function renderGPUInfo(gpus) {
    if (!gpus || gpus.length === 0) {
        gpuInfoContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.noGpuDetected')}</div>`;
        return;
    }

    gpuInfoContent.innerHTML = '';
    for (const gpu of gpus) {
        const card = document.createElement('div');
        card.className = 'gpu-card';

        const usagePercent = gpu.budgetBytes > 0
            ? Math.min(100, (gpu.currentUsageBytes / gpu.budgetBytes) * 100)
            : 0;

        let barClass = '';
        if (usagePercent >= 90) barClass = 'critical';
        else if (usagePercent >= 70) barClass = 'warning';

        const discreteStr = gpu.isDiscrete
            ? `<span class="gpu-badge discrete">${t('resourceManager.discrete')}</span>`
            : `<span class="gpu-badge integrated">${t('resourceManager.integrated')}</span>`;

        const vendorStr = gpu.vendor
            ? `<span class="gpu-badge vendor">${gpu.vendor}</span>`
            : '';

        card.innerHTML = `
            <div class="gpu-card-header">
                <span class="gpu-name" title="${gpu.name}">${gpu.name}</span>
                <div class="gpu-badges">
                    ${discreteStr}
                    ${vendorStr}
                </div>
            </div>
            <div class="vram-bar-container">
                <div class="vram-label">
                    <span class="vram-used">${formatBytes(gpu.currentUsageBytes)} ${t('resourceManager.used')}</span>
                    <span class="vram-total">${formatBytes(gpu.budgetBytes)} ${t('resourceManager.total')}</span>
                </div>
                <div class="vram-bar">
                    <div class="vram-bar-fill ${barClass}" style="width: ${usagePercent.toFixed(1)}%"></div>
                </div>
            </div>
        `;

        gpuInfoContent.appendChild(card);
    }
}

// ===== Model Groups Rendering =====

function renderModelGroups(groups) {
    if (!groups || groups.length === 0) {
        modelGroupsContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.noModels')}</div>`;
        return;
    }

    modelGroupsContent.innerHTML = '';

    for (const group of groups) {
        const loadedCount = group.models.filter(m => m.loaded).length;
        const totalCount = group.models.length;

        const groupEl = document.createElement('div');
        groupEl.className = 'model-group';
        groupEl.dataset.groupId = group.id;

        // Header
        const header = document.createElement('div');
        header.className = 'model-group-header';

        const arrow = document.createElement('span');
        arrow.className = 'group-arrow';
        arrow.textContent = '▶';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'group-name';
        nameSpan.textContent = getLocalizedName(group);

        const badge = document.createElement('span');
        badge.className = 'group-loaded-badge';
        if (loadedCount === totalCount && totalCount > 0) {
            badge.classList.add('all-loaded');
        } else if (loadedCount === 0) {
            badge.classList.add('none-loaded');
        }
        badge.textContent = `${loadedCount}/${totalCount}`;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'group-actions';

        const loadAllBtn = document.createElement('button');
        loadAllBtn.className = 'group-action-btn load-all';
        loadAllBtn.textContent = t('resourceManager.loadAll');
        loadAllBtn.disabled = loadedCount === totalCount;
        loadAllBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            loadAllBtn.disabled = true;
            try {
                await window.electronAPI.resmgrLoadGroup(group.id);
            } catch (err) {
                console.error('加载模型组失败:', err);
            }
            await loadData();
        });

        const unloadAllBtn = document.createElement('button');
        unloadAllBtn.className = 'group-action-btn unload-all';
        unloadAllBtn.textContent = t('resourceManager.unloadAll');
        unloadAllBtn.disabled = loadedCount === 0;
        unloadAllBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            unloadAllBtn.disabled = true;
            try {
                await window.electronAPI.resmgrUnloadGroup(group.id);
            } catch (err) {
                console.error('卸载模型组失败:', err);
            }
            await loadData();
        });

        actionsDiv.appendChild(loadAllBtn);
        actionsDiv.appendChild(unloadAllBtn);

        header.appendChild(arrow);
        header.appendChild(nameSpan);
        header.appendChild(badge);
        header.appendChild(actionsDiv);

        // Body
        const body = document.createElement('div');
        body.className = 'model-group-body';

        const modelList = document.createElement('div');
        modelList.className = 'model-list';

        for (const model of group.models) {
            const item = document.createElement('div');
            item.className = 'model-item';

            const info = document.createElement('div');
            info.className = 'model-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'model-name';
            nameEl.textContent = getLocalizedName(model);

            const desc = getLocalizedDesc(model);
            if (desc) {
                const descEl = document.createElement('div');
                descEl.className = 'model-desc';
                descEl.textContent = desc;
                info.appendChild(nameEl);
                info.appendChild(descEl);
            } else {
                info.appendChild(nameEl);
            }

            const meta = document.createElement('div');
            meta.className = 'model-meta';

            if (model.fileSize > 0) {
                const sizeEl = document.createElement('span');
                sizeEl.className = 'model-size';
                sizeEl.textContent = formatBytes(model.fileSize);
                meta.appendChild(sizeEl);
            }

            if (!model.filesExist) {
                const missingEl = document.createElement('span');
                missingEl.className = 'model-missing';
                missingEl.textContent = t('resourceManager.filesMissing');
                meta.appendChild(missingEl);
            }

            const epBadge = document.createElement('span');
            epBadge.className = `ep-badge ${getEPBadgeClass(model.ep)}`;
            epBadge.textContent = model.loaded ? getEPLabel(model.ep) : '—';
            meta.appendChild(epBadge);

            const btn = document.createElement('button');
            if (model.loaded) {
                btn.className = 'model-btn unload';
                btn.textContent = t('resourceManager.unload');
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    try {
                        await window.electronAPI.resmgrUnloadModel(group.id, model.id);
                    } catch (err) {
                        console.error('卸载模型失败:', err);
                    }
                    await loadData();
                });
            } else {
                btn.className = 'model-btn load';
                btn.textContent = t('resourceManager.load');
                btn.disabled = !model.filesExist;
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    try {
                        await window.electronAPI.resmgrLoadModel(group.id, model.id);
                    } catch (err) {
                        console.error('加载模型失败:', err);
                    }
                    await loadData();
                });
            }
            meta.appendChild(btn);

            item.appendChild(info);
            item.appendChild(meta);
            modelList.appendChild(item);
        }

        body.appendChild(modelList);

        // Toggle expand/collapse
        header.addEventListener('click', () => {
            const isExpanded = body.classList.contains('expanded');
            if (isExpanded) {
                body.classList.remove('expanded');
                arrow.classList.remove('expanded');
            } else {
                body.classList.add('expanded');
                arrow.classList.add('expanded');
            }
        });

        groupEl.appendChild(header);
        groupEl.appendChild(body);
        modelGroupsContent.appendChild(groupEl);
    }
}

// ===== Summary Rendering =====

function renderSummary(groups, gpus) {
    if (!groups || groups.length === 0) {
        summaryContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.noModels')}</div>`;
        return;
    }

    const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0);
    const loadedModels = groups.reduce((sum, g) => sum + g.models.filter(m => m.loaded).length, 0);

    let estimatedVram = 0;
    for (const group of groups) {
        for (const model of group.models) {
            if (model.loaded && model.ep !== 'cpu' && model.fileSize > 0) {
                estimatedVram += model.fileSize;
            }
        }
    }

    let totalBudget = 0;
    if (gpus && gpus.length > 0) {
        totalBudget = gpus.reduce((sum, g) => sum + (g.budgetBytes || 0), 0);
    }

    summaryContent.innerHTML = '';

    const row1 = document.createElement('div');
    row1.className = 'summary-row';
    row1.innerHTML = `
        <span class="summary-label">${t('resourceManager.loadedModelsCount')}</span>
        <span class="summary-value accent">${loadedModels} / ${totalModels}</span>
    `;
    summaryContent.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'summary-row';
    row2.innerHTML = `
        <span class="summary-label">${t('resourceManager.estimatedVramUsage')}</span>
        <span class="summary-value green">${formatBytes(estimatedVram)}${totalBudget > 0 ? ' / ' + formatBytes(totalBudget) : ''}</span>
    `;
    summaryContent.appendChild(row2);
}

// ===== Data Loading =====

async function loadData() {
    try {
        const [gpuResult, modelResult] = await Promise.all([
            window.electronAPI.resmgrGetGPUInfo(),
            window.electronAPI.resmgrGetModelGroups(),
        ]);

        if (gpuResult.success) {
            renderGPUInfo(gpuResult.gpus);
        } else {
            gpuInfoContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.loadFailed')}</div>`;
        }

        if (modelResult.success) {
            renderModelGroups(modelResult.groups);
            renderSummary(modelResult.groups, gpuResult.success ? gpuResult.gpus : []);
        } else {
            modelGroupsContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.loadFailed')}</div>`;
        }
    } catch (err) {
        console.error('加载数据失败:', err);
        gpuInfoContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.loadFailed')}</div>`;
        modelGroupsContent.innerHTML = `<div class="gpu-no-data">${t('resourceManager.loadFailed')}</div>`;
    }
}

async function refreshGPUOnly() {
    try {
        const gpuResult = await window.electronAPI.resmgrGetGPUInfo();
        if (gpuResult.success) {
            renderGPUInfo(gpuResult.gpus);
        }
    } catch (_) {
        // silent refresh
    }
}

// ===== Auto Refresh =====

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(refreshGPUOnly, 5000);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

// ===== Event Listeners =====

refreshBtn.addEventListener('click', loadData);

// ===== Init =====

initI18n();
applyLocale();
document.documentElement.lang = getLocale();

loadData();
startAutoRefresh();
