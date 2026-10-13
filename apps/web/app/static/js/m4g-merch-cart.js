(function () {
  const catalog = document.getElementById('m4g-merch-catalog');
  if (!catalog) return;

  const cart = {};
  const cartKey = (slot, model, size) => `${slot}|${model}|${size}`;
  const totalEl = document.getElementById('m4g-merch-total');
  const countEl = document.getElementById('m4g-merch-items-count');
  const payBtn = document.getElementById('m4g-merch-pay-btn');
  const cartInput = document.getElementById('m4g-merch-cart-json');

  const formatEuro = (cents) =>
    new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);

  function renderCart() {
    const lines = Object.values(cart);
    const totalCents = lines.reduce((sum, line) => sum + line.price_cents * line.quantity, 0);
    const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
    if (totalEl) totalEl.textContent = formatEuro(totalCents);
    if (countEl) {
      countEl.textContent = itemCount ? `${itemCount} articoli` : 'Nessun articolo';
    }
    if (payBtn) payBtn.disabled = itemCount === 0;
    if (cartInput) cartInput.value = JSON.stringify(lines);
  }

  catalog.querySelectorAll('.m4g-merch-product').forEach((card) => {
    const slot = card.dataset.merchSlot;
    const priceCents = Number(card.dataset.priceCents || 0);
    const title = card.querySelector('h2')?.textContent?.trim() || slot;
    const addBtn = card.querySelector('.m4g-merch-add-btn');
    const modelSelect = card.querySelector('.m4g-merch-select-model');
    const sizeSelect = card.querySelector('.m4g-merch-select-size');

    addBtn?.addEventListener('click', () => {
      const model = modelSelect?.value || '';
      const size = sizeSelect?.value || '';
      const key = cartKey(slot, model, size);
      const nameBits = [title];
      if (model) nameBits.push(`modello ${model}`);
      if (size) nameBits.push(`taglia ${size}`);
      const existing = cart[key];
      if (existing) {
        existing.quantity = Math.min(20, existing.quantity + 1);
      } else {
        cart[key] = {
          slot,
          model,
          size,
          name: nameBits.join(' · '),
          price_cents: priceCents,
          quantity: 1,
        };
      }
      renderCart();
    });
  });

  renderCart();

  const lightbox = document.getElementById('m4g-merch-lightbox');
  const lightboxImg = lightbox && lightbox.querySelector('.m4g-merch-lightbox__img');
  const lightboxCaption = lightbox && lightbox.querySelector('.m4g-merch-lightbox__caption');
  const lightboxClose = lightbox && lightbox.querySelector('.m4g-merch-lightbox__close');

  function openLightbox(img, caption) {
    if (!lightbox || !lightboxImg || !img) return;
    const full = img.currentSrc || img.src;
    lightboxImg.src = full;
    lightboxImg.alt = img.alt || '';
    if (lightboxCaption) lightboxCaption.textContent = caption || '';
    lightbox.hidden = false;
    document.body.classList.add('m4g-merch-lightbox-open');
    lightboxClose && lightboxClose.focus();
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true;
    if (lightboxImg) lightboxImg.src = '';
    document.body.classList.remove('m4g-merch-lightbox-open');
  }

  lightboxClose && lightboxClose.addEventListener('click', closeLightbox);
  lightbox && lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox();
  });

  catalog.querySelectorAll('[data-m4g-merch-hero]').forEach((hero) => {
    const card = hero.closest('.m4g-merch-product');
    if (!card) return;
    const select = card.querySelector('[data-m4g-merch-select]');
    const buttons = card.querySelectorAll('[data-m4g-merch-model]');
    const heroPanes = hero.querySelectorAll('[data-m4g-merch-hero-model]');
    function setActive(model) {
      buttons.forEach((btn) => {
        const on = btn.getAttribute('data-m4g-merch-model') === model;
        btn.classList.toggle('m4g-merch-model--active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      heroPanes.forEach((pane) => {
        const on = pane.getAttribute('data-m4g-merch-hero-model') === model;
        pane.classList.toggle('m4g-merch-hero__pane--active', on);
        pane.setAttribute('aria-hidden', on ? 'false' : 'true');
      });
      if (select) select.value = model;
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        setActive(btn.getAttribute('data-m4g-merch-model') || '');
      });
    });
    heroPanes.forEach((pane) => {
      pane.addEventListener('click', () => {
        const img = pane.querySelector('.m4g-figure__img');
        const label = pane.querySelector('.m4g-merch-hero__label');
        openLightbox(img, label ? label.textContent.trim() : '');
      });
    });
    select && select.addEventListener('change', () => setActive(select.value));
  });
})();
