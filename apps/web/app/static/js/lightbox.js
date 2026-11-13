// Lightbox per gli album foto: clic su una miniatura apre la foto grande.
// Frecce / swipe per scorrere, Esc o clic fuori per chiudere. Senza JS i link
// aprono comunque la foto grande.
(function () {
  "use strict";

  var grids = document.querySelectorAll("[data-lightbox]");
  if (!grids.length) return;

  var overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Foto");
  overlay.innerHTML =
    '<button type="button" class="lightbox__btn lightbox__close" aria-label="Chiudi">&times;</button>' +
    '<button type="button" class="lightbox__btn lightbox__prev" aria-label="Foto precedente">&lsaquo;</button>' +
    '<figure class="lightbox__figure"><img alt="" /><figcaption></figcaption></figure>' +
    '<button type="button" class="lightbox__btn lightbox__next" aria-label="Foto successiva">&rsaquo;</button>' +
    '<p class="lightbox__count" aria-live="polite"></p>';
  document.body.appendChild(overlay);

  var img = overlay.querySelector("img");
  var caption = overlay.querySelector("figcaption");
  var count = overlay.querySelector(".lightbox__count");
  var closeBtn = overlay.querySelector(".lightbox__close");
  var prevBtn = overlay.querySelector(".lightbox__prev");
  var nextBtn = overlay.querySelector(".lightbox__next");

  var items = [];
  var index = 0;
  var lastFocus = null;

  function show(i) {
    index = (i + items.length) % items.length;
    var link = items[index];
    var text = link.getAttribute("data-caption") || "";
    img.src = link.href;
    img.alt = text;
    caption.textContent = text;
    caption.hidden = !text;
    count.textContent = items.length > 1 ? index + 1 + " / " + items.length : "";
    prevBtn.hidden = nextBtn.hidden = items.length < 2;
    // precarica la successiva
    if (items.length > 1) new Image().src = items[(index + 1) % items.length].href;
  }

  function open(list, i) {
    items = list;
    lastFocus = document.activeElement;
    show(i);
    overlay.hidden = false;
    document.documentElement.classList.add("lightbox-open");
    closeBtn.focus();
  }

  function close() {
    overlay.hidden = true;
    img.removeAttribute("src");
    document.documentElement.classList.remove("lightbox-open");
    if (lastFocus) lastFocus.focus();
  }

  grids.forEach(function (grid) {
    var links = Array.prototype.slice.call(grid.querySelectorAll("a[href]"));
    links.forEach(function (link, i) {
      link.addEventListener("click", function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(links, i);
      });
    });
  });

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", function () { show(index - 1); });
  nextBtn.addEventListener("click", function () { show(index + 1); });
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay || e.target.classList.contains("lightbox__figure")) close();
  });

  document.addEventListener("keydown", function (e) {
    if (overlay.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(index - 1);
    else if (e.key === "ArrowRight") show(index + 1);
    else if (e.key === "Tab") {
      // il focus resta dentro la lightbox
      var focusable = [closeBtn, prevBtn, nextBtn].filter(function (b) { return !b.hidden; });
      var pos = focusable.indexOf(document.activeElement);
      e.preventDefault();
      var next = e.shiftKey ? pos - 1 : pos + 1;
      focusable[(next + focusable.length) % focusable.length].focus();
    }
  });

  var startX = null;
  overlay.addEventListener("touchstart", function (e) {
    startX = e.touches.length === 1 ? e.touches[0].clientX : null;
  }, { passive: true });
  overlay.addEventListener("touchend", function (e) {
    if (startX === null || items.length < 2) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    startX = null;
  });
})();
