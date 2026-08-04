'use strict';

(() => {
  const viewer = document.createElement('div');
  viewer.className = 'image-viewer hidden';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', '图片放大查看');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-viewer-close';
  close.setAttribute('aria-label', '关闭大图');
  close.textContent = '×';

  const image = document.createElement('img');
  image.className = 'image-viewer-image';
  image.alt = '放大图片';
  viewer.append(close, image);
  document.body.append(viewer);

  let lastFocus = null;

  function open(source) {
    lastFocus = document.activeElement;
    image.src = source.currentSrc || source.src;
    image.alt = source.alt ? `${source.alt}（放大）` : '放大图片';
    viewer.classList.remove('hidden');
    document.body.classList.add('viewer-open');
    close.focus();
  }

  function hide() {
    if (viewer.classList.contains('hidden')) return;
    viewer.classList.add('hidden');
    document.body.classList.remove('viewer-open');
    image.removeAttribute('src');
    lastFocus?.focus?.();
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.dataset.zoomable === 'true') open(target);
  });
  close.addEventListener('click', hide);
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) hide();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
})();
