(function () {
  const menuRoot = document.getElementById('m4g-menu');
  if (menuRoot) {
    const cart = {};
    const totalEl = document.getElementById('m4g-total');
    const countEl = document.getElementById('m4g-items-count');
    const payBtn = document.getElementById('m4g-pay-btn');
    const cartInput = document.getElementById('m4g-cart-json');
    const names = {};

    menuRoot.querySelectorAll('.m4g-item').forEach((row) => {
      const id = row.dataset.itemId;
      const priceCents = Number(row.dataset.priceCents || 0);
      const name = row.querySelector('.m4g-item__name')?.textContent?.trim() || id;
      names[id] = name;
      const valueEl = row.querySelector('.m4g-qty__value');
      const minus = row.querySelector('.m4g-qty__minus');
      const plus = row.querySelector('.m4g-qty__plus');

      const syncRow = () => {
        const qty = cart[id] || 0;
        valueEl.textContent = String(qty);
        minus.disabled = qty === 0;
      };

      minus?.addEventListener('click', () => {
        const next = (cart[id] || 0) - 1;
        if (next <= 0) delete cart[id];
        else cart[id] = next;
        syncRow();
        renderCart();
      });

      plus?.addEventListener('click', () => {
        cart[id] = (cart[id] || 0) + 1;
        syncRow();
        renderCart();
      });

      syncRow();
    });

    const formatEuro = (cents) =>
      new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);

    function renderCart() {
      const lines = Object.entries(cart).map(([id, quantity]) => ({
        id,
        name: names[id],
        price_cents: Number(menuRoot.querySelector(`[data-item-id="${id}"]`)?.dataset.priceCents || 0),
        quantity,
      }));
      const totalCents = lines.reduce((sum, line) => sum + line.price_cents * line.quantity, 0);
      const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
      totalEl.textContent = formatEuro(totalCents);
      countEl.textContent = itemCount ? `${itemCount} articoli` : 'Nessun articolo';
      payBtn.disabled = itemCount === 0;
      cartInput.value = JSON.stringify(lines);
    }

    renderCart();
  }

  const voucherRoot = document.getElementById('m4g-voucher');
  if (voucherRoot && voucherRoot.dataset.status === 'valid') {
    const token = voucherRoot.dataset.token;
    const hint = document.getElementById('m4g-redeem-hint');
    const errorEl = document.getElementById('m4g-voucher-error');
    const titleEl = document.getElementById('m4g-voucher-title');
    let lastTap = 0;
    let redeeming = false;

    voucherRoot.addEventListener('pointerdown', async () => {
      if (redeeming) return;
      const now = Date.now();
      if (now - lastTap > 500) {
        lastTap = now;
        return;
      }
      lastTap = 0;
      redeeming = true;
      if (hint) hint.textContent = 'Invalidazione…';
      try {
        const response = await fetch(`/m4g/voucher/${encodeURIComponent(token)}/redeem`, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.detail || 'Non è stato possibile invalidare il voucher');
        }
        window.location.reload();
      } catch (error) {
        redeeming = false;
        if (hint) hint.textContent = 'Doppio tap per il cameriere';
        if (errorEl) {
          errorEl.style.display = 'block';
          errorEl.textContent = error.message || 'Errore';
        }
      }
    });
  }
})();
