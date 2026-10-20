// Materials Marketplace Catalog — browse direct-from-mill materials with volume tiers.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — zero innerHTML.
//   - Network via ../api.js (get).
//   - All copy via t() with en and bn keys.
//   - All money via formatTaka().
//   - Zero "কার্যদিবস" (always use calendar days).
//   - Touch targets >= 44px floor on all buttons, tabs, inputs.

import { initShell } from '../shell.js';
import { get, post } from '../api.js';
import { t, applyLang, formatTaka } from '../i18n.js';
import { getMe } from '../session.js';
import { normalizeBdPhone } from '../phone.js';

const $ = (id) => document.getElementById(id);

let products = [];
let totalProducts = 0;
let currentPage = 1;
let activeCategory = '';
let activeDistrict = '';
let activeSort = 'price_asc';
let activeModalProduct = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelKey, value) {
  const wrap = el('div', 'flex flex-col');
  wrap.append(
    el('dt', 'text-label-sm text-on-surface-variant', t(labelKey)),
    el('dd', 'text-body-md text-on-surface break-words', value || '—')
  );
  return wrap;
}

function getBestDiscountPercent(product) {
  if (!product.bulkTiers || product.bulkTiers.length === 0) return 0;
  const lowestTierPrice = Math.min(...product.bulkTiers.map((t) => t.unitPriceBDT));
  if (lowestTierPrice >= product.basePriceBDT) return 0;
  return Math.round(((product.basePriceBDT - lowestTierPrice) / product.basePriceBDT) * 100);
}

function buildProductCard(product) {
  const li = el('li');
  const card = el('article', 'card p-md flex flex-col justify-between gap-md h-full');

  // Top Section: Brand + Title + Badges
  const top = el('div', 'flex flex-col gap-xs');

  const metaRow = el('div', 'flex items-center justify-between gap-xs');
  const brandPill = el('span', 'badge-category bg-primary-fixed text-primary font-bold text-label-sm uppercase tracking-wide', product.brand);
  const bstiBadge = product.specifications?.bstiCertified
    ? el('span', 'inline-flex items-center gap-xs text-[11px] font-semibold text-cta-amber bg-cta-amber/10 px-xs py-[2px] rounded border border-cta-amber/30')
    : null;

  if (bstiBadge) {
    const shieldIcon = el('span', 'icon text-[14px]', 'shield');
    shieldIcon.setAttribute('aria-hidden', 'true');
    bstiBadge.append(shieldIcon, el('span', '', t('materials.badge.bsti')));
    metaRow.append(brandPill, bstiBadge);
  } else {
    metaRow.append(brandPill);
  }

  const title = el('h2', 'text-h3 font-bold text-on-surface mt-xs line-clamp-2', product.title);

  // Specifications
  const specsRow = el('p', 'text-body-sm text-on-surface-variant');
  const specParts = [];
  if (product.category === 'ROD') {
    if (product.specifications?.diameterMm) specParts.push(`${product.specifications.diameterMm} mm`);
    if (product.specifications?.grade) specParts.push(product.specifications.grade);
    if (product.specifications?.standard) specParts.push(product.specifications.standard);
  } else if (product.category === 'CEMENT') {
    if (product.specifications?.cementType) specParts.push(product.specifications.cementType);
    if (product.specifications?.bagWeightKg) specParts.push(`${product.specifications.bagWeightKg} kg`);
  }
  specsRow.textContent = specParts.length > 0 ? specParts.join(' • ') : product.description || '';

  // Supplier info
  const supplierText = el('p', 'text-label-sm text-on-surface-variant flex items-center gap-xs mt-xs');
  const storeIcon = el('span', 'icon text-[16px]', 'construction');
  storeIcon.setAttribute('aria-hidden', 'true');
  supplierText.append(storeIcon, el('span', '', product.supplierId?.businessName || t('materials.directSupplier')));

  top.append(metaRow, title, specsRow, supplierText);

  // Middle/Bottom Section: Price, Volume Savings, Stock & CTA
  const bottom = el('div', 'flex flex-col gap-sm pt-sm border-t border-border-subtle mt-auto');

  const priceBlock = el('div', 'flex items-baseline justify-between gap-sm');
  const priceCol = el('div');
  const taka = el('span', 'text-h2 font-bold text-primary', formatTaka(product.basePriceBDT));
  const unitText = el('span', 'text-body-sm text-on-surface-variant ml-xs', `/ ${t('materials.unit.' + product.unit.toLowerCase()) || product.unit}`);
  priceCol.append(taka, unitText);

  const discountPercent = getBestDiscountPercent(product);
  if (discountPercent > 0) {
    const discountPill = el('span', 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber text-[11px] font-bold');
    discountPill.textContent = t('materials.bulkSaveUpTo', { percent: discountPercent });
    priceBlock.append(priceCol, discountPill);
  } else {
    priceBlock.append(priceCol);
  }

  // Stock status
  const stockRow = el('div', 'flex items-center justify-between text-label-sm');
  const inStock = product.status === 'ACTIVE' && product.stockQuantity > 0;
  const stockPill = el('span', inStock ? 'text-primary flex items-center gap-xs font-medium' : 'text-on-surface-variant flex items-center gap-xs');
  const stockIcon = el('span', 'icon text-[14px]', inStock ? 'check_circle' : 'pending');
  stockIcon.setAttribute('aria-hidden', 'true');
  stockPill.append(stockIcon, el('span', '', inStock ? t('materials.inStock') : t('materials.outOfStock')));

  const leadDays = product.deliveryTerms?.leadTimeDays || 2;
  const leadPill = el('span', 'text-on-surface-variant flex items-center gap-xs');
  const leadIcon = el('span', 'icon text-[14px]', 'schedule');
  leadIcon.setAttribute('aria-hidden', 'true');
  leadPill.append(leadIcon, el('span', '', t('materials.leadTime', { days: leadDays })));

  stockRow.append(stockPill, leadPill);

  // Open Modal CTA
  const ctaBtn = el('button', 'btn-primary min-h-[44px] w-full flex items-center justify-center gap-xs');
  ctaBtn.type = 'button';
  const ctaIcon = el('span', 'icon text-[18px]', 'local_atm');
  ctaIcon.setAttribute('aria-hidden', 'true');
  const ctaTxt = el('span', '', t('materials.action.viewTiers'));
  ctaBtn.append(ctaIcon, ctaTxt);

  ctaBtn.addEventListener('click', () => openTierModal(product));

  bottom.append(priceBlock, stockRow, ctaBtn);

  card.append(top, bottom);
  li.append(card);
  return li;
}

function openTierModal(product) {
  activeModalProduct = product;
  const modal = $('tier-modal');

  $('modal-product-title').textContent = product.title;
  $('modal-product-brand').textContent = `${product.brand} • ${product.category}`;

  // Specs summary in modal
  const specsList = $('modal-specs-list');
  specsList.replaceChildren();

  if (product.category === 'ROD') {
    if (product.specifications?.diameterMm) specsList.append(field('materials.spec.diameter', `${product.specifications.diameterMm} mm`));
    if (product.specifications?.grade) specsList.append(field('materials.spec.grade', product.specifications.grade));
    if (product.specifications?.standard) specsList.append(field('materials.spec.standard', product.specifications.standard));
  } else if (product.category === 'CEMENT') {
    if (product.specifications?.cementType) specsList.append(field('materials.spec.cementType', product.specifications.cementType));
    if (product.specifications?.bagWeightKg) specsList.append(field('materials.spec.bagWeight', `${product.specifications.bagWeightKg} kg`));
  }
  if (product.specifications?.bstiCertified) {
    specsList.append(field('materials.spec.bsti', product.specifications.bstiLicenseNumber || t('materials.certified')));
  }

  // Tiers table
  const tiersList = $('modal-tiers-list');
  tiersList.replaceChildren();

  const unitName = t('materials.unit.' + product.unit.toLowerCase()) || product.unit;

  // Base tier
  const baseLi = el('li', 'flex items-center justify-between py-xs px-sm rounded bg-surface-container text-body-sm');
  const firstTierMin = product.bulkTiers && product.bulkTiers.length > 0 ? product.bulkTiers[0].minQuantity : null;
  const baseRange = firstTierMin ? `1 – ${firstTierMin - 1} ${unitName}` : `1+ ${unitName}`;
  baseLi.append(
    el('span', 'font-medium text-on-surface', baseRange),
    el('span', 'font-bold text-primary', `${formatTaka(product.basePriceBDT)} / ${unitName}`)
  );
  tiersList.append(baseLi);

  // Bulk tiers
  if (product.bulkTiers && product.bulkTiers.length > 0) {
    for (let i = 0; i < product.bulkTiers.length; i++) {
      const tier = product.bulkTiers[i];
      const nextTier = product.bulkTiers[i + 1];
      const tierRange = nextTier
        ? `${tier.minQuantity} – ${nextTier.minQuantity - 1} ${unitName}`
        : `${tier.minQuantity}+ ${unitName}`;

      const tierLi = el('li', 'flex items-center justify-between py-xs px-sm rounded bg-cta-amber/10 text-body-sm border border-cta-amber/20');
      const discount = Math.round(((product.basePriceBDT - tier.unitPriceBDT) / product.basePriceBDT) * 100);

      const leftSpan = el('span', 'font-medium text-on-surface flex items-center gap-xs');
      leftSpan.append(
        el('span', '', tierRange),
        discount > 0 ? el('span', 'badge-category bg-cta-amber/30 text-[10px] font-bold text-on-surface', `-${discount}%`) : el('span')
      );

      const priceSpan = el('span', 'font-bold text-primary', `${formatTaka(tier.unitPriceBDT)} / ${unitName}`);
      tierLi.append(leftSpan, priceSpan);
      tiersList.append(tierLi);
    }
  }

  // Reset interactive calculator
  $('modal-calc-unit').textContent = unitName;
  const qtyInput = $('modal-calc-quantity');
  qtyInput.value = product.minOrderQuantity || 1;
  qtyInput.min = product.minOrderQuantity || 1;

  updateModalEstimate();

  modal.showModal();
}

function updateModalEstimate() {
  if (!activeModalProduct) return;
  const p = activeModalProduct;
  const qtyInput = $('modal-calc-quantity');
  let qty = parseInt(qtyInput.value, 10);
  if (!Number.isInteger(qty) || qty < 1) {
    qty = p.minOrderQuantity || 1;
    qtyInput.value = qty;
  }

  // Find best bulk tier where qty >= minQuantity
  let unitPrice = p.basePriceBDT;
  if (p.bulkTiers && p.bulkTiers.length > 0) {
    const sortedDesc = [...p.bulkTiers].sort((a, b) => b.minQuantity - a.minQuantity);
    const matchedTier = sortedDesc.find((t) => qty >= t.minQuantity);
    if (matchedTier) {
      unitPrice = matchedTier.unitPriceBDT;
    }
  }

  const totalEstimate = qty * unitPrice;
  $('modal-calc-total').textContent = formatTaka(totalEstimate);

  const baseCost = qty * p.basePriceBDT;
  const totalSavings = baseCost - totalEstimate;
  const savingsEl = $('modal-calc-savings');
  if (totalSavings > 0) {
    const pct = Math.round((totalSavings / baseCost) * 100);
    savingsEl.textContent = t('materials.calc.savingsAmount', { amount: formatTaka(totalSavings), percent: pct });
    savingsEl.hidden = false;
  } else {
    savingsEl.hidden = true;
  }
}

function render() {
  const grid = $('products-grid');
  grid.replaceChildren(...products.map(buildProductCard));

  $('catalog-empty').hidden = products.length > 0;
  $('catalog-pagination').hidden = products.length >= totalProducts;
  $('catalog-count').textContent = t('materials.count', { count: totalProducts });
}

async function loadCatalog(append = false) {
  if (!append) {
    currentPage = 1;
    $('catalog-loading').hidden = false;
    $('catalog-content').hidden = true;
  }

  try {
    const params = new URLSearchParams();
    if (activeCategory) params.set('category', activeCategory);
    if (activeDistrict) params.set('district', activeDistrict);
    if (activeSort) params.set('sort', activeSort);
    params.set('page', currentPage);
    params.set('limit', 18);

    const res = await get(`/materials/catalog?${params.toString()}`);
    const data = res?.data || {};

    if (append) {
      products.push(...(data.products || []));
    } else {
      products = data.products || [];
    }
    totalProducts = data.total || 0;

    $('catalog-loading').hidden = true;
    $('catalog-content').hidden = false;
    render();
  } catch (err) {
    $('catalog-loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
}

function setupFilters() {
  // Category tabs
  const rail = $('category-rail');
  const catButtons = rail.querySelectorAll('[data-cat]');

  catButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      catButtons.forEach((b) => {
        b.setAttribute('aria-selected', 'false');
        b.className = 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
      });
      btn.setAttribute('aria-selected', 'true');
      btn.className = 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';

      activeCategory = btn.dataset.cat || '';
      loadCatalog(false);
    });
  });

  // District filter
  $('filter-district').addEventListener('change', (e) => {
    activeDistrict = e.target.value;
    loadCatalog(false);
  });

  // Sort filter
  $('filter-sort').addEventListener('change', (e) => {
    activeSort = e.target.value;
    loadCatalog(false);
  });

  // Reset filters
  $('btn-reset-filters').addEventListener('click', () => {
    activeCategory = '';
    activeDistrict = '';
    activeSort = 'price_asc';
    $('filter-district').value = '';
    $('filter-sort').value = 'price_asc';

    catButtons.forEach((b, idx) => {
      b.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      b.className = idx === 0
        ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
        : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
    });

    loadCatalog(false);
  });

  // Load more
  $('btn-load-more').addEventListener('click', () => {
    currentPage += 1;
    loadCatalog(true);
  });

  // Modal interactions
  $('tier-modal-close').addEventListener('click', () => {
    $('tier-modal').close();
    activeModalProduct = null;
  });

  $('modal-calc-quantity').addEventListener('input', updateModalEstimate);

  // Checkout modal controls
  $('modal-btn-order').addEventListener('click', openCheckoutModal);

  $('checkout-modal-close').addEventListener('click', () => {
    $('checkout-modal').close();
    activeCheckoutProduct = null;
  });

  $('checkout-btn-cancel').addEventListener('click', () => {
    $('checkout-modal').close();
    activeCheckoutProduct = null;
  });

  $('checkout-district').addEventListener('change', updateCheckoutSummary);

  $('checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeCheckoutProduct) return;

    const alertEl = $('checkout-alert');
    alertEl.hidden = true;
    alertEl.textContent = '';

    const district = $('checkout-district').value;
    const address = $('checkout-address').value.trim();
    const receiverName = $('checkout-receiver-name').value.trim();
    const rawPhone = $('checkout-receiver-phone').value.trim();
    const unloading = $('checkout-unloading').checked;
    const notes = $('checkout-notes').value.trim();

    if (!district) {
      alertEl.textContent = t('materials.filter.district');
      alertEl.hidden = false;
      return;
    }

    if (address.length < 5 || address.length > 300) {
      alertEl.textContent = t('orders.detail.address') + ' (5-300 chars)';
      alertEl.hidden = false;
      return;
    }

    if (receiverName.length < 2 || receiverName.length > 60) {
      alertEl.textContent = t('orders.detail.receiver') + ' (2-60 chars)';
      alertEl.hidden = false;
      return;
    }

    const phone = normalizeBdPhone(rawPhone);
    if (!phone) {
      alertEl.textContent = t('orders.detail.phone');
      alertEl.hidden = false;
      return;
    }

    const submitBtn = $('checkout-btn-submit');
    submitBtn.disabled = true;

    try {
      const payload = {
        supplierId: activeCheckoutProduct.supplierId._id || activeCheckoutProduct.supplierId,
        items: [
          {
            productId: activeCheckoutProduct._id,
            quantity: activeCheckoutQty
          }
        ],
        deliveryDetails: {
          deliveryDistrict: district,
          deliveryAddress: address,
          receiverName: receiverName,
          receiverPhone: phone,
          unloadingRequired: unloading,
          buyerNotes: notes || undefined
        }
      };

      const res = await post('/materials/orders', payload);
      const order = res.data && res.data.order;
      if (order && order._id) {
        window.location.href = `/app/material-orders.html?id=${encodeURIComponent(order._id)}`;
      } else {
        window.location.href = '/app/material-orders.html';
      }
    } catch (err) {
      alertEl.textContent = err.message || t('boot.generic');
      alertEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

let activeCheckoutProduct = null;
let activeCheckoutQty = 1;
let activeCheckoutUnitPrice = 0;

function updateCheckoutSummary() {
  if (!activeCheckoutProduct) return;
  const p = activeCheckoutProduct;
  const qty = activeCheckoutQty;
  const unitName = t('materials.unit.' + p.unit.toLowerCase()) || p.unit;

  $('checkout-summary-qty').textContent = `${qty} ${unitName}`;
  $('checkout-summary-rate').textContent = `${formatTaka(activeCheckoutUnitPrice)} / ${unitName}`;

  const subtotal = qty * activeCheckoutUnitPrice;
  $('checkout-summary-subtotal').textContent = formatTaka(subtotal);

  let deliveryCharge = 0;
  if (p.deliveryTerms && p.deliveryTerms.deliveryChargeBDT) {
    deliveryCharge = p.deliveryTerms.deliveryChargeBDT;
  }
  $('checkout-summary-delivery').textContent = formatTaka(deliveryCharge);

  const platformFee = Math.round(subtotal * 0.02);
  $('checkout-summary-fee').textContent = formatTaka(platformFee);

  const total = subtotal + deliveryCharge + platformFee;
  $('checkout-summary-total').textContent = formatTaka(total);
}

async function openCheckoutModal() {
  if (!activeModalProduct) return;
  const p = activeModalProduct;

  let me = null;
  try {
    me = await getMe();
  } catch (err) {
    // transient
  }

  if (!me) {
    window.location.href = `/app/login.html?next=${encodeURIComponent(window.location.pathname)}`;
    return;
  }

  if (me.role !== 'CLIENT' && me.role !== 'CONTRACTOR') {
    alert(t('orders.checkout.unverifiedRole'));
    return;
  }

  activeCheckoutProduct = p;
  const qtyInput = $('modal-calc-quantity');
  activeCheckoutQty = parseInt(qtyInput.value, 10) || p.minOrderQuantity || 1;

  let unitPrice = p.basePriceBDT;
  if (p.bulkTiers && p.bulkTiers.length > 0) {
    const sortedDesc = [...p.bulkTiers].sort((a, b) => b.minQuantity - a.minQuantity);
    const matched = sortedDesc.find((t) => activeCheckoutQty >= t.minQuantity);
    if (matched) unitPrice = matched.unitPriceBDT;
  }
  activeCheckoutUnitPrice = unitPrice;

  $('tier-modal').close();

  $('checkout-product-name').textContent = `${p.title} (${p.brand})`;
  $('checkout-alert').hidden = true;
  $('checkout-form').reset();
  if (me.phoneNumber) {
    $('checkout-receiver-phone').value = me.phoneNumber;
  }

  updateCheckoutSummary();
  $('checkout-modal').showModal();
}

document.addEventListener('langchange', () => {
  applyLang();
  render();
});

(async () => {
  await initShell();
  setupFilters();
  await loadCatalog(false);
})();
