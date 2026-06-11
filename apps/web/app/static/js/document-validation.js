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

  function renderResult(container, result) {
    const badgeClassName = badgeClass(result.valid);
    const notes = result.notes ? `<p class="doc-validation__notes">${escapeHtml(result.notes).replace(/\n/g, "<br>")}</p>` : "";
    container.innerHTML = `
      <span class="doc-badge ${badgeClassName}">${escapeHtml(result.label || "Non verificabile")}</span>
      ${notes}
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
    const cfId = form.dataset.cfField || "codice_fiscale";
    const docId = form.dataset.docNumberField || "document_number";
    const medId = form.dataset.medicalExpiryField || "medical_certificate_expiry";
    return {
      codice_fiscale: (document.getElementById(cfId)?.value || "").trim(),
      document_number: (document.getElementById(docId)?.value || "").trim(),
      medical_certificate_expiry: (document.getElementById(medId)?.value || "").trim(),
    };
  }

  function precheckContext(category, context) {
    if (category === "Tessera sanitaria" && !context.codice_fiscale) {
      return "Compila il codice fiscale prima di caricare la tessera sanitaria.";
    }
    if (category === "Certificato medico agonistico" && !context.medical_certificate_expiry) {
      return "Indica la scadenza del certificato medico prima di caricare il file.";
    }
    return null;
  }

  async function validateFile(input, form, container) {
    const file = input.files && input.files[0];
    if (!file) {
      container.innerHTML = "";
      container.dataset.valid = "";
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
      return;
    }

    renderMessage(container, "Verifica in corso...", "pending");

    const body = new FormData();
    body.append("file", file);
    body.append("category", category);
    if (context.codice_fiscale) body.append("codice_fiscale", context.codice_fiscale);
    if (context.document_number) body.append("document_number", context.document_number);
    if (context.medical_certificate_expiry) {
      body.append("medical_certificate_expiry", context.medical_certificate_expiry);
    }

    try {
      const response = await fetch("/api/documenti/valida", {
        method: "POST",
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        renderMessage(container, payload.detail || "Verifica non riuscita.", "error");
        return;
      }
      renderResult(container, payload);
    } catch (_error) {
      renderMessage(container, "Errore di rete durante la verifica.", "error");
    }
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
      input.addEventListener("change", () => validateFile(input, form, container));
    });

    form.addEventListener("submit", (event) => {
      const containers = form.querySelectorAll(".doc-validation[data-valid='false']");
      if (containers.length) {
        event.preventDefault();
        window.alert(
          "Uno o piu documenti risultano non validi. Correggi gli allegati prima di inviare."
        );
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
