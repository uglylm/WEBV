(() => {
  'use strict';

  const settings = window.VAULT_SETTINGS || {};
  const siteRoot = new URL('./', document.baseURI);
  const pageSize = Number.isInteger(settings.pageSize) && settings.pageSize > 0 ? Math.min(settings.pageSize, 96) : 24;
  const $ = id => document.getElementById(id);
  const grid = $('grid');
  const preview = $('previewModal');
  const promptDialog = $('promptModal');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { q: '', type: 'all', cat: 'all', sort: 'featured', shown: pageSize };
  const promptCache = new Map();
  let products = [];
  let ads = [];
  let filtered = [];
  let catalogReady = false;
  let batchQueued = false;
  let toastTimer;
  let formatter;
  try { formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: settings.currency || 'USD', maximumFractionDigits: 2 }); }
  catch { formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); }
  const priceLabel = product => formatter.format(product.price).replace(/\.00$/, '');
  const isFree = product => product.price === 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function publicURL(value, externalOnly = false) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim(), siteRoot);
      if (!['https:', 'http:'].includes(url.protocol)) return '';
      if (externalOnly && url.protocol !== 'https:') return '';
      if (url.username || url.password) return '';
      return url.href;
    } catch { return ''; }
  }

  function freePromptURL(value) {
    const href = publicURL(value);
    if (!href) return '';
    const url = new URL(href);
    // Only public text files inside this site's prompts/ folder can be copied.
    return url.origin === siteRoot.origin && url.pathname.startsWith(siteRoot.pathname + 'prompts/') && /\.txt$/i.test(url.pathname) ? href : '';
  }

  function validateCatalog(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.products) || (data.ads != null && !Array.isArray(data.ads))) throw new Error('Expected catalog version 1 with products and ads arrays.');
    const ids = new Set();
    const normalizedProducts = data.products.map(product => {
      if (!product || typeof product.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(product.id) || ids.has(product.id)) throw new Error('Each product must have a unique lowercase id.');
      ids.add(product.id);
      if (typeof product.title !== 'string' || !product.title.trim()) throw new Error('Missing product title: ' + product.id);
      if (typeof product.price !== 'number' || !Number.isFinite(product.price) || product.price < 0) throw new Error('Set a non-negative numeric price for ' + product.id);
      if (product.tags != null && (!Array.isArray(product.tags) || product.tags.some(tag => typeof tag !== 'string'))) throw new Error('Tags must be an array of text: ' + product.id);
      if (product.mediaType != null && !['image', 'video'].includes(product.mediaType)) throw new Error('mediaType must be image or video: ' + product.id);
      const mediaURL = publicURL(product.media);
      if (!mediaURL) throw new Error('Missing or invalid media path: ' + product.id);
      if (product.price > 0 && product.prompt) throw new Error('Paid prompt paths must not be published: ' + product.id);
      const mediaType = product.mediaType || (/\.(mp4|webm|ogv)$/i.test(new URL(mediaURL).pathname) ? 'video' : 'image');
      return { ...product, title: product.title.trim(), category: String(product.category || 'Design'), tags: product.tags || [], mediaURL, mediaType, promptURL: product.price === 0 ? freePromptURL(product.prompt) : '', stripeURL: publicURL(product.stripeUrl, true) };
    });
    const normalizedAds = (data.ads || []).filter(ad => ad && ad.enabled === true).map(ad => {
      const imageURL = publicURL(ad.image);
      const url = publicURL(ad.url);
      if (!ad.id || ids.has(ad.id) || !imageURL || !url || !Number.isInteger(ad.after) || ad.after < 0) throw new Error('An enabled advertisement has an invalid id, image, URL, or position.');
      ids.add(ad.id);
      return { ...ad, imageURL, url, title: String(ad.title || 'Visit sponsor') };
    });
    return { products: normalizedProducts, ads: normalizedAds };
  }

  function toast(message, error = false) {
    // A native modal is above the document; place feedback in its top layer.
    (promptDialog.open ? promptDialog : preview.open ? preview : document.body).append($('toast'));
    $('toast').textContent = message;
    $('toast').className = 'toast show' + (error ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').className = 'toast'; }, 4200);
  }

  function actionHTML(product) {
    if (isFree(product)) return product.promptURL
      ? `<button class="btn primary" type="button" data-copy="${esc(product.id)}" aria-label="Copy AI prompt for ${esc(product.title)}">Copy prompt</button>`
      : '<button class="btn primary" type="button" disabled title="This prompt is not available yet">Unavailable</button>';
    return product.stripeURL
      ? `<a class="btn buy" href="${esc(product.stripeURL)}" target="_blank" rel="noopener noreferrer" aria-label="Buy AI prompt for ${esc(product.title)} for ${esc(priceLabel(product))}">Buy ${esc(priceLabel(product))}</a>`
      : '<button class="btn buy" type="button" disabled title="This premium prompt is not available yet">Coming soon</button>';
  }

  function mediaFailure(media) {
    const container = media.parentElement;
    if (!container || container.querySelector('.media-fallback')) return;
    const fallback = document.createElement('div');
    fallback.className = 'media-fallback';
    fallback.textContent = 'Preview unavailable';
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', 'Preview media could not be loaded');
    media.hidden = true;
    container.append(fallback);
  }

  const visibleVideos = new Set();
  const videoObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const video = entry.target;
      if (entry.isIntersecting) {
        visibleVideos.add(video);
        loadCardVideo(video);
        if (settings.autoplayCardVideos === true && !reducedMotion.matches && !document.hidden && !preview.open && !promptDialog.open) video.play().catch(() => {});
      } else { visibleVideos.delete(video); video.pause(); }
    });
  }, { threshold: 0.15, rootMargin: '150px' }) : null;

  function loadCardVideo(video) {
    if (!video.dataset.source) return;
    video.preload = 'metadata';
    video.src = video.dataset.source;
    delete video.dataset.source;
    video.load();
  }

  function makeMedia(product, expanded = false) {
    const media = document.createElement(product.mediaType === 'video' ? 'video' : 'img');
    media.className = expanded ? 'preview-media' : 'shot';
    if (product.mediaType === 'video') {
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
      media.preload = expanded ? 'metadata' : 'none';
      media.controls = expanded;
      media.setAttribute('aria-label', product.title + ' scrolling website preview');
      if (expanded) media.addEventListener('loadedmetadata', fitPreview);
      media.addEventListener('error', () => mediaFailure(media));
      if (!expanded) {
        media.dataset.cardVideo = 'true';
        // Show a frame from the same uploaded file, including on touch screens.
        const showFirstFrame = () => {
          if (media.paused && media.currentTime === 0 && media.duration > 0) media.currentTime = Math.min(0.01, media.duration / 2);
        };
        media.addEventListener('loadedmetadata', showFirstFrame, { once: true });
        // Some recorded WebM files report zero duration until data arrives.
        media.addEventListener('loadeddata', showFirstFrame, { once: true });
      }
    } else {
      media.alt = product.title + ' website design preview';
      media.loading = expanded ? 'eager' : 'lazy';
      media.decoding = 'async';
      if (expanded) media.addEventListener('load', fitPreview);
      media.addEventListener('error', () => mediaFailure(media));
    }
    if (product.mediaType === 'video' && !expanded) media.dataset.source = product.mediaURL;
    else media.src = product.mediaURL;
    return media;
  }

  function attachCardVideo(video) {
    const button = video.closest('.thumb');
    videoObserver?.observe(video);
    if (!videoObserver) loadCardVideo(video);
    const play = () => { loadCardVideo(video); if (!reducedMotion.matches && !document.hidden && !preview.open && !promptDialog.open) video.play().catch(() => {}); };
    const pause = () => { if (settings.autoplayCardVideos !== true || !visibleVideos.has(video) || reducedMotion.matches) video.pause(); };
    button.addEventListener('mouseenter', play);
    button.addEventListener('mouseleave', pause);
    button.addEventListener('focus', play);
    button.addEventListener('blur', pause);
  }

  function makeCard(product) {
    const article = document.createElement('article');
    article.className = 'card';
    article.innerHTML = `<button class="thumb" type="button" data-preview="${esc(product.id)}" aria-label="Preview ${esc(product.title)}"></button>
      <div class="body"><div class="card-heading"><h3 title="${esc(product.title)}">${esc(product.title)}</h3><span class="badge ${isFree(product) ? 'free' : 'paid'}">${isFree(product) ? 'Free' : 'Premium'}</span></div><div class="actions"><button class="btn ghost" type="button" data-preview="${esc(product.id)}">Preview</button>${actionHTML(product)}</div></div>`;
    article.querySelector('.thumb').append(makeMedia(product));
    return article;
  }

  function makeAd(ad) {
    const link = document.createElement('a');
    link.className = 'card ad-card';
    link.href = ad.url;
    link.target = '_blank';
    link.rel = 'sponsored noopener noreferrer';
    link.setAttribute('aria-label', ad.title + ' — advertisement (opens a new tab)');
    const image = document.createElement('img');
    image.alt = ad.title;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => mediaFailure(image));
    image.src = ad.imageURL;
    link.append(image);
    return link;
  }

  function stopCardVideos() { grid.querySelectorAll('video').forEach(video => video.pause()); }
  function updateScrollLock() {
    (promptDialog.open ? promptDialog : preview.open ? preview : document.body).append($('toast'));
    document.body.style.overflow = preview.open || promptDialog.open ? 'hidden' : '';
    if (preview.open || promptDialog.open) stopCardVideos();
    else if (settings.autoplayCardVideos === true && !reducedMotion.matches && !document.hidden) visibleVideos.forEach(video => video.play().catch(() => {}));
    if (!preview.open && !promptDialog.open) watchNextBatch();
  }

  function loadNextBatch() {
    if (!catalogReady || batchQueued || preview.open || promptDialog.open || state.shown >= filtered.length) return;
    batchQueued = true;
    requestAnimationFrame(() => {
      batchQueued = false;
      if (!catalogReady || preview.open || promptDialog.open || state.shown >= filtered.length) return;
      const previousCount = Math.min(state.shown, filtered.length);
      state.shown += pageSize;
      render(previousCount);
    });
  }

  const loadObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadNextBatch();
  }, { rootMargin: '400px', threshold: 0 }) : null;

  function checkNextBatchPosition() {
    if (!$('loadSentinel').hidden && $('loadSentinel').getBoundingClientRect().top <= window.innerHeight + 400) loadNextBatch();
  }

  function watchNextBatch() {
    const sentinel = $('loadSentinel');
    loadObserver?.disconnect();
    sentinel.hidden = !catalogReady || state.shown >= filtered.length;
    if (sentinel.hidden) return;
    // Re-observe after each append so short pages continue filling the viewport.
    if (loadObserver) loadObserver.observe(sentinel);
    else checkNextBatchPosition();
  }

  function render(appendFrom = 0) {
    const count = Math.min(state.shown, filtered.length);
    if (appendFrom === 0) {
      stopCardVideos();
      videoObserver?.disconnect();
      visibleVideos.clear();
      grid.replaceChildren();
    }
    const showAds = !state.q.trim() && state.type === 'all' && state.cat === 'all';
    const fragment = document.createDocumentFragment();
    for (let index = appendFrom; index < count; index++) {
      if (showAds) ads.filter(ad => ad.after === index).forEach(ad => fragment.append(makeAd(ad)));
      fragment.append(makeCard(filtered[index]));
    }
    if (showAds && count === filtered.length && count > appendFrom) ads.filter(ad => ad.after === count).forEach(ad => fragment.append(makeAd(ad)));
    if (!count) {
      grid.innerHTML = '<div class="empty"><strong>No designs match that.</strong>Try a different search, or clear the filters.</div>';
    } else grid.append(fragment);
    grid.querySelectorAll('video[data-card-video]:not([data-attached])').forEach(video => { video.dataset.attached = 'true'; attachCardVideo(video); });
    $('count').textContent = filtered.length ? `Showing ${count} of ${filtered.length} design${filtered.length === 1 ? '' : 's'}` : '';
    watchNextBatch();
    grid.setAttribute('aria-busy', 'false');
  }

  function apply() {
    const query = state.q.trim().toLowerCase();
    filtered = products.filter(product => {
      if (state.type === 'free' && !isFree(product)) return false;
      if (state.type === 'paid' && isFree(product)) return false;
      if (state.cat !== 'all' && product.category !== state.cat) return false;
      return !query || [product.title, product.category, product.id, ...product.tags].join(' ').toLowerCase().includes(query);
    });
    const byName = (a, b) => a.title.localeCompare(b.title);
    if (state.sort === 'az') filtered.sort(byName);
    else if (state.sort === 'price-asc') filtered.sort((a, b) => a.price - b.price || byName(a, b));
    else if (state.sort === 'price-desc') filtered.sort((a, b) => b.price - a.price || byName(a, b));
    // Featured order is the order in catalog.json.
    state.shown = pageSize;
    render();
  }

  function buildControls() {
    const free = products.filter(isFree).length;
    $('stats').innerHTML = `<span class="chip"><i aria-hidden="true"></i>${free} free prompts</span><span class="chip p"><i aria-hidden="true"></i>${products.length - free} premium</span><span class="dot" aria-hidden="true">•</span><span><b>${products.length}</b> designs to explore</span>`;
    const categories = [...new Set(products.map(product => product.category))].sort((a, b) => a.localeCompare(b));
    $('catFilter').innerHTML = '<button class="pill active" type="button" data-cat="all" aria-pressed="true">All</button>' + categories.map(category => `<button class="pill" type="button" data-cat="${esc(category)}" aria-pressed="false">${esc(category)}</button>`).join('');
    state.cat = 'all';
  }

  function fitPreview() {
    if (!preview.open) return;
    const stage = $('previewStage');
    const box = stage.closest('.preview-box');
    const media = stage.querySelector('img, video');
    const width = media?.tagName === 'VIDEO' ? media.videoWidth : media?.naturalWidth;
    const height = media?.tagName === 'VIDEO' ? media.videoHeight : media?.naturalHeight;
    if (!width || !height) return;
    const padding = getComputedStyle(preview);
    const availableHeight = preview.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
    const chromeHeight = box.querySelector('.preview-toolbar').getBoundingClientRect().height + $('previewActions').getBoundingClientRect().height + 2;
    // Keep short images snug to their frame while fitting tall media on screen.
    box.style.height = Math.min(820, availableHeight, Math.ceil(box.clientWidth * height / width) + chromeHeight) + 'px';
  }

  function openPreview(id) {
    const product = products.find(item => item.id === id);
    if (!product) return;
    $('previewTitle').textContent = product.title;
    $('previewStage').replaceChildren(makeMedia(product, true));
    $('previewStage').scrollTop = 0;
    $('previewActions').innerHTML = actionHTML(product);
    $('previewStage').closest('.preview-box').style.height = '';
    preview.showModal();
    updateScrollLock();
    fitPreview();
    const video = $('previewStage').querySelector('video');
    if (video && !reducedMotion.matches) video.play().catch(() => {});
  }

  function openPrompt(product, text) {
    $('promptTitle').textContent = product.title + ' — AI prompt';
    $('promptText').value = text;
    promptDialog.showModal();
    updateScrollLock();
    $('promptText').focus();
    $('promptText').select();
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* Try the selection fallback. */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;pointer-events:none';
    const previousFocus = document.activeElement;
    // Native dialogs make the rest of the document inert: use the top dialog.
    const container = promptDialog.open ? promptDialog : preview.open ? preview : document.body;
    container.append(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Show selectable prompt instead. */ }
    textarea.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    return copied;
  }

  async function copyPrompt(id, button) {
    const product = products.find(item => item.id === id);
    if (!product || !isFree(product) || !product.promptURL || button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Copying…';
    try {
      let text = promptCache.get(id);
      if (text == null) {
        const response = await fetch(product.promptURL, { cache: 'no-cache' });
        if (!response.ok) throw new Error('Prompt request returned ' + response.status);
        text = await response.text();
        if (!text.trim() || /text\/html/i.test(response.headers.get('content-type') || '') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('Expected a non-empty plain text prompt.');
        promptCache.set(id, text);
      }
      if (await copyText(text)) {
        button.classList.add('copied');
        button.textContent = '✓ Copied';
        toast('AI prompt copied. Paste it into your AI website builder.');
        setTimeout(() => { button.classList.remove('copied'); button.textContent = original; button.disabled = false; }, 1800);
        return;
      }
      openPrompt(product, text);
    } catch (error) {
      console.error('[TemplateVault] Could not copy prompt:', error);
      toast('This prompt could not load. Please try again or contact support.', true);
    }
    button.textContent = original;
    button.disabled = false;
  }

  $('previewClose').addEventListener('click', () => preview.close());
  $('promptClose').addEventListener('click', () => promptDialog.close());
  $('promptClose2').addEventListener('click', () => promptDialog.close());
  [preview, promptDialog].forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      if (dialog === preview) {
        $('previewStage').querySelectorAll('video').forEach(video => video.pause());
        $('previewStage').replaceChildren();
      }
      updateScrollLock();
    });
  });
  $('promptCopy').addEventListener('click', async () => {
    const copied = await copyText($('promptText').value);
    if (copied) { promptDialog.close(); toast('AI prompt copied.'); }
    else { $('promptText').focus(); $('promptText').select(); toast('Select the prompt and use Ctrl/Cmd + C to copy.', true); }
  });

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const previewButton = target?.closest('[data-preview]');
    if (previewButton) { openPreview(previewButton.dataset.preview); return; }
    const copyButton = target?.closest('[data-copy]');
    if (copyButton) copyPrompt(copyButton.dataset.copy, copyButton);
  });

  $('typeFilter').addEventListener('click', event => {
    const button = event.target.closest('button[data-type]');
    if (!button) return;
    $('typeFilter').querySelectorAll('button').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    state.type = button.dataset.type;
    apply();
  });
  $('catFilter').addEventListener('click', event => {
    const button = event.target.closest('button[data-cat]');
    if (!button) return;
    $('catFilter').querySelectorAll('button').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    state.cat = button.dataset.cat;
    apply();
  });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; apply(); });
  let searchTimer;
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = $('q').value; apply(); }, 150);
  });
  if (!loadObserver) {
    window.addEventListener('scroll', checkNextBatchPosition, { passive: true });
    window.addEventListener('resize', checkNextBatchPosition);
  }
  window.addEventListener('resize', fitPreview);
  window.visualViewport?.addEventListener('resize', fitPreview);
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !preview.open && !promptDialog.open && !/input|textarea|select/i.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { event.preventDefault(); $('q').focus(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCardVideos(); $('previewStage').querySelectorAll('video').forEach(video => video.pause()); }
    else updateScrollLock();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { stopCardVideos(); $('previewStage').querySelectorAll('video').forEach(video => video.pause()); }
    else updateScrollLock();
  });

  $('yr').textContent = new Date().getFullYear();
  if (typeof settings.supportEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.supportEmail)) document.querySelectorAll('[data-support]').forEach(link => { link.href = 'mailto:' + settings.supportEmail + '?subject=TemplateVault%20Support'; });

  async function loadCatalog() {
    catalogReady = false;
    watchNextBatch();
    $('retryLoad').hidden = true;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = '<div class="empty"><strong>Loading designs…</strong></div>';
    try {
      if (location.protocol === 'file:') throw new Error('Open this site through a local web server or your published website URL.');
      const response = await fetch(new URL('data/catalog.json', siteRoot), { cache: 'no-cache' });
      if (!response.ok) throw new Error('Catalog request returned ' + response.status);
      const data = validateCatalog(await response.json());
      products = data.products;
      ads = data.ads;
      catalogReady = true;
      buildControls();
      apply();
    } catch (error) {
      console.error('[TemplateVault] Could not load catalog:', error);
      grid.innerHTML = '<div class="empty"><strong>Designs could not load.</strong>' + (location.protocol === 'file:' ? 'Open this folder through a local web server or visit the published site. See the included README for steps.' : 'Please try again. If this continues, contact support.') + '</div>';
      grid.setAttribute('aria-busy', 'false');
      $('count').textContent = '';
      $('loadSentinel').hidden = true;
      $('retryLoad').hidden = false;
    }
  }
  $('retryLoad').addEventListener('click', loadCatalog);
  loadCatalog();
})();
