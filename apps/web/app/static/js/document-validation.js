(function () {
  const CATEGORY_BY_INPUT = {
    identity_documents: "Carta d'identita / Passaporto",
    health_documents: "Tessera sanitaria",
    medical_documents: "Certificato medico agonistico",
    extra_identity_documents: "Carta d'identita / Passaporto",
    extra_health_documents: "Tessera sanitaria",
    extra_medical_documents: "Certificato medico agonistico",
  };

  function badgeClass(valid) {
    if (valid === true) return "doc-badge--ok";
    if (valid === false) return "doc-badge--bad";
    return "doc-badge--warn";
  }

  const MANUAL_REVIEW_HINT =
    "Puoi ricaricare un file corretto oppure usare il pulsante Invia per verifica manuale.";

  function renderResult(container, result) {
    const badgeClassName = badgeClass(result.valid);
    const notes = result.notes ? `<p class="doc-validation__notes">${escapeHtml(result.notes).replace(/\n/g, "<br>")}</p>` : "";
    const manualHint =
      result.valid === false
        ? `<p class="doc-validation__manual">${escapeHtml(MANUAL_REVIEW_HINT)}</p>`
        : "";
    container.innerHTML = `
      <span class="doc-badge ${badgeClassName}">${escapeHtml(result.label || "Non verificabile")}</span>
      ${notes}
      ${manualHint}
    `;
    container.dataset.valid = result.valid === null ? "null" : String(result.valid);
  }

  function renderMessage(container, message, kind) {
    const badgeClassName = kind === "error" ? "doc-badge--bad" : "doc-badge--pending";
    container.innerHTML = `<span class="doc-badge ${badgeClassName}">${escapeHtml(message)}</span>`;
    container.dataset.valid = kind === "error" ? "false" : "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function readContext(form) {
    const firstNameId = form.dataset.firstNameField || "first_name";
    const lastNameId = form.dataset.lastNameField || "last_name";
    const cfId = form.dataset.cfField || "codice_fiscale";
    const docId = form.dataset.docNumberField || "document_number";
    const medId = form.dataset.medicalExpiryField || "medical_certificate_expiry";
    const sportType =
      form.dataset.sportType ||
      document.getElementById("sport_type")?.value ||
      "";
    return {
      first_name: (document.getElementById(firstNameId)?.value || "").trim(),
      last_name: (document.getElementById(lastNameId)?.value || "").trim(),
      codice_fiscale: (document.getElementById(cfId)?.value || "").trim(),
      document_number: (document.getElementById(docId)?.value || "").trim(),
      medical_certificate_expiry: (document.getElementById(medId)?.value || "").trim(),
      sport_type: sportType.trim(),
    };
  }

  function precheckContext(category, context) {
    if (!context.first_name || !context.last_name) {
      return "Compila nome e cognome prima di caricare i documenti.";
    }
    if (category === "Tessera sanitaria" && !context.codice_fiscale) {
      return "Compila il codice fiscale prima di caricare la tessera sanitaria.";
    }
    if (category === "Certificato medico agonistico") {
      if (!context.medical_certificate_expiry) {
        return "Indica la scadenza del certificato medico prima di caricare il file.";
      }
      if (!context.sport_type) {
        return "Disciplina non indicata: impossibile verificare il certificato medico.";
      }
    }
    return null;
  }

  async function validateFile(input, form, container) {
    const file = input.files && input.files[0];
    if (!file) {
      container.innerHTML = "";
      container.dataset.valid = "";
      updateFormManualReviewState(form);
      return;
    }

    const category = CATEGORY_BY_INPUT[input.id];
    if (!category) {
      return;
    }

    const context = readContext(form);
    const precheck = precheckContext(category, context);
    if (precheck) {
      renderMessage(container, precheck, "warn");
      updateFormManualReviewState(form);
      return;
    }

    renderMessage(container, "Verifica in corso...", "pending");

    const body = new FormData();
    body.append("file", file);
    body.append("category", category);
    if (context.first_name) body.append("first_name", context.first_name);
    if (context.last_name) body.append("last_name", context.last_name);
    if (context.codice_fiscale) body.append("codice_fiscale", context.codice_fiscale);
    if (context.document_number) body.append("document_number", context.document_number);
    if (context.medical_certificate_expiry) {
      body.append("medical_certificate_expiry", context.medical_certificate_expiry);
    }
    if (context.sport_type) body.append("sport_type", context.sport_type);

    try {
      const response = await fetch("/api/documenti/valida", {
        method: "POST",
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        renderMessage(container, payload.detail || "Verifica non riuscita.", "error");
        updateFormManualReviewState(form);
        return;
      }
      renderResult(container, payload);
      updateFormManualReviewState(form);
    } catch (_error) {
      renderMessage(container, "Errore di rete durante la verifica.", "error");
      updateFormManualReviewState(form);
    }
  }

  function ensureManualReviewUi(form) {
    const submitBtn = form.querySelector("[data-doc-submit]");
    const anchor = submitBtn || null;

    let banner = form.querySelector(".doc-validation__proceed-banner");
    if (!banner) {
      banner = document.createElement("p");
      banner.className = "alert doc-validation__proceed-banner";
      banner.hidden = true;
      if (anchor) {
        form.insertBefore(banner, anchor);
      } else {
        form.appendChild(banner);
      }
    }

    let manualBtn = form.querySelector("[data-manual-review-submit]");
    if (!manualBtn) {
      manualBtn = document.createElement("button");
      manualBtn.type = "button";
      manualBtn.className = "btn btn-secondary";
      manualBtn.dataset.manualReviewSubmit = "1";
      manualBtn.textContent = "Invia per verifica manuale";
      manualBtn.hidden = true;
      manualBtn.addEventListener("click", () => {
        let input = form.querySelector("input[name='request_manual_review']");
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = "request_manual_review";
          form.appendChild(input);
        }
        input.value = "1";
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      });
      if (anchor) {
        form.insertBefore(manualBtn, anchor);
      } else {
        form.appendChild(manualBtn);
      }
    }

    return { banner, manualBtn };
  }

  function updateFormManualReviewState(form) {
    const invalidContainers = form.querySelectorAll(".doc-validation[data-valid='false']");
    const hasInvalid = invalidContainers.length > 0;
    const submitBtn = form.querySelector("[data-doc-submit]");
    const { banner, manualBtn } = ensureManualReviewUi(form);

    if (hasInvalid) {
      if (submitBtn) {
        submitBtn.hidden = true;
      }
      banner.hidden = false;
      banner.textContent =
        "Alcuni documenti richiederanno verifica manuale: la pratica non sara automatica e i tempi saranno piu lunghi. Puoi ricaricare i file corretti oppure inviare per verifica manuale.";
      manualBtn.hidden = false;
      form.querySelector("input[name='request_manual_review']")?.remove();
      return;
    }

    if (submitBtn) {
      submitBtn.hidden = false;
    }
    banner.hidden = true;
    manualBtn.hidden = true;
    form.querySelector("input[name='request_manual_review']")?.remove();
  }

  function initForm(form) {
    const inputs = form.querySelectorAll("input[type='file'][id]");
    inputs.forEach((input) => {
      if (!CATEGORY_BY_INPUT[input.id]) {
        return;
      }
      let container = form.querySelector(`.doc-validation[data-for='${input.id}']`);
      if (!container) {
        container = document.createElement("div");
        container.className = "doc-validation";
        container.dataset.for = input.id;
        input.insertAdjacentElement("afterend", container);
      }
      input.addEventListener("change", () => {
        validateFile(input, form, container);
      });
    });

    ensureManualReviewUi(form);
    updateFormManualReviewState(form);

    form.addEventListener("submit", (event) => {
      const invalidContainers = form.querySelectorAll(".doc-validation[data-valid='false']");
      const manualReview = form.querySelector("input[name='request_manual_review']");
      if (invalidContainers.length && !manualReview) {
        event.preventDefault();
        return;
      }
      const pending = form.querySelector(".doc-validation .doc-badge--pending");
      if (pending) {
        event.preventDefault();
        window.alert("Attendi il termine della verifica documenti.");
      }
    });
  }

  function updateDocumentBadge(item, payload) {
    let badge = item.querySelector(".doc-badge[data-doc-status]");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "doc-badge";
      badge.dataset.docStatus = "1";
      item.appendChild(badge);
    }
    if (payload.ocr_status === "pending" || payload.ocr_status === null) {
      badge.className = "doc-badge doc-badge--pending";
      badge.textContent = "Verifica in corso...";
      return false;
    }
    if (payload.ocr_status === "failed") {
      badge.className = "doc-badge doc-badge--warn";
      badge.textContent = "Non verificabile";
      return true;
    }
    badge.className = `doc-badge doc-badge--${payload.badge_class || "warn"}`;
    badge.textContent = payload.label || "Non verificabile";
    return true;
  }

  function pollPendingDocuments(ids) {
    if (!ids || !ids.length) {
      return;
    }
    const items = ids
      .map((id) => document.querySelector(`[data-document-id='${id}']`))
      .filter(Boolean);
    if (!items.length) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 15;
    const timer = window.setInterval(async () => {
      attempts += 1;
      let allDone = true;
      for (const item of items) {
        const docId = item.dataset.documentId;
        try {
          const response = await fetch(`/api/documenti/${docId}/stato`);
          if (!response.ok) {
            continue;
          }
          const payload = await response.json();
          const done = updateDocumentBadge(item, payload);
          if (!done) {
            allDone = false;
          }
        } catch (_error) {
          allDone = false;
        }
      }
      if (allDone || attempts >= maxAttempts) {
        window.clearInterval(timer);
      }
    }, 2000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("form[data-doc-validation]").forEach(initForm);
    const pendingRaw = document.body.dataset.pendingDocIds;
    if (pendingRaw) {
      try {
        const ids = JSON.parse(pendingRaw);
        pollPendingDocuments(ids);
      } catch (_error) {
        /* ignore */
      }
    }
    document.querySelectorAll("[data-document-id][data-ocr-pending='1']").forEach((item) => {
      pollPendingDocuments([Number(item.dataset.documentId)]);
    });
  });
})();
