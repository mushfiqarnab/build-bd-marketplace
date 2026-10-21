import { initShell } from '../shell.js';
import { bengaliToAscii } from '../phone.js';

(async () => {
  const me = await initShell();

  // Smart CTA routing for signed-in users
  if (me) {
    if (me.role === 'CLIENT') {
      const clientCta = document.querySelector('a[href="/app/login.html?role=CLIENT"]');
      if (clientCta) clientCta.href = '/app/post-project.html';
      const probashiCta = document.getElementById('probashi-cta-btn');
      if (probashiCta) probashiCta.href = '/app/post-project.html?category=Residential&ref=probashi';
    } else if (me.role === 'CONTRACTOR') {
      const contractorCta = document.querySelector('a[href="/app/login.html?role=CONTRACTOR"]');
      if (contractorCta) contractorCta.href = '/app/tenders.html';
    }
  }

  // Instant Structural BOQ & Materials Estimator Logic
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

    const area = Math.max(100, Math.min(100000, parseFloat(rawArea) || 1500));
    const floors = Math.max(1, Math.min(30, parseInt(rawFloors, 10) || 1));
    const builtUpSqft = area * floors;

    // Standard structural thumb rules in Bangladesh:
    // 500W TMT Rebar: ~4.0 kg per sq ft built-up area -> Metric tons (1000 kg)
    const rebarKg = builtUpSqft * 4.0;
    const rebarTons = (rebarKg / 1000).toFixed(1);

    // Cement: ~0.38 bags per sq ft built-up area
    const cementBags = Math.round(builtUpSqft * 0.38);

    // Grey structure (civil casting, columns, slabs, bricks, labor): ~2,000 BDT/sq ft
    const totalCostBdt = Math.round(builtUpSqft * 2000);
    const totalLakh = (totalCostBdt / 100000).toFixed(1);

    if (rebarTonEl) rebarTonEl.textContent = rebarTons;
    if (cementBagsEl) cementBagsEl.textContent = cementBags.toLocaleString('en-US');
    if (totalLakhEl) totalLakhEl.textContent = totalLakh;

    if (postCta) {
      const qTitle = encodeURIComponent(`${floors}-Story Building Construction (${builtUpSqft.toLocaleString('en-US')} sq ft)`);
      const targetBase = me?.role === 'CLIENT' ? '/app/post-project.html' : '/app/login.html?role=CLIENT';
      postCta.href = `${targetBase}?title=${qTitle}&budget=${totalCostBdt}&category=Residential`;
    }
  }

  if (plotAreaInput && floorsInput) {
    plotAreaInput.addEventListener('input', calculateEstimates);
    floorsInput.addEventListener('input', calculateEstimates);
    calculateEstimates();
  }
})();
