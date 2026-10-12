(() => {
  const root = document.querySelector("[data-m4g-adherents-carousel]");
  if (!root) return;

  const track = root.querySelector(".m4g-adherents-carousel__track");
  const viewport = root.querySelector(".m4g-adherents-carousel__viewport");
  if (!track || !viewport) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const cells = track.querySelectorAll(".m4g-adherents-carousel__cell");
  if (cells.length < 2) {
    track.style.animation = "none";
  }
})();
