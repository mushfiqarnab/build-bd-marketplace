// frontend/js/pages/contractors.js — Verified Contractor Directory.
// Displays verified contractors across Bangladesh with dynamic specialty filtering,
// district search, modality/tier selection, and cursor/page pagination.
//
// Invariants (Lane 1 Audit Floor):
//   - Pure DOM (document.createElement, textContent, zero innerHTML).
//   - All network calls via ../api.js get().
//   - Uses pure DOM renderContractorCard component from ../components/contractorCard.js.
//   - Strict CSP (zero inline handlers, zero script injection).
//   - Accessibility touch targets >= 44x44 px.

import { initShell } from '../shell.js';
import { get, ApiError } from '../api.js';
import { t, applyLang, toBengaliDigits, getLang } from '../i18n.js';
import { requireAuth } from '../session.js';
import { renderContractorCard } from '../components/contractorCard.js';

const $ = (id) => document.getElementById(id);

let selectedDistrict = '';
let selectedGenre = '';
let selectedTier = '';
let selectedModality = '';
let currentPage = 1;
let hasMore = false;
let currentContractors = [];
let fetchSeq = 0;
let enabledGenres = [];

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : 'alert-info';

  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : 'info';

  const msg = document.createElement('span');
  msg.textContent = text;

  div.append(icon, msg);
  box.append(div);
  box.hidden = false;
}

function messageFor(err) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 401) return t('err.sessionExpired');
  if (err.status === 403) return t('err.forbidden');
  if (err.status === 429) return t('err.rateLimited');
  return t('err.generic');
}

function updateGenreChips() {
  const rail = $('genre-rail');
  if (!rail) return;
  const buttons = rail.querySelectorAll('button[data-genre]');
  for (const btn of buttons) {
    const isSelected = btn.dataset.genre === selectedGenre;
    btn.className = isSelected ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  }
}

function renderGenreRail(genres) {
  const rail = $('genre-rail');
  if (!rail) return;
  rail.replaceChildren();

  // All Specialties button
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = selectedGenre === '' ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
  allBtn.dataset.genre = '';
  allBtn.setAttribute('role', 'tab');
  allBtn.setAttribute('aria-selected', selectedGenre === '' ? 'true' : 'false');
  allBtn.textContent = t('contractors.genre.all');
  allBtn.addEventListener('click', () => {
    if (selectedGenre === '') return;
    selectedGenre = '';
    updateGenreChips();
    fetchDirectory(1, false);
  });
  rail.append(allBtn);

  for (const g of genres) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = selectedGenre === g ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
    btn.dataset.genre = g;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', selectedGenre === g ? 'true' : 'false');
    const gKey = `genre.${g}`;
    btn.textContent = t(gKey) !== gKey ? t(gKey) : g;
    btn.addEventListener('click', () => {
      if (selectedGenre === g) return;
      selectedGenre = g;
      updateGenreChips();
      fetchDirectory(1, false);
    });
    rail.append(btn);
  }
}

async function fetchDirectory(page = 1, append = false) {
  const seq = ++fetchSeq;
  const loadMoreBtn = $('btn-load-more');
  const listEl = $('contractor-list');
  const emptyEl = $('empty');
  const paginationEl = $('pagination');
  const statsPill = $('stats-pill');

  if (append && loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.setAttribute('aria-busy', 'true');
    loadMoreBtn.textContent = t('contractors.loading');
  } else {
    $('loading').hidden = false;
    $('content').hidden = true;
  }
  showAlert(null, null);

  const query = { page, limit: 20 };
  if (selectedDistrict) query.district = selectedDistrict;
  if (selectedGenre) query.workGenre = selectedGenre;
  if (selectedTier) query.tier = selectedTier;
  if (selectedModality) query.modality = selectedModality;

  try {
    const res = await get('/contractor-profile/directory', query);
    if (seq !== fetchSeq) return; // Discard stale response

    $('loading').hidden = true;
    $('content').hidden = false;

    const data = res?.data || {};
    const contractors = Array.isArray(data.contractors) ? data.contractors : [];
    hasMore = Boolean(data.hasMore);
    currentPage = Number(data.page) || page;

    if (Array.isArray(data.enabledGenres) && data.enabledGenres.length > 0 && enabledGenres.length === 0) {
      enabledGenres = data.enabledGenres;
      renderGenreRail(enabledGenres);
    }

    if (append) {
      currentContractors = currentContractors.concat(contractors);
    } else {
      currentContractors = contractors;
      listEl.replaceChildren();
    }

    for (const c of contractors) {
      const card = renderContractorCard(c);
      listEl.append(card);
    }

    // Stats counter
    const lang = getLang();
    const countDisplay = lang === 'bn' ? toBengaliDigits(currentContractors.length) : String(currentContractors.length);
    statsPill.textContent = t('contractors.resultsCount', { count: countDisplay });

    // Empty state
    if (currentContractors.length === 0) {
      emptyEl.hidden = false;
      listEl.hidden = true;
      paginationEl.hidden = true;
    } else {
      emptyEl.hidden = true;
      listEl.hidden = false;
      paginationEl.hidden = !hasMore;
    }

    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.setAttribute('aria-busy', 'false');
      loadMoreBtn.textContent = t('contractors.loadMore');
    }
  } catch (err) {
    if (seq !== fetchSeq) return;
    $('loading').hidden = true;
    $('content').hidden = false;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.setAttribute('aria-busy', 'false');
      loadMoreBtn.textContent = t('contractors.loadMore');
    }
    showAlert('error', messageFor(err));
  }
}

function wireFilters() {
  const districtInput = $('filter-district');
  const tierSelect = $('filter-tier');
  const modalitySelect = $('filter-modality');
  const clearBtn = $('btn-clear-filters');
  const loadMoreBtn = $('btn-load-more');

  let districtDebounce = null;
  if (districtInput) {
    districtInput.addEventListener('input', (e) => {
      clearTimeout(districtDebounce);
      districtDebounce = setTimeout(() => {
        selectedDistrict = e.target.value.trim();
        fetchDirectory(1, false);
      }, 350);
    });
  }

  if (tierSelect) {
    tierSelect.addEventListener('change', (e) => {
      selectedTier = e.target.value;
      fetchDirectory(1, false);
    });
  }

  if (modalitySelect) {
    modalitySelect.addEventListener('change', (e) => {
      selectedModality = e.target.value;
      fetchDirectory(1, false);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedDistrict = '';
      selectedGenre = '';
      selectedTier = '';
      selectedModality = '';
      if (districtInput) districtInput.value = '';
      if (tierSelect) tierSelect.value = '';
      if (modalitySelect) modalitySelect.value = '';
      updateGenreChips();
      fetchDirectory(1, false);
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      if (hasMore) {
        fetchDirectory(currentPage + 1, true);
      }
    });
  }

  document.addEventListener('langchange', () => {
    applyLang();
    if (enabledGenres.length > 0) renderGenreRail(enabledGenres);
    fetchDirectory(currentPage, false);
  });
}

(async () => {
  initShell();
  try {
    await requireAuth({ roles: ['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR'] });
  } catch (err) {
    const bootError = $('boot-error');
    if (bootError) {
      bootError.textContent = messageFor(err);
      bootError.hidden = false;
    }
    return;
  }

  wireFilters();
  await fetchDirectory(1, false);
})().catch((err) => {
  const boot = $('boot-error');
  if (boot) {
    boot.textContent = t('err.generic');
    boot.hidden = false;
  }
});
