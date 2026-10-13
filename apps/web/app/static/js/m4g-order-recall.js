(function () {
  const STORAGE_KEY = 'm4g-recent-orders';
  const MAX = 5;

  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function writeStore(rows) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, MAX)));
    } catch {
      /* ignore */
    }
  }

  function rememberOrder(entry) {
    if (!entry || !entry.ref || !entry.url) return;
    const rows = readStore().filter((row) => row.ref !== entry.ref);
    rows.unshift({ ...entry, ts: Date.now() });
    writeStore(rows);
  }

  function removeOrder(ref) {
    writeStore(readStore().filter((row) => row.ref !== ref));
    renderRecallBoxes();
  }

  function renderRecallBoxes() {
    document.querySelectorAll('[data-m4g-order-recall]').forEach((host) => {
      const kind = host.getAttribute('data-m4g-order-recall') || '';
      const rows = readStore().filter((row) => !kind || row.kind === kind);
      if (!rows.length) {
        host.innerHTML = '';
        host.hidden = true;
        return;
      }
      host.hidden = false;
      const items = rows
        .map((row) => {
          const label = row.shortCode || row.ref;
          return (
            '<p class="m4g-order-recall">' +
            '<strong>' +
            label +
            '</strong> · ' +
            (row.kind === 'merch' ? 'Merch' : 'Bar') +
            '<span class="m4g-order-recall__actions">' +
            '<a class="m4g-btn m4g-btn--secondary m4g-btn--inline" href="' +
            row.url +
            '">Riprendi</a>' +
            '<button type="button" class="m4g-btn m4g-btn--secondary m4g-btn--inline" data-m4g-forget-order="' +
            row.ref +
            '">Rimuovi</button>' +
            '</span></p>'
          );
        })
        .join('');
      host.innerHTML = items;
      host.querySelectorAll('[data-m4g-forget-order]').forEach((btn) => {
        btn.addEventListener('click', () => removeOrder(btn.getAttribute('data-m4g-forget-order') || ''));
      });
    });
  }

  const statusRoot = document.querySelector('[data-m4g-order-ref]');
  if (statusRoot) {
    rememberOrder({
      ref: statusRoot.getAttribute('data-m4g-order-ref'),
      url: statusRoot.getAttribute('data-m4g-order-url') || window.location.pathname,
      kind: statusRoot.getAttribute('data-m4g-order-kind') || 'bar',
      shortCode: document.querySelector('.m4g-pay-code')?.textContent?.trim() || '',
    });
  }

  const paymentRef = document.querySelector('[data-m4g-payment-order-ref]');
  if (paymentRef) {
    const ref = paymentRef.getAttribute('data-m4g-payment-order-ref');
    const kind = paymentRef.getAttribute('data-m4g-order-kind') || 'bar';
    const statusPath =
      kind === 'merch' ? '/m4g/merch/ordine/' + ref + '/codici' : '/m4g/ordine/' + ref + '/consumi';
    rememberOrder({
      ref,
      url: statusPath,
      kind,
      shortCode: document.querySelector('.m4g-pay-code')?.textContent?.trim() || '',
    });
  }

  renderRecallBoxes();
})();
