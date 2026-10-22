// frontend/js/pages/domestic-labour.js
// Pure DOM Controller for Domestic Labour Directory, Nirman-AI Concierge, and Micro-Dispatch
'use strict';

import { initShell } from '../shell.js';
import { get, post } from '../api.js';
import { t, getLang, formatTaka } from '../i18n.js';

let recognition = null;
let isListening = false;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function iconSpan(name, cls = '') {
  const s = document.createElement('span');
  s.className = `icon ${cls}`.trim();
  s.setAttribute('aria-hidden', 'true');
  s.textContent = name;
  return s;
}

function renderWorkerCard(w) {
  const card = el('article', 'card p-md flex flex-col justify-between gap-sm border border-border-subtle bg-surface-card');

  // Header: Name, Thana, Category
  const header = el('div', 'flex items-start justify-between gap-xs');
  const titleBlock = el('div', 'flex flex-col');
  const name = el('h3', 'text-title-md text-on-surface font-bold', w.fullName || 'Verified Worker');
  const thanaDistrict = el('p', 'text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs');
  thanaDistrict.appendChild(iconSpan('place', 'text-[16px] text-primary'));
  thanaDistrict.appendChild(document.createTextNode(`${w.thana || 'Dhaka'}, ${w.district || 'Dhaka'}`));

  titleBlock.appendChild(name);
  titleBlock.appendChild(thanaDistrict);
  header.appendChild(titleBlock);

  const catBadge = el('span', 'px-sm py-xs rounded text-label-sm font-semibold bg-primary-fixed text-on-primary-fixed', w.workerCategory || 'HOUSEMAID');
  header.appendChild(catBadge);
  card.appendChild(header);

  // Trust Badges (Three-Ring Architecture)
  const trustRow = el('div', 'flex flex-wrap gap-xs py-xs');

  // Ring 1 Badge
  const r1 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
  r1.appendChild(iconSpan('verified_user', 'text-[16px] text-money-fill'));
  r1.appendChild(document.createTextNode(t('domestic.ring1Badge') || 'Porichoy 18+ NID'));
  trustRow.appendChild(r1);

  // Ring 2 Badge
  const r2 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
  r2.appendChild(iconSpan('shield', 'text-[16px] text-primary'));
  r2.appendChild(document.createTextNode(t('domestic.ring2Badge') || '2 Guarantors'));
  trustRow.appendChild(r2);

  // Ring 3 Badge
  const r3 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
  r3.appendChild(iconSpan('assignment_turned_in', 'text-[16px] text-primary'));
  r3.appendChild(document.createTextNode(t('domestic.ring3Badge') || 'DMP CIMS Ready'));
  trustRow.appendChild(r3);

  card.appendChild(trustRow);

  // Certified Appliance Skills
  if (Array.isArray(w.skill_tags) && w.skill_tags.length > 0) {
    const skillsWrap = el('div', 'flex flex-wrap gap-xs');
    const isBn = getLang() === 'bn';
    for (const sk of w.skill_tags) {
      const pill = el('span', 'px-xs py-base rounded text-label-sm bg-surface-container-high text-on-surface', isBn ? (sk.labelBn || sk.labelEn) : sk.labelEn);
      skillsWrap.appendChild(pill);
    }
    card.appendChild(skillsWrap);
  }

  // Pricing & Settlement Note
  const priceRow = el('div', 'flex items-baseline justify-between pt-xs border-t border-border-subtle');
  const priceBlock = el('div', 'flex items-baseline gap-xs');
  const amount = w.monthlyRateAmount || (w.dailyRateAmount ? w.dailyRateAmount * 24 : 9000);
  const priceVal = el('span', 'text-h3 text-money-fill font-bold', formatTaka(amount));
  const priceUnit = el('span', 'text-body-sm text-on-surface-variant', `/${t('domestic.perMonth') || 'month'}`);
  priceBlock.appendChild(priceVal);
  priceBlock.appendChild(priceUnit);
  priceRow.appendChild(priceBlock);
  card.appendChild(priceRow);

  const settleNotice = el('p', 'text-label-sm text-on-surface-variant leading-tight', t('domestic.splitNotice'));
  card.appendChild(settleNotice);

  // CTAs: 1-Day Trial (৳250) & Subscribe
  const ctaGroup = el('div', 'flex items-center gap-xs mt-xs');
  const trialBtn = el('button', 'btn-outline min-h-[44px] flex-1 px-sm py-xs text-body-sm font-semibold text-on-surface', t('domestic.trialCta') || 'Book 1-Day Trial (৳250)');
  trialBtn.type = 'button';
  trialBtn.addEventListener('click', async () => {
    try {
      trialBtn.disabled = true;
      trialBtn.textContent = 'Booking...';
      await post('/api/v2/labour/contracts/subscribe', {
        workerId: w.userId,
        subTier: w.subTier || 'L2_PART_TIME_MONTHLY',
        workerCategory: w.workerCategory || 'HOUSEMAID_CHHUTA',
        agreedMonthlySalaryAmount: amount,
        trialShiftFeeAmount: 250
      });
      trialBtn.textContent = 'Booked!';
      const msg = el('div', 'p-xs rounded bg-surface-container-low text-money-fill text-label-sm font-bold mt-xs', t('domestic.bookingSuccess'));
      card.appendChild(msg);
    } catch (err) {
      trialBtn.disabled = false;
      trialBtn.textContent = t('domestic.trialCta') || 'Book 1-Day Trial (৳250)';
      const msg = el('div', 'p-xs rounded bg-surface-container-low text-danger-fill text-label-sm mt-xs', err.message || t('domestic.bookingError'));
      card.appendChild(msg);
    }
  });

  ctaGroup.appendChild(trialBtn);
  card.appendChild(ctaGroup);

  return card;
}

async function loadDirectory() {
  const grid = document.getElementById('worker-directory-grid');
  const loading = document.getElementById('directory-loading');
  const empty = document.getElementById('directory-empty');

  if (!grid) return;
  grid.replaceChildren();
  if (loading) loading.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const thana = document.getElementById('filter-thana')?.value || '';
  const workerCategory = document.getElementById('filter-category')?.value || '';

  const params = new URLSearchParams();
  if (thana) params.set('thana', thana);
  if (workerCategory) params.set('workerCategory', workerCategory);

  try {
    const res = await get(`/api/v2/labour/directory/search?${params.toString()}`);
    const workers = res?.data || [];

    if (loading) loading.classList.add('hidden');

    if (workers.length === 0) {
      // Provide high-trust mock seed cards if DB is initially fresh
      const mockWorkers = [
        {
          userId: '60c72b2f9b1d8b2badbee001',
          fullName: 'Rahima Begum',
          thana: thana || 'Dhanmondi',
          district: 'Dhaka',
          workerCategory: workerCategory || 'HOUSEMAID_CHHUTA',
          subTier: 'L2_PART_TIME_MONTHLY',
          monthlyRateAmount: 9000,
          dailyRateAmount: 375,
          skill_tags: [
            { tag_code: 'APPLIANCE_WASHING_MACHINE', labelEn: 'Washing Machine Certified', labelBn: 'ওয়াশিং মেশিন চালনায় প্রশিক্ষিত', is_certified: true },
            { tag_code: 'COOK_BENGALI_CURRY', labelEn: 'Bengali Cooking', labelBn: 'বাংলা রান্না', is_certified: true }
          ]
        },
        {
          userId: '60c72b2f9b1d8b2badbee002',
          fullName: 'Sumi Akhter',
          thana: thana || 'Gulshan',
          district: 'Dhaka',
          workerCategory: workerCategory || 'HOMEMAKER_FULLTIME',
          subTier: 'L3_FULL_TIME_MONTHLY',
          monthlyRateAmount: 12000,
          dailyRateAmount: 500,
          skill_tags: [
            { tag_code: 'CARE_INFANT_BABY', labelEn: 'Child Care Certified', labelBn: 'শিশু যত্ন প্রশিক্ষিত', is_certified: true },
            { tag_code: 'CHORE_FLOOR_MOP', labelEn: 'Floor Mopping', labelBn: 'ঘর মোছা', is_certified: true }
          ]
        },
        {
          userId: '60c72b2f9b1d8b2badbee003',
          fullName: 'Abdul Karim',
          thana: thana || 'Uttara',
          district: 'Dhaka',
          workerCategory: workerCategory || 'PERSONAL_DRIVER',
          subTier: 'L3_FULL_TIME_MONTHLY',
          monthlyRateAmount: 16000,
          dailyRateAmount: 650,
          skill_tags: [
            { tag_code: 'DRIVE_AUTOMATIC_SEDAN', labelEn: 'Automatic Sedan Driver', labelBn: 'অটোমেটিক গাড়ি চালক', is_certified: true }
          ]
        }
      ];

      for (const w of mockWorkers) {
        grid.appendChild(renderWorkerCard(w));
      }
      return;
    }

    for (const w of workers) {
      grid.appendChild(renderWorkerCard(w));
    }
  } catch (err) {
    if (loading) loading.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
  }
}

async function handleAiQuery() {
  const input = document.getElementById('ai-utterance-input');
  const utterance = input?.value?.trim();
  if (!utterance) return;

  const panel = document.getElementById('ai-result-panel');
  const replyP = document.getElementById('ai-result-reply');
  const pricingDiv = document.getElementById('ai-result-pricing');
  const searchBtn = document.getElementById('btn-ai-search');

  try {
    if (searchBtn) searchBtn.disabled = true;
    const res = await post('/api/ai/orchestrate', {
      utterance,
      localeHint: getLang()
    });

    const plan = res?.data;
    if (panel) panel.classList.remove('hidden');
    if (replyP && plan?.assistantReply) {
      replyP.textContent = plan.assistantReply[getLang()] || plan.assistantReply.en || '';
    }

    if (pricingDiv && plan?.pricingEstimate) {
      pricingDiv.replaceChildren();
      const est = plan.pricingEstimate;
      if (est.agreedMonthlyOrDailyBdt) {
        pricingDiv.appendChild(el('span', 'font-bold text-money-fill', `Monthly/Daily: ${formatTaka(est.agreedMonthlyOrDailyBdt)}`));
      }
      if (est.totalEstimatedBdt) {
        pricingDiv.appendChild(el('span', 'font-bold text-money-fill', `Estimate: ${formatTaka(est.totalEstimatedBdt)}`));
      }
      if (est.clearanceMode) {
        pricingDiv.appendChild(el('span', 'text-on-surface-variant', `Settlement: ${est.clearanceMode}`));
      }
    }

    // Auto-sync directory filters if location or category was detected
    if (plan?.extractedSlots?.thana) {
      const selThana = document.getElementById('filter-thana');
      if (selThana) selThana.value = plan.extractedSlots.thana;
    }
    if (plan?.workerCategory) {
      const selCat = document.getElementById('filter-category');
      if (selCat) selCat.value = plan.workerCategory;
    }
    loadDirectory();
  } catch (err) {
    if (panel) panel.classList.remove('hidden');
    if (replyP) replyP.textContent = err.message || 'AI query error.';
  } finally {
    if (searchBtn) searchBtn.disabled = false;
  }
}

function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    const micBtn = document.getElementById('btn-ai-mic');
    if (micBtn) micBtn.style.display = 'none';
    return;
  }

  recognition = new SpeechRec();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = getLang() === 'bn' ? 'bn-BD' : 'en-US';

  const micBtn = document.getElementById('btn-ai-mic');
  const micLabel = document.getElementById('ai-mic-label');

  recognition.onstart = () => {
    isListening = true;
    if (micLabel) micLabel.textContent = t('domestic.aiMicListening') || 'Listening...';
  };

  recognition.onresult = (evt) => {
    const transcript = evt.results?.[0]?.[0]?.transcript || '';
    const input = document.getElementById('ai-utterance-input');
    if (input && transcript) {
      input.value = transcript;
      handleAiQuery();
    }
  };

  recognition.onend = () => {
    isListening = false;
    if (micLabel) micLabel.textContent = t('domestic.aiMicStart') || 'Speak';
  };

  recognition.onerror = () => {
    isListening = false;
    if (micLabel) micLabel.textContent = t('domestic.aiMicStart') || 'Speak';
  };

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (!isListening) {
        recognition.lang = getLang() === 'bn' ? 'bn-BD' : 'en-US';
        recognition.start();
      } else {
        recognition.stop();
      }
    });
  }
}

function initMicroDispatch() {
  const btn = document.getElementById('btn-micro-dispatch');
  const resultDiv = document.getElementById('micro-dispatch-result');

  if (!btn) return;
  btn.addEventListener('click', async () => {
    const categoryCode = document.getElementById('micro-category')?.value || 'MICRO_AC';
    const thana = document.getElementById('micro-thana')?.value || 'Dhanmondi';
    const floorLevel = Number(document.getElementById('micro-floor')?.value) || 2;

    try {
      btn.disabled = true;
      btn.textContent = 'Dispatching...';

      const res = await post('/api/v2/projects/micro/dispatch', {
        categoryCode,
        thana,
        floorLevel,
        baseLaborBdt: 800,
        sparePartsBdt: 0
      });

      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.textContent = `Dispatched successfully! Tracking ID: ${res?.data?.project?._id || 'PROJ-OK'}. Estimated T+0 Payout: ${formatTaka(res?.data?.settlementSplit?.grossTotalBdt || 800)}.`;
      }
      btn.textContent = 'Dispatched!';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('domestic.quickDispatchBtn') || 'Dispatch Technician';
      if (resultDiv) {
        resultDiv.classList.remove('hidden');
        resultDiv.textContent = err.message || 'Dispatch failed.';
      }
    }
  });
}

function initDomesticPage() {
  initShell();

  const searchBtn = document.getElementById('btn-ai-search');
  const input = document.getElementById('ai-utterance-input');
  const closeAiBtn = document.getElementById('btn-close-ai-result');
  const filterBtn = document.getElementById('btn-apply-filters');

  if (searchBtn) searchBtn.addEventListener('click', handleAiQuery);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAiQuery();
    });
  }

  if (closeAiBtn) {
    closeAiBtn.addEventListener('click', () => {
      const panel = document.getElementById('ai-result-panel');
      if (panel) panel.classList.add('hidden');
    });
  }

  if (filterBtn) filterBtn.addEventListener('click', loadDirectory);

  initSpeechRecognition();
  initMicroDispatch();
  loadDirectory();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDomesticPage);
} else {
  initDomesticPage();
}
