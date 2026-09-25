(function () {
  function nearestIndex(viewport, slides) {
    const left = viewport.scrollLeft;
    let best = 0;
    let bestDist = Infinity;
    slides.forEach((slide, i) => {
      const dist = Math.abs(slide.offsetLeft - left);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function scrollToIndex(viewport, slides, index) {
    const i = Math.max(0, Math.min(slides.length - 1, index));
    const slide = slides[i];
    if (!slide) return;
    viewport.scrollTo({ left: slide.offsetLeft, behavior: "smooth" });
  }

  document.querySelectorAll("[data-m4g-carousel]").forEach((root) => {
    const viewport = root.querySelector(".m4g-carousel__viewport");
    const slides = Array.from(root.querySelectorAll(".m4g-carousel__slide"));
    const currentEl = root.querySelector("[data-m4g-carousel-current]");
    const prev = root.querySelector(".m4g-carousel__btn--prev");
    const next = root.querySelector(".m4g-carousel__btn--next");
    if (!viewport || slides.length === 0) return;

    const updateMeta = () => {
      const idx = nearestIndex(viewport, slides);
      if (currentEl) currentEl.textContent = String(idx + 1);
    };

    prev?.addEventListener("click", () => {
      scrollToIndex(viewport, slides, nearestIndex(viewport, slides) - 1);
    });
    next?.addEventListener("click", () => {
      scrollToIndex(viewport, slides, nearestIndex(viewport, slides) + 1);
    });

    viewport.addEventListener("scroll", updateMeta, { passive: true });
    window.addEventListener("resize", updateMeta);
    updateMeta();
  });
})();
