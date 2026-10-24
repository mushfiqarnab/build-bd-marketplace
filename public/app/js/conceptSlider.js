// frontend/js/conceptSlider.js — Reusable Interactive Concept Carousel
// Auto-advancing left-to-right showcase with interactive controls & pure DOM.
'use strict';

export function initConceptSlider(containerId = 'interactive-concept-showcase') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const slides = container.querySelectorAll('.slider-slide');
  const dots = container.querySelectorAll('.slider-dot');
  const prevBtn = container.querySelector('#slider-prev-btn') || container.querySelector('[data-slider-prev]');
  const nextBtn = container.querySelector('#slider-next-btn') || container.querySelector('[data-slider-next]');
  const badge = container.querySelector('#slider-indicator-badge') || container.querySelector('[data-slider-badge]');
  if (slides.length === 0) return;

  let currentIdx = 0;
  let timer = null;

  function showSlide(idx) {
    currentIdx = (idx + slides.length) % slides.length;
    slides.forEach((s, i) => {
      if (i === currentIdx) {
        s.classList.remove('hidden');
      } else {
        s.classList.add('hidden');
      }
    });

    dots.forEach((d, i) => {
      const active = i === currentIdx;
      d.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        d.className = 'slider-dot w-6 h-2 rounded-full bg-primary transition-all';
      } else {
        d.className = 'slider-dot w-2 h-2 rounded-full bg-border-subtle hover:bg-on-surface-variant transition-all';
      }
    });

    if (badge) {
      badge.textContent = `${currentIdx + 1} / ${slides.length}`;
    }
  }

  function next() {
    showSlide(currentIdx + 1);
  }

  function prev() {
    showSlide(currentIdx - 1);
  }

  function startAutoPlay() {
    stopAutoPlay();
    timer = setInterval(next, 5000);
  }

  function stopAutoPlay() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      prev();
      startAutoPlay();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      next();
      startAutoPlay();
    });
  }

  dots.forEach((dot, idx) => {
    dot.addEventListener('click', () => {
      showSlide(idx);
      startAutoPlay();
    });
  });

  container.addEventListener('mouseenter', stopAutoPlay);
  container.addEventListener('mouseleave', startAutoPlay);
  container.addEventListener('touchstart', stopAutoPlay, { passive: true });
  container.addEventListener('touchend', startAutoPlay, { passive: true });

  showSlide(0);
  startAutoPlay();
}
