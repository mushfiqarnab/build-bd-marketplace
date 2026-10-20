// frontend/js/components/deliveryConfirmSheet.js
// 🧱 Phase 3: Material Delivery Confirmation Sheet
// Records material delivery, calculates truck CFT dimensions, links BSTI licences, and attaches chalan evidence.
// 100% pure DOM architecture (zero innerHTML/insertAdjacentHTML), WCAG AA compliant.
'use strict';

import { t } from '../i18n.js';

export function showDeliveryConfirmSheet({
  projectId,
  milestoneId = null,
  plannedMaterials = [],
  onSubmit = () => {},
  onCancel = () => {}
}) {
  let dialog = document.getElementById('delivery-confirm-dialog');
  if (dialog) dialog.remove();

  dialog = document.createElement('dialog');
  dialog.id = 'delivery-confirm-dialog';
  dialog.className = 'modal-dialog rounded-card p-0 w-full max-w-lg bg-surface border border-outline-variant shadow-elevation-3 backdrop:bg-slate-950/60';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'delivery-sheet-title');

  const wrapper = document.createElement('div');
  wrapper.className = 'p-md sm:p-lg space-y-md max-h-[85vh] overflow-y-auto';

  // Header row
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between border-b border-border-subtle pb-sm';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'flex items-center gap-xs';

  const icon = document.createElement('span');
  icon.className = 'icon text-primary text-[22px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'local_shipping';

  const h2 = document.createElement('h2');
  h2.id = 'delivery-sheet-title';
  h2.className = 'text-title-md font-bold text-on-surface';
  h2.textContent = t('deliverySheet.title');

  titleGroup.append(icon, h2);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-ghost min-h-[44px] min-w-[44px] flex items-center justify-center p-xs';
  closeBtn.setAttribute('aria-label', t('common.close'));

  const closeIcon = document.createElement('span');
  closeIcon.className = 'icon';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeIcon.textContent = 'close';
  closeBtn.append(closeIcon);

  header.append(titleGroup, closeBtn);

  // Form container
  const form = document.createElement('form');
  form.className = 'space-y-md';
  form.noValidate = true;

  // Category
  const catGroup = document.createElement('div');
  catGroup.className = 'space-y-xs';

  const catLabel = document.createElement('label');
  catLabel.className = 'field-label';
  catLabel.textContent = t('deliverySheet.categoryLabel');

  const catSelect = document.createElement('select');
  catSelect.className = 'input min-h-[44px]';
  const categories = ['CEMENT', 'STEEL', 'SAND', 'BRICKS', 'STONE_AGGREGATE', 'TILES', 'PAINT', 'PLUMBING', 'ELECTRICAL', 'OTHER'];
  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = t(`category.${cat}`) || cat;
    catSelect.append(opt);
  }
  catGroup.append(catLabel, catSelect);

  // Item Name
  const nameGroup = document.createElement('div');
  nameGroup.className = 'space-y-xs';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'field-label';
  nameLabel.textContent = t('deliverySheet.itemNameLabel');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'input min-h-[44px]';
  nameInput.required = true;
  nameInput.placeholder = t('deliverySheet.itemNamePlaceholder');
  nameGroup.append(nameLabel, nameInput);

  // Planned Specs (Collapsible or optional)
  const plannedBox = document.createElement('fieldset');
  plannedBox.className = 'p-sm rounded-lg bg-surface-container border border-outline-variant space-y-xs';

  const plannedLegend = document.createElement('legend');
  plannedLegend.className = 'text-label-sm font-semibold text-on-surface-variant px-1';
  plannedLegend.textContent = t('deliverySheet.plannedSpecTitle');
  plannedBox.append(plannedLegend);

  const planRow = document.createElement('div');
  planRow.className = 'grid grid-cols-2 gap-xs';

  const planBrand = document.createElement('input');
  planBrand.type = 'text';
  planBrand.className = 'input min-h-[44px] text-body-sm';
  planBrand.placeholder = t('deliverySheet.brandPlaceholder');

  const planQty = document.createElement('input');
  planQty.type = 'number';
  planQty.className = 'input min-h-[44px] text-body-sm';
  planQty.placeholder = t('deliverySheet.qtyPlaceholder');

  planRow.append(planBrand, planQty);
  plannedBox.append(planRow);

  // Actual Delivery Specs
  const actualBox = document.createElement('fieldset');
  actualBox.className = 'p-sm rounded-lg bg-surface-container border border-outline-variant space-y-xs';

  const actualLegend = document.createElement('legend');
  actualLegend.className = 'text-label-sm font-semibold text-primary px-1';
  actualLegend.textContent = t('deliverySheet.actualSpecTitle');
  actualBox.append(actualLegend);

  const actualRow1 = document.createElement('div');
  actualRow1.className = 'grid grid-cols-2 gap-xs';

  const actualBrand = document.createElement('input');
  actualBrand.type = 'text';
  actualBrand.className = 'input min-h-[44px] text-body-sm';
  actualBrand.placeholder = t('deliverySheet.actualBrandPlaceholder');
  actualBrand.required = true;

  const actualGrade = document.createElement('input');
  actualGrade.type = 'text';
  actualGrade.className = 'input min-h-[44px] text-body-sm';
  actualGrade.placeholder = t('deliverySheet.actualGradePlaceholder');

  actualRow1.append(actualBrand, actualGrade);

  const actualRow2 = document.createElement('div');
  actualRow2.className = 'grid grid-cols-3 gap-xs';

  const actualQty = document.createElement('input');
  actualQty.type = 'number';
  actualQty.className = 'input min-h-[44px] text-body-sm';
  actualQty.placeholder = t('deliverySheet.actualQtyPlaceholder');
  actualQty.required = true;

  const actualUnit = document.createElement('input');
  actualUnit.type = 'text';
  actualUnit.className = 'input min-h-[44px] text-body-sm';
  actualUnit.placeholder = t('deliverySheet.unitPlaceholder');
  actualUnit.value = 'CFT';

  const actualRate = document.createElement('input');
  actualRate.type = 'number';
  actualRate.className = 'input min-h-[44px] text-body-sm';
  actualRate.placeholder = t('deliverySheet.unitPricePlaceholder');

  actualRow2.append(actualQty, actualUnit, actualRate);
  actualBox.append(actualRow1, actualRow2);

  // Truck Dimension Calculator (CFT)
  const truckBox = document.createElement('div');
  truckBox.className = 'p-sm rounded-lg bg-primary-fixed/30 border border-primary/20 space-y-xs';

  const truckHeader = document.createElement('div');
  truckHeader.className = 'flex items-center justify-between';

  const truckTitle = document.createElement('span');
  truckTitle.className = 'text-label-sm font-semibold text-on-primary-fixed';
  truckTitle.textContent = t('deliverySheet.truckDimensionsTitle');

  const cftDisplay = document.createElement('span');
  cftDisplay.className = 'text-label-sm font-bold text-primary font-mono';
  cftDisplay.textContent = '0 CFT';

  truckHeader.append(truckTitle, cftDisplay);

  const dimRow = document.createElement('div');
  dimRow.className = 'grid grid-cols-3 gap-xs';

  const lenInput = document.createElement('input');
  lenInput.type = 'number';
  lenInput.step = '0.1';
  lenInput.className = 'input min-h-[44px] text-body-sm';
  lenInput.placeholder = t('deliverySheet.lengthFt');

  const widInput = document.createElement('input');
  widInput.type = 'number';
  widInput.step = '0.1';
  widInput.className = 'input min-h-[44px] text-body-sm';
  widInput.placeholder = t('deliverySheet.widthFt');

  const hgtInput = document.createElement('input');
  hgtInput.type = 'number';
  hgtInput.step = '0.1';
  hgtInput.className = 'input min-h-[44px] text-body-sm';
  hgtInput.placeholder = t('deliverySheet.heightFt');

  function updateCft() {
    const l = parseFloat(lenInput.value) || 0;
    const w = parseFloat(widInput.value) || 0;
    const h = parseFloat(hgtInput.value) || 0;
    if (l > 0 && w > 0 && h > 0) {
      const cft = Math.round(l * w * h * 100) / 100;
      cftDisplay.textContent = `${cft} CFT`;
      if (actualUnit.value.toUpperCase() === 'CFT' && !actualQty.value) {
        actualQty.value = cft;
      }
    } else {
      cftDisplay.textContent = '0 CFT';
    }
  }

  lenInput.addEventListener('input', updateCft);
  widInput.addEventListener('input', updateCft);
  hgtInput.addEventListener('input', updateCft);

  dimRow.append(lenInput, widInput, hgtInput);
  truckBox.append(truckHeader, dimRow);

  // Supplier & Chalan Details
  const supplierBox = document.createElement('div');
  supplierBox.className = 'space-y-xs';

  const chalanInput = document.createElement('input');
  chalanInput.type = 'text';
  chalanInput.className = 'input min-h-[44px] text-body-sm';
  chalanInput.placeholder = t('deliverySheet.chalanNoPlaceholder');

  const dealerInput = document.createElement('input');
  dealerInput.type = 'text';
  dealerInput.className = 'input min-h-[44px] text-body-sm';
  dealerInput.placeholder = t('deliverySheet.dealerNamePlaceholder');

  const bstiRow = document.createElement('div');
  bstiRow.className = 'flex items-center gap-xs';

  const bstiInput = document.createElement('input');
  bstiInput.type = 'text';
  bstiInput.className = 'input min-h-[44px] text-body-sm flex-1';
  bstiInput.placeholder = t('deliverySheet.bstiLicensePlaceholder');

  const bstiLink = document.createElement('a');
  bstiLink.href = 'http://bsti.gov.bd';
  bstiLink.target = '_blank';
  bstiLink.rel = 'noopener noreferrer';
  bstiLink.className = 'btn-outline min-h-[44px] px-sm flex items-center gap-1 text-[12px] whitespace-nowrap text-primary';
  bstiLink.textContent = t('deliverySheet.bstiCheckLink');

  bstiRow.append(bstiInput, bstiLink);
  supplierBox.append(chalanInput, dealerInput, bstiRow);

  // Submit button
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-primary min-h-[44px] w-full flex items-center justify-center gap-xs';

  const subIcon = document.createElement('span');
  subIcon.className = 'icon';
  subIcon.setAttribute('aria-hidden', 'true');
  subIcon.textContent = 'check_circle';

  const subText = document.createElement('span');
  subText.textContent = t('deliverySheet.btnSubmitDelivery');

  submitBtn.append(subIcon, subText);

  // Form submit handler
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const l = parseFloat(lenInput.value) || 0;
    const w = parseFloat(widInput.value) || 0;
    const h = parseFloat(hgtInput.value) || 0;
    const cft = l > 0 && w > 0 && h > 0 ? Math.round(l * w * h * 100) / 100 : 0;

    const payload = {
      projectId,
      milestoneId,
      category: catSelect.value,
      itemName: nameInput.value.trim(),
      plannedSpec: {
        brand: planBrand.value.trim(),
        plannedQty: parseFloat(planQty.value) || 0,
        unit: actualUnit.value.trim()
      },
      actualSpec: {
        brand: actualBrand.value.trim(),
        gradeSpec: actualGrade.value.trim(),
        unit: actualUnit.value.trim(),
        actualQty: parseFloat(actualQty.value) || (cft > 0 ? cft : 0),
        actualUnitPrice: parseInt(actualRate.value, 10) || 0
      },
      truckDimensions: {
        lengthFt: l,
        widthFt: w,
        heightFt: h,
        calculatedCft: cft
      },
      supplierInfo: {
        dealerName: dealerInput.value.trim(),
        chalanNo: chalanInput.value.trim(),
        bstiLicenseNo: bstiInput.value.trim()
      }
    };

    dialog.close();
    dialog.remove();
    onSubmit(payload);
  });

  form.append(catGroup, nameGroup, plannedBox, actualBox, truckBox, supplierBox, submitBtn);
  wrapper.append(header, form);
  dialog.append(wrapper);

  closeBtn.addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    onCancel();
  });

  dialog.addEventListener('cancel', () => {
    dialog.remove();
    onCancel();
  });

  document.body.append(dialog);
  dialog.showModal();
}
