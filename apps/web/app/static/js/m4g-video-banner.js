(function () {
  document.querySelectorAll("[data-m4g-video-banner]").forEach(function (root) {
    var video = root.querySelector("video");
    var btn = root.querySelector("[data-m4g-video-sound]");
    if (!video || !btn) return;

    function syncButton() {
      var on = !video.muted;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", on ? "Disattiva audio" : "Attiva audio");
      btn.textContent = on ? "Audio attivo" : "Attiva audio";
      btn.classList.toggle("m4g-video-banner__sound--on", on);
    }

    btn.addEventListener("click", function () {
      video.muted = !video.muted;
      if (!video.muted) {
        video.play().catch(function () {});
      }
      syncButton();
    });

    syncButton();
  });
})();
