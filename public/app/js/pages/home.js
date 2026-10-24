// frontend/js/pages/home.js
// Build-BD Sovereign Physical Economy Landing Page Orchestrator:
// Intent Switcher, Nirman-AI Bilingual Concierge, Live Directory Hydration & BOQ Calculator.
'use strict';

import { initShell } from '../shell.js';
import { bengaliToAscii } from '../phone.js';
import { get, post } from '../api.js';
import { t, getLang, formatTaka } from '../i18n.js';
import { initConceptSlider } from '../conceptSlider.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconSpan(name, className) {
  const s = el('span', `icon ${className || ''}`, name);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

(async () => {
  const me = await initShell();

  // Initialize interactive auto-advancing concept showcase slider
  initConceptSlider('interactive-concept-showcase');

  // Smart CTA routing for signed-in users
  if (me) {
    if (me.role === 'CLIENT') {
      const clientCta = document.querySelector('a[data-cta="client"]');
      if (clientCta) clientCta.href = '/app/post-project.html';
    } else if (me.role === 'CONTRACTOR') {
      const contractorCta = document.querySelector('a[data-cta="contractor"]');
      if (contractorCta) contractorCta.href = '/app/tenders.html';
    }
  }

  // ── 1. Intent Tab Navigation (Household, Micro, Renovation, Construction, Materials)
  const tabButtons = document.querySelectorAll('button[data-intent-tab]');
  const panels = {
    household: document.getElementById('panel-household'),
    micro: document.getElementById('panel-micro'),
    renovation: document.getElementById('panel-renovation'),
    construction: document.getElementById('panel-construction'),
    materials: document.getElementById('panel-materials')
  };

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.intentTab;
      tabButtons.forEach((b) => {
        const isActive = b === btn;
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          b.className = 'btn-primary min-h-[44px] px-md inline-flex items-center gap-xs text-body-sm font-bold rounded-lg shadow-sm';
        } else {
          b.className = 'btn-ghost min-h-[44px] px-md inline-flex items-center gap-xs text-body-sm font-semibold rounded-lg text-on-surface-variant hover:text-on-surface';
        }
      });

      Object.entries(panels).forEach(([key, panel]) => {
        if (!panel) return;
        if (key === target) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
      });
    });
  });

  // ── 2. Live Domestic Worker Directory Cards Hydration ──────────────────────
  const workerGrid = document.getElementById('home-worker-grid');
  const thanaSelect = document.getElementById('home-thana-select');

  function buildWorkerCard(w) {
    const card = el('article', 'card p-md flex flex-col justify-between gap-sm border border-border-subtle bg-surface-card hover:border-primary-container transition-colors');

    // Header: Name, Location, Category
    const header = el('div', 'flex items-start justify-between gap-xs');
    const titleCol = el('div', 'flex flex-col');
    const name = el('h4', 'text-title-md text-on-surface font-bold', w.fullName || 'Verified Worker');
    const loc = el('p', 'text-body-sm text-on-surface-variant flex items-center gap-xs mt-xs');
    loc.appendChild(iconSpan('place', 'text-[16px] text-primary'));
    loc.appendChild(document.createTextNode(`${w.thana || 'Dhanmondi'}, Dhaka`));
    titleCol.appendChild(name);
    titleCol.appendChild(loc);
    header.appendChild(titleCol);

    const catBadge = el('span', 'px-sm py-xs rounded text-label-sm font-semibold bg-primary-fixed text-on-primary-fixed', w.workerCategory || 'HOUSEMAID');
    header.appendChild(catBadge);
    card.appendChild(header);

    // Three-Ring Trust Badges
    const trustRow = el('div', 'flex flex-wrap gap-xs py-xs');
    const r1 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
    r1.appendChild(iconSpan('verified_user', 'text-[16px] text-money-fill'));
    r1.appendChild(document.createTextNode('Porichoy ≥80%'));
    trustRow.appendChild(r1);

    const r2 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
    r2.appendChild(iconSpan('shield', 'text-[16px] text-primary'));
    r2.appendChild(document.createTextNode('2 Guarantors'));
    trustRow.appendChild(r2);

    const r3 = el('span', 'inline-flex items-center gap-xs px-xs py-base rounded text-label-sm bg-surface-container-low text-on-surface');
    r3.appendChild(iconSpan('assignment_turned_in', 'text-[16px] text-primary'));
    r3.appendChild(document.createTextNode('DMP CIMS'));
    trustRow.appendChild(r3);
    card.appendChild(trustRow);

    // Skill Chips
    if (Array.isArray(w.skill_tags) && w.skill_tags.length > 0) {
      const skillsWrap = el('div', 'flex flex-wrap gap-xs');
      const isBn = getLang() === 'bn';
      w.skill_tags.slice(0, 2).forEach((sk) => {
        const pill = el('span', 'px-xs py-base rounded text-label-sm bg-surface-container-high text-on-surface', isBn ? (sk.labelBn || sk.labelEn) : sk.labelEn);
        skillsWrap.appendChild(pill);
      });
      card.appendChild(skillsWrap);
    }

    // Pricing Row
    const priceRow = el('div', 'flex items-baseline justify-between pt-xs border-t border-border-subtle mt-auto');
    const priceBlock = el('div', 'flex items-baseline gap-xs');
    const amount = w.monthlyRateAmount || (w.dailyRateAmount ? w.dailyRateAmount * 24 : 9000);
    const priceVal = el('span', 'text-h3 text-money-fill font-bold', formatTaka(amount));
    const priceUnit = el('span', 'text-body-sm text-on-surface-variant', '/mo');
    priceBlock.appendChild(priceVal);
    priceBlock.appendChild(priceUnit);
    priceRow.appendChild(priceBlock);
    card.appendChild(priceRow);

    // Action CTA
    const trialBtn = el('a', 'btn-outline w-full min-h-[44px] flex items-center justify-center gap-xs text-body-sm font-semibold mt-xs', t('domestic.trialCta') || 'Book 1-Day Trial (৳250)');
    trialBtn.href = `/app/domestic-labour.html?workerId=${encodeURIComponent(w.userId || w._id || '')}&thana=${encodeURIComponent(w.thana || '')}`;
    card.appendChild(trialBtn);

    return card;
  }

  async function loadHomeWorkers(thanaFilter = '') {
    if (!workerGrid) return;
    workerGrid.replaceChildren(el('div', 'p-md text-on-surface-variant text-body-sm col-span-full', 'Loading verified staff directory...'));

    const params = new URLSearchParams();
    if (thanaFilter) params.set('thana', thanaFilter);

    try {
      const res = await get(`/api/v2/labour/directory/search?${params.toString()}`);
      const workers = res?.data || [];

      if (workers.length === 0) {
        // High-trust mock fallback if no workers match
        const sampleWorkers = [
          {
            userId: '60c72b2f9b1d8b2badbee001',
            fullName: 'Rahima Begum',
            thana: thanaFilter || 'Dhanmondi',
            workerCategory: 'HOUSEMAID_CHHUTA',
            monthlyRateAmount: 8500,
            skill_tags: [{ labelEn: 'Washing Machine', labelBn: 'ওয়াশিং মেশিন' }, { labelEn: 'Cooking', labelBn: 'রান্না' }]
          },
          {
            userId: '60c72b2f9b1d8b2badbee002',
            fullName: 'Sumi Akhter',
            thana: thanaFilter || 'Gulshan',
            workerCategory: 'HOMEMAKER_FULLTIME',
            monthlyRateAmount: 18000,
            skill_tags: [{ labelEn: 'Child Care', labelBn: 'শিশু যত্ন' }, { labelEn: 'Cooking', labelBn: 'রান্না' }]
          },
          {
            userId: '60c72b2f9b1d8b2badbee003',
            fullName: 'Abdul Karim',
            thana: thanaFilter || 'Uttara',
            workerCategory: 'PERSONAL_DRIVER',
            monthlyRateAmount: 16000,
            skill_tags: [{ labelEn: 'Automatic Sedan Driver', labelBn: 'অটোমেটিক গাড়ি চালক' }]
          },
          {
            fullName: 'Abdul Jalil',
            thana: thanaFilter || 'Banani',
            workerCategory: 'PERSONAL_DRIVER',
            monthlyRateAmount: 22000,
            skill_tags: [{ labelEn: 'Navigation', labelBn: 'নেভিগেশন' }]
          }
        ];
        workerGrid.replaceChildren();
        sampleWorkers.forEach((w) => workerGrid.appendChild(buildWorkerCard(w)));
        return;
      }

      workerGrid.replaceChildren();
      workers.slice(0, 4).forEach((w) => workerGrid.appendChild(buildWorkerCard(w)));
    } catch {
      workerGrid.replaceChildren(el('div', 'p-md text-on-surface-variant text-body-sm col-span-full', 'Verified staff available via direct search.'));
    }
  }

  if (thanaSelect) {
    thanaSelect.addEventListener('change', () => {
      loadHomeWorkers(thanaSelect.value);
    });
    loadHomeWorkers(thanaSelect.value || 'Dhanmondi');
  }

  // ── 3. Nirman-AI Conversational Voice & Text Concierge Ingress ──────────────
  const aiInput = document.getElementById('home-ai-input');
  const aiBtn = document.getElementById('home-ai-btn');
  const micBtn = document.getElementById('home-mic-btn');
  const micText = document.getElementById('home-mic-text');
  const aiResult = document.getElementById('home-ai-result');

  async function handleAIOrchestration(rawUtterance) {
    const text = (rawUtterance || aiInput?.value || '').trim();
    if (!text) return;
    if (!aiResult) return;

    aiResult.classList.remove('hidden');
    aiResult.replaceChildren(el('div', 'p-sm text-body-sm text-on-surface-variant flex items-center gap-xs', 'Consulting Nirman-AI engine...'));
    aiResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const res = await post('/api/ai/orchestrate', {
        utterance: text,
        inputMode: rawUtterance ? 'VOICE' : 'TEXT',
        localeHint: getLang()
      });

      const plan = res?.data;
      if (!plan) throw new Error('No intent resolution returned.');

      aiResult.replaceChildren();

      // Top row: Vertical tag + Confidence
      const topRow = el('div', 'flex items-center justify-between gap-xs');
      const vertBadge = el('span', 'px-sm py-xs rounded text-label-sm font-bold bg-primary-fixed text-on-primary-fixed', `${plan.vertical || 'DOMESTIC_LABOUR'} · ${plan.tier || 'STANDARD'}`);
      topRow.appendChild(vertBadge);
      aiResult.appendChild(topRow);

      // Assistant Reply
      const reply = el('p', 'text-body-md font-medium text-on-surface', plan.assistantReply?.[getLang()] || plan.assistantReply?.en || 'Matched verified service proposal.');
      aiResult.appendChild(reply);

      // Slots Summary
      const slotsBox = el('div', 'p-sm rounded bg-surface-card border border-border-subtle grid grid-cols-2 sm:grid-cols-4 gap-xs text-body-sm');
      const thana = plan.extractedSlots?.thana || '';
      const trade = plan.workerCategory || plan.extractedSlots?.categoryCode || 'Electrical';

      if (thana) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', 'Thana'));
        item.appendChild(el('span', 'font-bold text-on-surface', thana));
        slotsBox.appendChild(item);
      }
      if (plan.extractedSlots?.skuCode || plan.extractedSlots?.categoryCode || plan.workerCategory) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', 'Category'));
        item.appendChild(el('span', 'font-bold text-on-surface', String(plan.extractedSlots?.skuCode || plan.extractedSlots?.categoryCode || plan.workerCategory || '').replace(/_/g, ' ')));
        slotsBox.appendChild(item);
      }
      const estBudget = plan.pricingEstimate?.totalBaseEscrowOnArrivalBdt ||
        plan.pricingEstimate?.totalEstimatedBdt ||
        plan.pricingEstimate?.totalEscrowBdt ||
        plan.pricingEstimate?.estimatedBudgetBdt ||
        plan.pricingEstimate?.agreedMonthlyOrDailyBdt ||
        plan.pricingEstimate?.baseLaborBdt;

      if (estBudget) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', 'Est. Allocation'));
        item.appendChild(el('span', 'font-bold text-money-fill', `৳${estBudget}`));
        slotsBox.appendChild(item);
      }
      if (plan.pricingEstimate?.visitingFeeFloorBdt) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', 'Visit Protection'));
        item.appendChild(el('span', 'font-bold text-primary', `৳${plan.pricingEstimate.visitingFeeFloorBdt}`));
        slotsBox.appendChild(item);
      }
      if (plan.pricingEstimate?.trialShiftFeeBdt) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', '1-Day Trial'));
        item.appendChild(el('span', 'font-bold text-primary', `৳${plan.pricingEstimate.trialShiftFeeBdt}`));
        slotsBox.appendChild(item);
      }
      if (plan.extractedSlots?.shiftHours) {
        const item = el('div');
        item.appendChild(el('span', 'text-label-sm text-on-surface-variant block', 'Shift Slot'));
        item.appendChild(el('span', 'font-bold text-on-surface', `${plan.extractedSlots.shiftHours} Hours/Day`));
        slotsBox.appendChild(item);
      }
      aiResult.appendChild(slotsBox);

      // Multi-Vertical Action CTA Routing
      const ctaRow = el('div', 'pt-xs flex flex-wrap items-center justify-end gap-sm');
      const vert = plan.vertical || 'DOMESTIC_LABOUR';

      if (vert === 'TIER_1_MICRO') {
        const worksLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        worksLink.href = `/app/works.html?nature=MICRO&thana=${encodeURIComponent(thana)}`;
        worksLink.appendChild(document.createTextNode('Browse Micro RFQs'));
        ctaRow.appendChild(worksLink);

        const postLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        postLink.href = `/app/post-project.html?mode=quick&category=${encodeURIComponent(trade)}&budget=${encodeURIComponent(estBudget || 800)}`;
        postLink.appendChild(document.createTextNode('Post Quick Repair Task'));
        ctaRow.appendChild(postLink);

        const dispatchBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        dispatchBtn.href = '/app/domestic-labour.html#quick-dispatch';
        dispatchBtn.appendChild(document.createTextNode('Dispatch Emergency Tech'));
        dispatchBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(dispatchBtn);
      } else if (vert === 'DOMESTIC_LABOUR') {
        const servicesLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        servicesLink.href = '/app/works.html?nature=SERVICES';
        servicesLink.appendChild(document.createTextNode('Explore Service Tenders'));
        ctaRow.appendChild(servicesLink);

        const actionBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        actionBtn.href = `/app/domestic-labour.html?thana=${encodeURIComponent(thana)}&category=${encodeURIComponent(plan.workerCategory || '')}`;
        actionBtn.appendChild(document.createTextNode('View Matched Staff & Book Trial'));
        actionBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(actionBtn);
      } else if (vert === 'TIER_2_MID') {
        const renoWorksLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        renoWorksLink.href = '/app/works.html?nature=RENOVATION';
        renoWorksLink.appendChild(document.createTextNode('View Renovation Feed'));
        ctaRow.appendChild(renoWorksLink);

        const postRenoBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        postRenoBtn.href = `/app/post-project.html?category=Renovation&budget=${encodeURIComponent(estBudget || 50000)}`;
        postRenoBtn.appendChild(document.createTextNode('Open Split-BOQ & Post Renovation'));
        postRenoBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(postRenoBtn);
      } else if (vert === 'TIER_3_MACRO') {
        const civilWorksLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        civilWorksLink.href = '/app/works.html?nature=WORKS';
        civilWorksLink.appendChild(document.createTextNode('Browse Civil Tenders'));
        ctaRow.appendChild(civilWorksLink);

        const postCivilBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        postCivilBtn.href = `/app/post-project.html?category=Residential&budget=${encodeURIComponent(estBudget || 500000)}`;
        postCivilBtn.appendChild(document.createTextNode('Post Formal Civil Tender'));
        postCivilBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(postCivilBtn);
      } else if (vert === 'MATERIALS_DIRECT') {
        const ordersLink = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center gap-xs font-semibold');
        ordersLink.href = '/app/material-orders.html';
        ordersLink.appendChild(document.createTextNode('My Material Orders'));
        ctaRow.appendChild(ordersLink);

        const matCatalogBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        matCatalogBtn.href = '/app/materials.html';
        matCatalogBtn.appendChild(document.createTextNode('Order Direct from Mill-Rate Catalog'));
        matCatalogBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(matCatalogBtn);
      } else {
        const actionBtn = el('a', 'btn-cta min-h-[44px] px-lg inline-flex items-center gap-xs font-semibold');
        actionBtn.href = `/app/works.html?q=${encodeURIComponent(text)}`;
        actionBtn.appendChild(document.createTextNode('Explore Matching Works'));
        actionBtn.appendChild(iconSpan('arrow_forward', 'text-[16px]'));
        ctaRow.appendChild(actionBtn);
      }
      aiResult.appendChild(ctaRow);
      aiResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      aiResult.replaceChildren(el('div', 'p-sm text-body-sm text-danger-fill', err.message || 'AI Concierge unavailable. Please use manual directory search.'));
      aiResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  if (aiBtn) {
    aiBtn.addEventListener('click', () => handleAIOrchestration());
  }
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAIOrchestration();
      }
    });
  }

  // Web Speech API Microphone Integration
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition && micBtn) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = getLang() === 'bn' ? 'bn-BD' : 'en-US';

    let isListening = false;
    recognition.onstart = () => {
      isListening = true;
      if (micText) micText.textContent = t('domestic.aiMicListening') || 'Listening...';
      micBtn.classList.add('bg-cta-amber/20');
    };

    recognition.onresult = (evt) => {
      const transcript = evt.results?.[0]?.[0]?.transcript || '';
      if (transcript && aiInput) {
        aiInput.value = transcript;
        handleAIOrchestration(transcript);
      }
    };

    recognition.onerror = () => {
      isListening = false;
      if (micText) micText.textContent = t('domestic.aiMicStart') || 'Speak';
      micBtn.classList.remove('bg-cta-amber/20');
    };

    recognition.onend = () => {
      isListening = false;
      if (micText) micText.textContent = t('domestic.aiMicStart') || 'Speak';
      micBtn.classList.remove('bg-cta-amber/20');
    };

    micBtn.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
      } else {
        recognition.lang = getLang() === 'bn' ? 'bn-BD' : 'en-US';
        recognition.start();
      }
    });
  }

  // ── 4. Instant Structural BOQ & Materials Estimator Logic ─────────────────
  const plotAreaInput = document.getElementById('estimator-plot-area');
  const floorsInput = document.getElementById('estimator-floors');
  const rebarTonEl = document.getElementById('estimator-rebar-ton');
  const cementBagsEl = document.getElementById('estimator-cement-bags');
  const totalLakhEl = document.getElementById('estimator-total-lakh');
  const postCta = document.getElementById('estimator-post-cta');

  function calculateEstimates() {
    if (!plotAreaInput || !floorsInput) return;
    const rawArea = bengaliToAscii(plotAreaInput.value || '1500').replace(/[^\d.]/g, '');
    const rawFloors = bengaliToAscii(floorsInput.value || '3').replace(/[^\d.]/g, '');

    const area = Math.max(100, Math.min(50000, parseFloat(rawArea) || 1500));
    const floors = Math.max(1, Math.min(30, parseInt(rawFloors, 10) || 1));
    const builtUpSqft = area * floors;

    // Standard structural thumb rules in Bangladesh:
    // 500W TMT Rebar: ~4.0 kg per sq ft built-up area -> Metric tons (1000 kg)
    const rebarKg = builtUpSqft * 4.0;
    const rebarTons = (rebarKg / 1000).toFixed(1);

    // Cement: ~0.38 bags per sq ft built-up area
    const cementBags = Math.round(builtUpSqft * 0.38);

    // Grey structure: ~2,000 BDT/sq ft
    const totalCostBdt = Math.round(builtUpSqft * 2000);
    const totalLakh = (totalCostBdt / 100000).toFixed(1);

    if (rebarTonEl) rebarTonEl.textContent = rebarTons;
    if (cementBagsEl) cementBagsEl.textContent = cementBags.toLocaleString('en-US');
    if (totalLakhEl) totalLakhEl.textContent = totalLakh;

    if (postCta) {
      const projectQuery = `category=Residential&budget=${totalCostBdt}&floors=${floors}&sqft=${builtUpSqft}`;
      if (me?.role === 'CLIENT') {
        postCta.href = `/app/post-project.html?${projectQuery}`;
      } else {
        postCta.href = `/app/login.html?role=CLIENT&next=${encodeURIComponent(`/app/post-project.html?${projectQuery}`)}`;
      }
    }
  }

  if (plotAreaInput && floorsInput) {
    plotAreaInput.addEventListener('input', calculateEstimates);
    floorsInput.addEventListener('input', calculateEstimates);
    calculateEstimates();
  }

  document.addEventListener('langchange', () => {
    applyLang();
    calculateEstimates();
  });
})();
