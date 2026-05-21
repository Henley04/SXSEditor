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

// #2: 设置按钮loading状态
function setBtnLoading(btn, loading, loadingText) {
    if (loading) {
        btn.dataset.originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = loadingText;
        btn.classList.add('loading');
    } else {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || btn.textContent;
        btn.classList.remove('loading');
    }
}

// ===== GPU Info Rendering =====
// #1: 全部使用DOM API替代innerHTML拼接

function renderGPUInfo(gpus) {
    if (!gpus || gpus.length === 0) {
        gpuInfoContent.textContent = '';
        const noData = document.createElement('div');
        noData.className = 'gpu-no-data';
        noData.textContent = t('resourceManager.noGpuDetected');
        gpuInfoContent.appendChild(noData);
        return;
    }

    gpuInfoContent.textContent = '';
    for (const gpu of gpus) {
        const card = document.createElement('div');
        card.className = 'gpu-card';

        const usagePercent = gpu.budgetBytes > 0
            ? Math.min(100, (gpu.currentUsageBytes / gpu.budgetBytes) * 100)
            : 0;

        let barClass = '';
        if (usagePercent >= 90) barClass = 'critical';
        else if (usagePercent >= 70) barClass = 'warning';

        // Header
        const cardHeader = document.createElement('div');
        cardHeader.className = 'gpu-card-header';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'gpu-name';
        nameSpan.textContent = gpu.name;
        nameSpan.title = gpu.name;

        const badgesDiv = document.createElement('div');
        badgesDiv.className = 'gpu-badges';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'gpu-badge ' + (gpu.isDiscrete ? 'discrete' : 'integrated');
        typeBadge.textContent = gpu.isDiscrete ? t('resourceManager.discrete') : t('resourceManager.integrated');
        badgesDiv.appendChild(typeBadge);

        if (gpu.vendor) {
            const vendorBadge = document.createElement('span');
            vendorBadge.className = 'gpu-badge vendor';
            vendorBadge.textContent = gpu.vendor;
            badgesDiv.appendChild(vendorBadge);
        }

        cardHeader.appendChild(nameSpan);
        cardHeader.appendChild(badgesDiv);

        // VRAM bar
        const barContainer = document.createElement('div');
        barContainer.className = 'vram-bar-container';

        const labelDiv = document.createElement('div');
        labelDiv.className = 'vram-label';

        const usedSpan = document.createElement('span');
        usedSpan.className = 'vram-used';
        usedSpan.textContent = formatBytes(gpu.currentUsageBytes) + ' ' + t('resourceManager.used');

        const totalSpan = document.createElement('span');
        totalSpan.className = 'vram-total';
        totalSpan.textContent = formatBytes(gpu.budgetBytes) + ' ' + t('resourceManager.total');

        labelDiv.appendChild(usedSpan);
        labelDiv.appendChild(totalSpan);

        const barDiv = document.createElement('div');
        barDiv.className = 'vram-bar';

        const fillDiv = document.createElement('div');
        fillDiv.className = 'vram-bar-fill' + (barClass ? ' ' + barClass : '');
        fillDiv.style.width = usagePercent.toFixed(1) + '%';

        barDiv.appendChild(fillDiv);
        barContainer.appendChild(labelDiv);
        barContainer.appendChild(barDiv);

        card.appendChild(cardHeader);
        card.appendChild(barContainer);
        gpuInfoContent.appendChild(card);
    }
}

// ===== Model Groups Rendering =====

function renderModelGroups(groups) {
    if (!groups || groups.length === 0) {
        modelGroupsContent.textContent = '';
        const noData = document.createElement('div');
        noData.className = 'gpu-no-data';
        noData.textContent = t('resourceManager.noModels');
        modelGroupsContent.appendChild(noData);
        return;
    }

    modelGroupsContent.textContent = '';

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
            // #2: loading状态 + #3: 失败恢复
            setBtnLoading(loadAllBtn, true, t('resourceManager.loading'));
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
            // #2: loading状态 + #3: 失败恢复
            setBtnLoading(unloadAllBtn, true, t('resourceManager.loading'));
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
                    // #2: loading状态 + #3: 失败恢复
                    setBtnLoading(btn, true, t('resourceManager.loading'));
                    try {
                        await window.electronAPI.resmgrUnloadModel(group.id, model.id);
                    } catch (err) {
                        console.error('卸载模型失败:', err);
                        setBtnLoading(btn, false);
                    }
                    await loadData();
                });
            } else {
                btn.className = 'model-btn load';
                btn.textContent = t('resourceManager.load');
                btn.disabled = !model.filesExist;
                btn.addEventListener('click', async () => {
                    // #2: loading状态 + #3: 失败恢复
                    setBtnLoading(btn, true, t('resourceManager.loading'));
                    try {
                        await window.electronAPI.resmgrLoadModel(group.id, model.id);
                    } catch (err) {
                        console.error('加载模型失败:', err);
                        setBtnLoading(btn, false);
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
        // #10: 使用动态max-height
        header.addEventListener('click', () => {
            const isExpanded = body.classList.contains('expanded');
            if (isExpanded) {
                body.style.maxHeight = body.scrollHeight + 'px';
                // 强制重排后设置为0以触发过渡
                body.offsetHeight; // eslint-disable-line no-unused-expressions
                body.style.maxHeight = '0px';
                body.classList.remove('expanded');
                arrow.classList.remove('expanded');
            } else {
                body.classList.add('expanded');
                arrow.classList.add('expanded');
                body.style.maxHeight = body.scrollHeight + 'px';
                // 过渡完成后移除固定高度，允许内容动态变化
                const onEnd = () => {
                    if (body.classList.contains('expanded')) {
                        body.style.maxHeight = 'none';
                    }
                    body.removeEventListener('transitionend', onEnd);
                };
                body.addEventListener('transitionend', onEnd);
            }
        });

        groupEl.appendChild(header);
        groupEl.appendChild(body);
        modelGroupsContent.appendChild(groupEl);
    }
}

// ===== Summary Rendering =====
// #1: 使用DOM API替代innerHTML

function renderSummary(groups, gpus) {
    if (!groups || groups.length === 0) {
        summaryContent.textContent = '';
        const noData = document.createElement('div');
        noData.className = 'gpu-no-data';
        noData.textContent = t('resourceManager.noModels');
        summaryContent.appendChild(noData);
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

    summaryContent.textContent = '';

    const row1 = document.createElement('div');
    row1.className = 'summary-row';
    const label1 = document.createElement('span');
    label1.className = 'summary-label';
    label1.textContent = t('resourceManager.loadedModelsCount');
    const value1 = document.createElement('span');
    value1.className = 'summary-value accent';
    value1.textContent = `${loadedModels} / ${totalModels}`;
    row1.appendChild(label1);
    row1.appendChild(value1);
    summaryContent.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'summary-row';
    const label2 = document.createElement('span');
    label2.className = 'summary-label';
    label2.textContent = t('resourceManager.estimatedVramUsage');
    const value2 = document.createElement('span');
    value2.className = 'summary-value green';
    value2.textContent = formatBytes(estimatedVram) + (totalBudget > 0 ? ' / ' + formatBytes(totalBudget) : '');
    row2.appendChild(label2);
    row2.appendChild(value2);
    summaryContent.appendChild(row2);
}

// ===== Data Loading =====

function showLoadFailed(container) {
    container.textContent = '';
    const noData = document.createElement('div');
    noData.className = 'gpu-no-data';
    noData.textContent = t('resourceManager.loadFailed');
    container.appendChild(noData);
}

async function loadData() {
    try {
        const [gpuResult, modelResult] = await Promise.all([
            window.electronAPI.resmgrGetGPUInfo(),
            window.electronAPI.resmgrGetModelGroups(),
        ]);

        if (gpuResult.success) {
            renderGPUInfo(gpuResult.gpus);
        } else {
            showLoadFailed(gpuInfoContent);
        }

        if (modelResult.success) {
            renderModelGroups(modelResult.groups);
            renderSummary(modelResult.groups, gpuResult.success ? gpuResult.gpus : []);
        } else {
            showLoadFailed(modelGroupsContent);
        }
    } catch (err) {
        console.error('加载数据失败:', err);
        showLoadFailed(gpuInfoContent);
        showLoadFailed(modelGroupsContent);
    }
}

// #7: 自动刷新也刷新模型状态
async function autoRefresh() {
    try {
        const [gpuResult, modelResult] = await Promise.all([
            window.electronAPI.resmgrGetGPUInfo(),
            window.electronAPI.resmgrGetModelGroups(),
        ]);

        if (gpuResult.success) {
            renderGPUInfo(gpuResult.gpus);
        }

        if (modelResult.success) {
            renderModelGroups(modelResult.groups);
            renderSummary(modelResult.groups, gpuResult.success ? gpuResult.gpus : []);
        }
    } catch (_) {
        // silent refresh
    }
}

// ===== Auto Refresh =====

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(autoRefresh, 5000);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

// ===== Event Listeners =====

refreshBtn.addEventListener('click', loadData);

// #8: 窗口关闭时停止自动刷新定时器
window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
});

// ===== Init =====

initI18n();
applyLocale();
document.documentElement.lang = getLocale();

loadData();
startAutoRefresh();
