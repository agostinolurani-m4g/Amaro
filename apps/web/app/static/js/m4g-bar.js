(function () {
  const vendorsMarquee = document.querySelector('[data-m4g-vendors-marquee]');
  if (vendorsMarquee) {
    const track = vendorsMarquee.querySelector('.m4g-vendors-marquee__track');
    const cells = track?.querySelectorAll('.m4g-vendor--marquee:not([aria-hidden])') || [];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      track?.querySelectorAll('.m4g-vendor--marquee[aria-hidden="true"]').forEach((el) => {
        el.remove();
      });
    } else if (cells.length < 2 && track) {
      track.style.animation = 'none';
    }
  }

  const menuRoot = document.getElementById('m4g-menu');
  if (menuRoot) {
    const tabRoot = document.querySelector('.m4g-menu-tabs');
    const blocks = {};
    menuRoot.querySelectorAll('.m4g-menu-block').forEach((block) => {
      const kind = block.dataset.menuKind;
      if (kind) blocks[kind] = block;
    });

    const defaultKind = menuRoot.dataset.menuTipo || Object.keys(blocks)[0] || '';

    const setTabSelected = (kind) => {
      tabRoot?.querySelectorAll('[data-menu-tab]').forEach((btn) => {
        const selected = btn.dataset.menuTab === kind;
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    };

    const scrollToBlock = (kind, behavior = 'smooth') => {
      const target = blocks[kind];
      if (!target) return;
      target.scrollIntoView({ behavior, block: 'start' });
      setTabSelected(kind);
    };

    tabRoot?.querySelectorAll('[data-menu-tab]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        scrollToBlock(btn.dataset.menuTab || defaultKind);
      });
    });

    const visibleBlocks = Object.values(blocks);
    if (visibleBlocks.length > 1 && tabRoot) {
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
          if (!visible.length) return;
          const kind = visible[0].target.dataset.menuKind;
          if (kind) setTabSelected(kind);
        },
        { root: null, rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.1, 0.25] }
      );
      visibleBlocks.forEach((block) => observer.observe(block));
    } else if (visibleBlocks.length === 1) {
      const kind = visibleBlocks[0].dataset.menuKind;
      if (kind) setTabSelected(kind);
    }

    const tipoParam = new URL(window.location.href).searchParams.get('tipo') || '';
    const initialTipo = blocks[tipoParam] ? tipoParam : defaultKind;
    if (initialTipo && blocks[initialTipo] && tipoParam) {
      window.requestAnimationFrame(() => scrollToBlock(initialTipo, 'auto'));
    } else {
      setTabSelected(initialTipo);
    }

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

  function markConsumptionRejected(root) {
    root.dataset.status = 'rejected';
    root.classList.add('m4g-consumption--rejected');
    root.classList.remove('m4g-consumption--redeemed');
    const title = root.querySelector('.m4g-consumption__title, #m4g-voucher-title');
    if (title) title.textContent = 'Già usato';
    const hint = root.querySelector('.m4g-consumption__hint, .m4g-voucher__hint, #m4g-redeem-hint');
    if (hint) hint.textContent = 'Non consegnare';
    const errorEl = root.querySelector('.m4g-consumption__error, #m4g-voucher-error');
    if (errorEl) errorEl.style.display = 'none';
  }

  function bindDoubleTapRedeem(root, redeemUrl) {
    let lastTap = 0;
    let redeeming = false;
    const hint = root.querySelector('.m4g-consumption__hint, .m4g-voucher__hint, #m4g-redeem-hint');
    const errorEl = root.querySelector('.m4g-consumption__error, #m4g-voucher-error');

    root.addEventListener('pointerdown', async () => {
      if (redeeming || root.dataset.status !== 'valid') return;
      const now = Date.now();
      if (now - lastTap > 500) {
        lastTap = now;
        return;
      }
      lastTap = 0;
      redeeming = true;
      if (hint) hint.textContent = 'Invalidazione…';
      try {
        const response = await fetch(redeemUrl, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 || data.outcome === 'already_redeemed') {
          markConsumptionRejected(root);
          redeeming = false;
          return;
        }
        if (!response.ok) {
          throw new Error(data.detail || 'Non è stato possibile invalidare il banner');
        }
        if (data.outcome && data.outcome !== 'claimed') {
          throw new Error(data.detail || 'Non è stato possibile invalidare il banner');
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

  document.querySelectorAll('.m4g-consumption[data-status="valid"]').forEach((card) => {
    const ref = card.dataset.orderRef;
    const token = card.dataset.token;
    bindDoubleTapRedeem(card, `/m4g/ordine/${encodeURIComponent(ref)}/consumo/${encodeURIComponent(token)}/redeem`);
  });

  const pendingRoot = document.querySelector('[data-m4g-pending-order]');
  if (pendingRoot) {
    const ref = pendingRoot.dataset.m4gPendingOrder;
    const poll = () => {
      fetch(`/m4g/ordine/${encodeURIComponent(ref)}/stato`, { headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((data) => {
          if (data.payment_status === 'paid') {
            window.location.reload();
          }
        })
        .catch(() => {});
    };
    setInterval(poll, 10000);
    poll();
  }
})();
