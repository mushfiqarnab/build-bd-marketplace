// frontend/js/pages/material-orders.js — Materials Orders & Delivery Escrow Workspace
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — zero innerHTML.
//   - Network via ../api.js (get, post, patch).
//   - All copy via t() with en and bn keys.
//   - All money via formatTaka().
//   - Zero "কার্যদিবস" (always use calendar days).
//   - Touch targets >= 44px floor on all buttons, tabs, inputs.

import { initShell } from '../shell.js';
import { get, post, patch } from '../api.js';
import { t, applyLang, formatTaka } from '../i18n.js';
import { getMe } from '../session.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let activeOrder = null;
let activeOrdersList = [];
let activeFilterStatus = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

function getStatusBadgeStyle(status) {
  switch (status) {
    case 'PENDING_SUPPLIER_ACCEPTANCE':
      return 'bg-cta-amber/20 text-on-surface border border-cta-amber/40';
    case 'ACCEPTED':
      return 'bg-primary-fixed text-primary border border-primary/30';
    case 'ESCROW_FUNDED':
      return 'bg-primary text-on-primary font-bold';
    case 'IN_TRANSIT':
    case 'DISPATCHED':
      return 'bg-blue-100 text-blue-800 border border-blue-300';
    case 'DELIVERED':
      return 'bg-emerald-100 text-emerald-800 border border-emerald-300';
    case 'COMPLETED':
      return 'bg-primary-container text-on-primary-container font-bold';
    case 'DISPUTED':
      return 'bg-error/20 text-error border border-error/40 font-bold';
    case 'REJECTED':
    case 'CANCELLED':
      return 'bg-surface-variant text-on-surface-variant border border-border-subtle';
    default:
      return 'bg-surface-container text-on-surface';
  }
}

function getStatusLabel(status) {
  if (status === 'IN_TRANSIT') return t('orders.status.IN_TRANSIT') || t('orders.status.DISPATCHED') || status;
  return t(`orders.status.${status}`) || status;
}

function renderOrderCard(order) {
  const li = el('li');
  const card = el('article', 'card p-md flex flex-col sm:flex-row sm:items-center justify-between gap-md');

  const left = el('div', 'flex flex-col gap-xs flex-1');
  const topRow = el('div', 'flex items-center gap-sm flex-wrap');

  const orderNum = el('span', 'font-mono font-bold text-body-md text-on-surface', `#${order._id.slice(-8).toUpperCase()}`);
  const statusPill = el('span', `inline-flex items-center px-sm py-[2px] rounded text-label-sm ${getStatusBadgeStyle(order.status)}`);
  statusPill.textContent = getStatusLabel(order.status);
  topRow.append(orderNum, statusPill);

  // Counterparty and items info
  const isBuyer = currentUser && String(order.buyerUserId?._id || order.buyerUserId) === String(currentUser._id || currentUser.id);
  const counterpartyName = isBuyer
    ? (order.supplierId?.businessName || t('orders.supplier', { name: 'Supplier' }))
    : (order.buyerUserId?.phoneNumber || t('orders.buyer', { name: 'Buyer' }));

  const metaText = el('p', 'text-body-sm text-on-surface-variant');
  const itemsCount = order.items?.length || 0;
  metaText.textContent = `${counterpartyName} • ${t('orders.itemsCount', { count: itemsCount })}`;

  const dateText = el('p', 'text-label-sm text-on-surface-variant');
  if (order.createdAt) {
    const d = new Date(order.createdAt);
    dateText.textContent = d.toLocaleDateString();
  }

  left.append(topRow, metaText, dateText);

  // Right block: Total and View Link
  const right = el('div', 'flex items-center sm:flex-col sm:items-end justify-between gap-sm');
  const totalVal = el('span', 'text-h3 font-bold text-primary', formatTaka(order.totalAmountBDT));

  const viewBtn = el('a', 'btn-outline min-h-[44px] px-md inline-flex items-center justify-center gap-xs text-body-sm font-semibold');
  viewBtn.href = `/app/material-orders.html?id=${encodeURIComponent(order._id)}`;
  viewBtn.textContent = t('orders.viewDetails');

  right.append(totalVal, viewBtn);
  card.append(left, right);
  li.append(card);
  return li;
}

async function loadOrdersList() {
  const loading = $('loading');
  const listView = $('orders-list-view');
  const detailView = $('order-detail-view');
  loading.hidden = false;
  listView.hidden = true;
  detailView.hidden = true;

  try {
    const query = activeFilterStatus ? `?status=${encodeURIComponent(activeFilterStatus)}` : '';
    const res = await get(`/materials/orders${query}`);
    activeOrdersList = (res && res.data && res.data.orders) || [];

    const listEl = $('orders-list');
    listEl.replaceChildren(...activeOrdersList.map(renderOrderCard));

    $('orders-empty').hidden = activeOrdersList.length > 0;
    loading.hidden = true;
    listView.hidden = false;
  } catch (err) {
    loading.hidden = true;
    const alertEl = $('alert');
    alertEl.textContent = err.message || t('boot.generic');
    alertEl.hidden = false;
  }
}

async function loadOrderDetail(orderId) {
  const loading = $('loading');
  const listView = $('orders-list-view');
  const detailView = $('order-detail-view');
  loading.hidden = false;
  listView.hidden = true;
  detailView.hidden = true;

  try {
    const res = await get(`/materials/orders/${orderId}`);
    activeOrder = res && res.data && res.data.order;
    if (!activeOrder) throw new Error('Order not found');

    renderOrderDetail(activeOrder);
    loading.hidden = true;
    detailView.hidden = false;
  } catch (err) {
    loading.hidden = true;
    const alertEl = $('alert');
    alertEl.textContent = err.message || t('boot.generic');
    alertEl.hidden = false;
  }
}

function renderOrderDetail(order) {
  $('detail-order-number').textContent = `Order #${order._id.slice(-8).toUpperCase()}`;
  $('detail-created-at').textContent = order.createdAt ? new Date(order.createdAt).toLocaleString() : '';

  const statusPill = $('detail-status-pill');
  statusPill.className = `inline-flex items-center rounded-md px-sm py-xs text-body-sm font-semibold ${getStatusBadgeStyle(order.status)}`;
  statusPill.textContent = getStatusLabel(order.status);

  // Dispute alert banner
  const disputeAlert = $('detail-dispute-alert');
  const disputeObj = order.disputeDetails || order.dispute;
  if (order.status === 'DISPUTED' && disputeObj) {
    disputeAlert.hidden = false;
    $('detail-dispute-reason').textContent = t('orders.detail.disputeReason', { reason: disputeObj.reason || '' });
    const claimantRole = disputeObj.claimantRole || (String(disputeObj.raisedBy) === String(order.buyerUserId?._id || order.buyerUserId) ? 'BUYER' : 'SUPPLIER');
    $('detail-dispute-claimant').textContent = t('orders.detail.disputeClaimant', { claimant: claimantRole });
  } else {
    disputeAlert.hidden = true;
  }

  // Parties
  $('detail-supplier-name').textContent = order.supplierId?.businessName || 'Verified Supplier';
  $('detail-buyer-name').textContent = order.buyerUserId?.phoneNumber || 'Buyer';

  // Line items
  const tbody = $('detail-items-body');
  tbody.replaceChildren();

  for (const it of order.items || []) {
    const tr = el('tr', 'border-b border-border-subtle');
    const tdProduct = el('td', 'py-xs pr-sm');
    tdProduct.append(
      el('span', 'font-semibold text-on-surface block', it.title),
      el('span', 'text-label-sm text-on-surface-variant', it.brand)
    );

    const tdQty = el('td', 'py-xs px-sm font-medium', `${it.quantity} ${it.unit}`);
    const tdRate = el('td', 'py-xs px-sm');
    tdRate.append(
      el('span', 'font-semibold text-on-surface block', `${formatTaka(it.unitPriceBDT)} / ${it.unit}`),
      it.tierDiscountPercent > 0 ? el('span', 'badge-category bg-cta-amber/30 text-[10px] font-bold text-on-surface', `-${it.tierDiscountPercent}% Tier`) : el('span')
    );

    const tdTotal = el('td', 'py-xs pl-sm text-right font-bold text-primary', formatTaka(it.totalPriceBDT ?? it.subtotalBDT ?? 0));

    tr.append(tdProduct, tdQty, tdRate, tdTotal);
    tbody.append(tr);
  }

  // Totals
  $('detail-subtotal-val').textContent = formatTaka(order.itemsSubtotalBDT);
  $('detail-delivery-val').textContent = formatTaka(order.deliveryChargeBDT);
  $('detail-platform-fee-val').textContent = formatTaka(order.platformFeeBDT);
  $('detail-total-escrow-val').textContent = formatTaka(order.totalAmountBDT);

  // Delivery details
  const dd = order.deliveryDetails || {};
  $('detail-address-val').textContent = dd.deliveryAddress || '—';
  $('detail-district-val').textContent = dd.deliveryDistrict || '—';
  $('detail-receiver-val').textContent = dd.receiverName || '—';
  $('detail-phone-val').textContent = dd.receiverPhone || '—';
  $('detail-unloading-row').hidden = !dd.unloadingRequired;

  // Waybill / Logistics
  const lg = order.logistics || {};
  const challanNo = lg.challanNumber || dd.challanNumber;
  const waybillCard = $('detail-waybill-card');
  if (['IN_TRANSIT', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'DISPUTED'].includes(order.status) && challanNo) {
    waybillCard.hidden = false;
    $('detail-waybill-carrier').textContent = lg.carrierName || dd.carrierName || '—';
    $('detail-waybill-challan').textContent = challanNo || '—';
    $('detail-waybill-truck').textContent = lg.vehicleNumber || lg.truckNumber || dd.truckNumber || '—';
    $('detail-waybill-driver').textContent = lg.driverPhone || dd.driverPhone || '—';

    const proofNotes = lg.deliveryProofNotes || dd.deliveryProofNotes || '';
    if (proofNotes) {
      $('detail-waybill-proof-wrap').hidden = false;
      $('detail-waybill-proof').textContent = proofNotes;
    } else {
      $('detail-waybill-proof-wrap').hidden = true;
    }
  } else {
    waybillCard.hidden = true;
  }

  // Render Action buttons based on status and user role
  renderOrderActions(order);
}

function renderOrderActions(order) {
  const container = $('actions-container');
  container.replaceChildren();

  const isBuyer = currentUser && String(order.buyerUserId?._id || order.buyerUserId) === String(currentUser._id || currentUser.id);
  const isSupplier = currentUser && (
    String(order.supplierId?.userId) === String(currentUser._id || currentUser.id) ||
    currentUser.role === 'SUPPLIER'
  );

  // 1. PENDING_SUPPLIER_ACCEPTANCE
  if (order.status === 'PENDING_SUPPLIER_ACCEPTANCE') {
    if (isSupplier) {
      const btnAccept = el('button', 'btn-primary min-h-[44px] px-md flex items-center gap-xs font-semibold');
      const acceptIcon = el('span', 'icon text-[18px]', 'check_circle');
      acceptIcon.setAttribute('aria-hidden', 'true');
      btnAccept.append(acceptIcon, el('span', '', t('orders.action.accept')));
      btnAccept.addEventListener('click', () => handleSupplierAccept(order._id));

      const btnReject = el('button', 'btn-outline min-h-[44px] px-md flex items-center gap-xs text-error border-error/50');
      const rejectIcon = el('span', 'icon text-[18px]', 'close');
      rejectIcon.setAttribute('aria-hidden', 'true');
      btnReject.append(rejectIcon, el('span', '', t('orders.action.reject')));
      btnReject.addEventListener('click', () => {
        $('modal-reject').showModal();
      });

      container.append(btnAccept, btnReject);
    } else {
      container.append(el('p', 'text-body-sm text-on-surface-variant', t('orders.status.PENDING_SUPPLIER_ACCEPTANCE')));
    }
  }

  // 2. ACCEPTED (Awaiting Escrow)
  else if (order.status === 'ACCEPTED') {
    if (isBuyer) {
      const btnFund = el('button', 'btn-primary min-h-[44px] px-lg flex items-center gap-xs font-semibold');
      const fundIcon = el('span', 'icon text-[18px]', 'local_atm');
      fundIcon.setAttribute('aria-hidden', 'true');
      btnFund.append(fundIcon, el('span', '', t('orders.action.fundEscrow', { amount: formatTaka(order.totalAmountBDT) })));
      btnFund.addEventListener('click', () => handleFundEscrow(order._id));
      container.append(btnFund);
    } else {
      container.append(el('p', 'text-body-sm text-on-surface-variant', t('orders.status.ACCEPTED')));
    }
  }

  // 3. ESCROW_FUNDED (Ready to Dispatch)
  else if (order.status === 'ESCROW_FUNDED') {
    if (isSupplier) {
      const btnDispatch = el('button', 'btn-primary min-h-[44px] px-md flex items-center gap-xs font-semibold');
      const dispatchIcon = el('span', 'icon text-[18px]', 'schedule');
      dispatchIcon.setAttribute('aria-hidden', 'true');
      btnDispatch.append(dispatchIcon, el('span', '', t('orders.action.dispatch')));
      btnDispatch.addEventListener('click', () => {
        $('modal-dispatch').showModal();
      });
      container.append(btnDispatch);
    }

    // Both can dispute
    const btnDispute = el('button', 'btn-outline min-h-[44px] px-md flex items-center gap-xs text-error border-error/50');
    const disputeIcon = el('span', 'icon text-[18px]', 'warning');
    disputeIcon.setAttribute('aria-hidden', 'true');
    btnDispute.append(disputeIcon, el('span', '', t('orders.action.openDispute')));
    btnDispute.addEventListener('click', () => {
      $('modal-dispute').showModal();
    });
    container.append(btnDispute);
  }

  // 4. IN_TRANSIT / DISPATCHED (In transit)
  else if (order.status === 'IN_TRANSIT' || order.status === 'DISPATCHED') {
    if (isSupplier) {
      const btnDeliver = el('button', 'btn-primary min-h-[44px] px-md flex items-center gap-xs font-semibold');
      const deliverIcon = el('span', 'icon text-[18px]', 'location_on');
      deliverIcon.setAttribute('aria-hidden', 'true');
      btnDeliver.append(deliverIcon, el('span', '', t('orders.action.markDelivered')));
      btnDeliver.addEventListener('click', () => {
        $('modal-deliver').showModal();
      });
      container.append(btnDeliver);
    }

    const btnDispute = el('button', 'btn-outline min-h-[44px] px-md flex items-center gap-xs text-error border-error/50');
    const disputeIcon = el('span', 'icon text-[18px]', 'warning');
    disputeIcon.setAttribute('aria-hidden', 'true');
    btnDispute.append(disputeIcon, el('span', '', t('orders.action.openDispute')));
    btnDispute.addEventListener('click', () => {
      $('modal-dispute').showModal();
    });
    container.append(btnDispute);
  }

  // 5. DELIVERED (Arrived at site, awaiting buyer inspection)
  else if (order.status === 'DELIVERED') {
    if (isBuyer) {
      const btnConfirm = el('button', 'btn-primary min-h-[44px] px-lg flex items-center gap-xs font-semibold');
      const confirmIcon = el('span', 'icon text-[18px]', 'check_circle');
      confirmIcon.setAttribute('aria-hidden', 'true');
      btnConfirm.append(confirmIcon, el('span', '', t('orders.action.confirmDelivery')));
      btnConfirm.addEventListener('click', () => handleConfirmDelivery(order._id));
      container.append(btnConfirm);
    }

    const btnDispute = el('button', 'btn-outline min-h-[44px] px-md flex items-center gap-xs text-error border-error/50');
    const disputeIcon = el('span', 'icon text-[18px]', 'warning');
    disputeIcon.setAttribute('aria-hidden', 'true');
    btnDispute.append(disputeIcon, el('span', '', t('orders.action.openDispute')));
    btnDispute.addEventListener('click', () => {
      $('modal-dispute').showModal();
    });
    container.append(btnDispute);
  }

  // 6. COMPLETED
  else if (order.status === 'COMPLETED') {
    const completedBadge = el('span', 'text-primary font-bold flex items-center gap-xs');
    const icon = el('span', 'icon text-[20px]', 'check_circle');
    icon.setAttribute('aria-hidden', 'true');
    completedBadge.append(icon, el('span', '', t('orders.status.COMPLETED')));
    container.append(completedBadge);
  }

  // 7. DISPUTED
  else if (order.status === 'DISPUTED') {
    const disputedNotice = el('span', 'text-error font-bold flex items-center gap-xs');
    const icon = el('span', 'icon text-[20px]', 'warning');
    icon.setAttribute('aria-hidden', 'true');
    disputedNotice.append(icon, el('span', '', t('orders.status.DISPUTED')));
    container.append(disputedNotice);
  }
}

// ── Action Handlers ──

async function handleSupplierAccept(orderId) {
  if (!confirm(t('orders.action.accept') + '?')) return;
  try {
    await patch(`/materials/orders/${orderId}/accept`);
    await loadOrderDetail(orderId);
  } catch (err) {
    alert(err.message || t('boot.generic'));
  }
}

async function handleFundEscrow(orderId) {
  if (!confirm(t('orders.action.fundEscrow', { amount: '' }) + '?')) return;
  try {
    await post(`/materials/orders/${orderId}/fund-escrow`);
    await loadOrderDetail(orderId);
  } catch (err) {
    alert(err.message || t('boot.generic'));
  }
}

async function handleConfirmDelivery(orderId) {
  if (!confirm(t('orders.action.confirmDelivery') + '?')) return;
  try {
    await post(`/materials/orders/${orderId}/confirm-delivery`);
    await loadOrderDetail(orderId);
  } catch (err) {
    alert(err.message || t('boot.generic'));
  }
}

function setupTabFilters() {
  const tablist = $('orders-tablist');
  const tabs = tablist.querySelectorAll('[data-status]');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.setAttribute('aria-selected', 'false');
        t.className = 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
      });
      tab.setAttribute('aria-selected', 'true');
      tab.className = 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';

      activeFilterStatus = tab.dataset.status || '';
      loadOrdersList();
    });
  });
}

function setupModals() {
  // Reject modal
  $('modal-reject-close').addEventListener('click', () => $('modal-reject').close());
  $('btn-reject-cancel').addEventListener('click', () => $('modal-reject').close());
  $('form-reject').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-reject-submit');
    const reason = $('reject-reason').value.trim();
    if (reason.length < 5) return;
    busy(btn, true);
    try {
      await patch(`/materials/orders/${activeOrder._id}/reject`, { rejectionReason: reason });
      $('modal-reject').close();
      await loadOrderDetail(activeOrder._id);
    } catch (err) {
      $('reject-alert').textContent = err.message || t('boot.generic');
      $('reject-alert').hidden = false;
    } finally {
      busy(btn, false);
    }
  });

  // Dispatch modal
  $('modal-dispatch-close').addEventListener('click', () => $('modal-dispatch').close());
  $('btn-dispatch-cancel').addEventListener('click', () => $('modal-dispatch').close());
  $('form-dispatch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-dispatch-submit');
    const carrierName = $('dispatch-carrier').value.trim();
    const challanNumber = $('dispatch-challan').value.trim();
    const truckNumber = $('dispatch-truck').value.trim();
    const driverPhone = $('dispatch-driver').value.trim();

    busy(btn, true);
    try {
      await post(`/materials/orders/${activeOrder._id}/dispatch`, {
        carrierName,
        challanNumber,
        truckNumber: truckNumber || undefined,
        driverPhone: driverPhone || undefined
      });
      $('modal-dispatch').close();
      await loadOrderDetail(activeOrder._id);
    } catch (err) {
      $('dispatch-alert').textContent = err.message || t('boot.generic');
      $('dispatch-alert').hidden = false;
    } finally {
      busy(btn, false);
    }
  });

  // Mark delivered modal
  $('modal-deliver-close').addEventListener('click', () => $('modal-deliver').close());
  $('btn-deliver-cancel').addEventListener('click', () => $('modal-deliver').close());
  $('form-deliver').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-deliver-submit');
    const notes = $('deliver-proof').value.trim();
    busy(btn, true);
    try {
      await post(`/materials/orders/${activeOrder._id}/mark-delivered`, {
        deliveryProofNotes: notes || undefined
      });
      $('modal-deliver').close();
      await loadOrderDetail(activeOrder._id);
    } catch (err) {
      $('deliver-alert').textContent = err.message || t('boot.generic');
      $('deliver-alert').hidden = false;
    } finally {
      busy(btn, false);
    }
  });

  // Dispute modal
  $('modal-dispute-close').addEventListener('click', () => $('modal-dispute').close());
  $('btn-dispute-cancel').addEventListener('click', () => $('modal-dispute').close());
  $('form-dispute').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-dispute-submit');
    const reason = $('dispute-reason').value.trim();
    if (reason.length < 10) return;
    busy(btn, true);
    try {
      await post(`/materials/orders/${activeOrder._id}/dispute`, { reason });
      $('modal-dispute').close();
      await loadOrderDetail(activeOrder._id);
    } catch (err) {
      $('dispute-alert').textContent = err.message || t('boot.generic');
      $('dispute-alert').hidden = false;
    } finally {
      busy(btn, false);
    }
  });
}

document.addEventListener('langchange', () => {
  applyLang();
  if (activeOrder) renderOrderDetail(activeOrder);
});

(async () => {
  await initShell();
  try {
    currentUser = await getMe();
  } catch (err) {
    // transient
  }

  if (!currentUser) {
    window.location.href = `/app/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return;
  }

  setupTabFilters();
  setupModals();

  const urlParams = new URLSearchParams(window.location.search);
  const orderId = urlParams.get('id');

  if (orderId) {
    await loadOrderDetail(orderId);
  } else {
    await loadOrdersList();
  }
})();
