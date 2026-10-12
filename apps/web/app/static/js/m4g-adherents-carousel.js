(() => {
  const root = document.querySelector("[data-m4g-adherents-carousel]");
  if (!root) return;

  const slides = [...root.querySelectorAll(".m4g-adherents-carousel__slide")];
  if (slides.length < 2) return;

  let index = 0;
  let timer = null;
  const intervalMs = 2500;

  const show = (next) => {
    slides[index].classList.remove("is-active");
    index = (next + slides.length) % slides.length;
    slides[index].classList.add("is-active");
  };

  const tick = () => show(index + 1);

  const start = () => {
    if (timer) return;
    timer = window.setInterval(tick, intervalMs);
  };

  const stop = () => {
    if (!timer) return;
    window.clearInterval(timer);
    timer = null;
  };

  root.addEventListener("mouseenter", stop);
  root.addEventListener("mouseleave", start);
  start();
})();
