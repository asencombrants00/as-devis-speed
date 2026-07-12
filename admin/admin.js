'use strict';

const DATA_PATH = 'data/site-data.json';
const API_VERSION = '2022-11-28';
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_EMAILJS_PUBLIC_KEY = 'iUkwvIEWL6lr0ZmNn';
const DEFAULT_EMAILJS_SERVICE_ID = 'service_f75sdw2';

const state = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  data: null,
  dataSha: '',
  dirty: false,
  selectedCategoryId: '',
  activeTab: 'dashboard',
  busy: false,
  requestsClient: null,
  requestsClientSignature: '',
  requestsConnected: false,
  requests: [],
  selectedRequestId: '',
  quoteLines: [],
  quoteRequestId: '',
  quotePreviewUrl: '',
  quoteMailTouched: false,
  quoteInitialized: false,
  quoteLogoDataUrl: '',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `element-${Date.now()}`;
}

function uid(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(element, message = '', type = '') {
  if (!element) return;
  element.textContent = message;
  element.className = `status${type ? ` ${type}` : ''}${element.id === 'globalStatus' ? ' global' : ''}`;
}

function setGlobalStatus(message = '', type = '') {
  setStatus($('#globalStatus'), message, type);
}

function markDirty() {
  state.dirty = true;
  $('#dirtyBadge')?.classList.remove('hidden');
}

function clearDirty() {
  state.dirty = false;
  $('#dirtyBadge')?.classList.add('hidden');
}

function setBusy(busy, message = '') {
  state.busy = busy;
  $('#publishButton').disabled = busy;
  $('#reloadButton').disabled = busy;
  if (message) setGlobalStatus(message);
}

function getRepoApiPath(filePath) {
  const encodedPath = String(filePath).split('/').map(encodeURIComponent).join('/');
  return `/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodedPath}`;
}

async function githubApi(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const detail = payload?.message || response.statusText || 'Erreur GitHub';
    throw new Error(`${detail} (${response.status})`);
  }
  return payload;
}

function decodeBase64Utf8(base64Value) {
  const binary = atob(String(base64Value).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function loadRepositoryData() {
  const result = await githubApi(`${getRepoApiPath(DATA_PATH)}?ref=${encodeURIComponent(state.branch)}`);
  const decoded = decodeBase64Utf8(result.content);
  const parsed = JSON.parse(decoded);
  if (!Array.isArray(parsed.objects) || !parsed.portfolio?.categories) {
    throw new Error('Le fichier data/site-data.json ne possède pas la structure attendue.');
  }
  state.data = parsed;
  state.dataSha = result.sha;
  state.selectedCategoryId = parsed.portfolio.categories[0]?.id || '';
  clearDirty();
  renderEverything();
  await restoreRequestsSession();
}

async function saveRepositoryData(commitMessage = 'Mise à jour du site depuis l’administration') {
  if (!state.data || state.busy) return;
  setBusy(true, 'Publication en cours sur GitHub…');
  try {
    state.data.version = Number(state.data.version || 1);
    state.data.updatedAt = new Date().toISOString();
    const payload = {
      message: commitMessage,
      content: encodeUtf8Base64(`${JSON.stringify(state.data, null, 2)}\n`),
      sha: state.dataSha,
      branch: state.branch,
    };
    const result = await githubApi(getRepoApiPath(DATA_PATH), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.dataSha = result.content?.sha || state.dataSha;
    clearDirty();
    setGlobalStatus('Publié avec succès. GitHub Pages va mettre le site public à jour.', 'success');
    renderDashboard();
  } catch (error) {
    setGlobalStatus(`Publication impossible : ${error.message}`, 'error');
    throw error;
  } finally {
    setBusy(false);
  }
}

async function uploadRepositoryFile(path, file, commitMessage) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const payload = {
    message: commitMessage,
    content: bytesToBase64(bytes),
    branch: state.branch,
  };
  return githubApi(getRepoApiPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function deleteRepositoryFile(path, commitMessage) {
  if (!path || /^(https?:|data:|blob:)/i.test(path)) return;
  try {
    const current = await githubApi(`${getRepoApiPath(path)}?ref=${encodeURIComponent(state.branch)}`);
    await githubApi(getRepoApiPath(path), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMessage, sha: current.sha, branch: state.branch }),
    });
  } catch (error) {
    console.warn('Le fichier média n’a pas pu être supprimé du dépôt :', error);
  }
}

async function optimizeImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size > MAX_IMAGE_SOURCE_BYTES) throw new Error(`L’image ${file.name} dépasse 20 Mo.`);

  const bitmap = await createImageBitmap(file);
  const maxDimension = 1920;
  const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('Compression de l’image impossible.')), 'image/webp', 0.84);
  });
  const cleanName = file.name.replace(/\.[^.]+$/, '');
  return new File([blob], `${cleanName}.webp`, { type: 'image/webp' });
}

function repoAssetUrl(src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  return `../${src.replace(/^\.\//, '')}`;
}

function currentCategories() {
  return state.data?.portfolio?.categories || [];
}

function currentObjects() {
  return state.data?.objects || [];
}

function getSelectedCategory() {
  return currentCategories().find(category => category.id === state.selectedCategoryId) || null;
}

function getProject(category, projectId) {
  return category?.projects?.find(project => project.id === projectId) || null;
}

function renderEverything() {
  renderDashboard();
  renderCategoryList();
  renderCategoryEditor();
  renderObjectList();
  renderSiteForm();
  renderQuoteEditor();
  renderRequestsSetup();
  $('#repoLabel').textContent = `${state.owner}/${state.repo} — branche ${state.branch}`;
}

function renderDashboard() {
  if (!state.data) return;
  const categories = currentCategories();
  const projects = categories.flatMap(category => category.projects || []);
  const media = projects.flatMap(project => project.media || []);
  $('#statCategories').textContent = categories.filter(category => category.visible !== false).length;
  $('#statProjects').textContent = projects.length;
  $('#statMedia').textContent = media.length;
  $('#statObjects').textContent = currentObjects().filter(item => item.visible !== false).length;
  const newRequests = state.requests.filter(item => ['new', 'review'].includes(item.status || 'new')).length;
  if ($('#statRequests')) $('#statRequests').textContent = newRequests;
  if ($('#requestsNavCount')) {
    $('#requestsNavCount').textContent = newRequests;
    $('#requestsNavCount').classList.toggle('hidden', newRequests === 0);
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  $$('#adminNav button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  const titles = {
    dashboard: 'Tableau de bord',
    requests: 'Demandes clientes',
    portfolio: 'Portefeuille',
    objects: 'Objets et tarifs',
    site: 'Textes du site',
    quotes: 'Préparer un devis',
  };
  $('#pageTitle').textContent = titles[tab] || 'Administration';
}

function renderCategoryList() {
  const root = $('#categoryList');
  if (!root || !state.data) return;
  const categories = [...currentCategories()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  if (!categories.length) {
    root.innerHTML = '<div class="empty-state">Aucune catégorie. Clique sur “Ajouter une catégorie”.</div>';
    return;
  }
  root.innerHTML = categories.map(category => {
    const projects = category.projects || [];
    const mediaCount = projects.reduce((sum, project) => sum + (project.media || []).length, 0);
    return `<article class="category-card ${category.id === state.selectedCategoryId ? 'selected' : ''}" data-category-id="${escapeHtml(category.id)}">
      <h3>${escapeHtml(category.title)}</h3>
      <p>${escapeHtml(category.description || 'Aucune description')}</p>
      <footer><span>${projects.length} chantier(s) · ${mediaCount} fichier(s)</span><span>${category.visible === false ? 'Masquée' : 'Visible'}</span></footer>
    </article>`;
  }).join('');
  $$('.category-card', root).forEach(card => card.addEventListener('click', () => {
    state.selectedCategoryId = card.dataset.categoryId;
    renderCategoryList();
    renderCategoryEditor();
  }));
}

function moveElement(array, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= array.length) return;
  [array[index], array[target]] = [array[target], array[index]];
  array.forEach((item, itemIndex) => { item.order = itemIndex; });
  markDirty();
}

function renderCategoryEditor() {
  const root = $('#categoryEditor');
  const category = getSelectedCategory();
  if (!root) return;
  if (!category) {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('hidden');
  const sortedProjects = [...(category.projects || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  root.innerHTML = `
    <div class="editor-header">
      <div><h2>Modifier : ${escapeHtml(category.title)}</h2><p class="help">Les changements seront visibles après publication.</p></div>
      <div class="button-row">
        <button class="button secondary small" data-action="category-up">↑ Monter</button>
        <button class="button secondary small" data-action="category-down">↓ Descendre</button>
      </div>
    </div>
    <div class="form-grid">
      <label>Nom de la catégorie<input id="categoryTitle" value="${escapeHtml(category.title)}"></label>
      <label>Identifiant technique<input value="${escapeHtml(category.id)}" disabled></label>
      <label class="full">Description<textarea id="categoryDescription" rows="3">${escapeHtml(category.description || '')}</textarea></label>
      <label class="checkbox-label full"><input id="categoryVisible" type="checkbox" ${category.visible !== false ? 'checked' : ''}> Afficher cette catégorie sur le site</label>
    </div>
    <div class="section-heading" style="margin-top:28px"><div><h3>Chantiers de cette catégorie</h3><p>Chaque chantier peut contenir plusieurs photos ou vidéos.</p></div><button class="button primary small" data-action="add-project">+ Ajouter un chantier</button></div>
    <div class="project-list">${sortedProjects.length ? sortedProjects.map((project, index) => renderProjectCard(category, project, index)).join('') : '<div class="empty-state">Aucun chantier dans cette catégorie.</div>'}</div>
    <div class="danger-zone"><button class="button danger" data-action="delete-category">Supprimer cette catégorie</button></div>`;

  $('#categoryTitle', root).addEventListener('input', event => { category.title = event.target.value; markDirty(); });
  $('#categoryTitle', root).addEventListener('change', renderCategoryList);
  $('#categoryDescription', root).addEventListener('input', event => { category.description = event.target.value; markDirty(); });
  $('#categoryVisible', root).addEventListener('change', event => { category.visible = event.target.checked; markDirty(); renderCategoryList(); });

  $$('[data-action]', root).forEach(button => button.addEventListener('click', () => handlePortfolioAction(button.dataset.action, button.dataset.projectId, button.dataset.mediaId)));

  $$('.project-title-input', root).forEach(input => input.addEventListener('input', () => {
    const project = getProject(category, input.dataset.projectId);
    if (project) { project.title = input.value; markDirty(); }
  }));
  $$('.project-description-input', root).forEach(input => input.addEventListener('input', () => {
    const project = getProject(category, input.dataset.projectId);
    if (project) { project.description = input.value; markDirty(); }
  }));
  $$('.media-label-select', root).forEach(select => select.addEventListener('change', () => {
    const project = getProject(category, select.dataset.projectId);
    const media = project?.media?.find(file => file.id === select.dataset.mediaId);
    if (media) { media.label = select.value; markDirty(); }
  }));
  $$('.upload-project-button', root).forEach(button => button.addEventListener('click', () => uploadProjectMedia(button.dataset.projectId)));
}

function renderProjectCard(category, project, index) {
  const sortedMedia = [...(project.media || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return `<article class="project-card">
    <div class="project-head"><h4>Chantier ${index + 1}</h4><div class="button-row">
      <button class="button secondary small" data-action="project-up" data-project-id="${escapeHtml(project.id)}">↑</button>
      <button class="button secondary small" data-action="project-down" data-project-id="${escapeHtml(project.id)}">↓</button>
      <button class="button danger small" data-action="delete-project" data-project-id="${escapeHtml(project.id)}">Supprimer</button>
    </div></div>
    <div class="form-grid">
      <label>Titre<input class="project-title-input" data-project-id="${escapeHtml(project.id)}" value="${escapeHtml(project.title || '')}"></label>
      <label>Description<input class="project-description-input" data-project-id="${escapeHtml(project.id)}" value="${escapeHtml(project.description || '')}"></label>
    </div>
    <div class="upload-row">
      <label>Type des fichiers<select id="uploadLabel-${escapeHtml(project.id)}"><option>Avant</option><option>Après</option><option>Photo</option><option>Vidéo</option></select></label>
      <label>Ajouter des fichiers<input id="uploadFiles-${escapeHtml(project.id)}" type="file" accept="image/*,video/mp4,video/webm" multiple></label>
      <button class="button primary upload-project-button" data-project-id="${escapeHtml(project.id)}">Ajouter les fichiers</button>
    </div>
    <div class="media-grid-admin">${sortedMedia.length ? sortedMedia.map(media => renderMediaCard(project, media)).join('') : '<div class="empty-state">Aucun fichier.</div>'}</div>
  </article>`;
}

function renderMediaCard(project, media) {
  const src = repoAssetUrl(media.src);
  const preview = media.type === 'video'
    ? `<video src="${escapeHtml(src)}" muted playsinline></video>`
    : `<img src="${escapeHtml(src)}" alt="${escapeHtml(media.alt || '')}">`;
  const labels = ['Avant', 'Après', 'Photo', 'Vidéo'];
  return `<article class="media-admin-card">
    <div class="media-preview">${preview}</div>
    <div class="media-controls">
      <select class="media-label-select" data-project-id="${escapeHtml(project.id)}" data-media-id="${escapeHtml(media.id)}">${labels.map(label => `<option ${media.label === label ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <div class="order-buttons">
        <button class="button secondary small" data-action="media-up" data-project-id="${escapeHtml(project.id)}" data-media-id="${escapeHtml(media.id)}">↑</button>
        <button class="button secondary small" data-action="media-down" data-project-id="${escapeHtml(project.id)}" data-media-id="${escapeHtml(media.id)}">↓</button>
        <button class="button danger small" data-action="delete-media" data-project-id="${escapeHtml(project.id)}" data-media-id="${escapeHtml(media.id)}">Retirer</button>
      </div>
    </div>
  </article>`;
}

async function handlePortfolioAction(action, projectId, mediaId) {
  const categories = currentCategories().sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const category = getSelectedCategory();
  if (!category) return;
  const categoryIndex = categories.findIndex(item => item.id === category.id);
  const projects = category.projects || (category.projects = []);
  const projectIndex = projects.findIndex(project => project.id === projectId);
  const project = projects[projectIndex];

  if (action === 'category-up') moveElement(categories, categoryIndex, -1);
  if (action === 'category-down') moveElement(categories, categoryIndex, 1);
  if (action === 'add-project') {
    projects.push({ id: uid(`${category.id}-chantier`), title: `${category.title} — nouveau chantier`, description: '', order: projects.length, media: [] });
    markDirty();
  }
  if (action === 'delete-category') {
    if (!confirm(`Supprimer la catégorie “${category.title}” et la retirer du site ?`)) return;
    state.data.portfolio.categories = currentCategories().filter(item => item.id !== category.id);
    state.data.portfolio.categories.forEach((item, index) => { item.order = index; });
    state.selectedCategoryId = currentCategories()[0]?.id || '';
    markDirty();
  }
  if (action === 'project-up' && project) moveElement(projects, projectIndex, -1);
  if (action === 'project-down' && project) moveElement(projects, projectIndex, 1);
  if (action === 'delete-project' && project) {
    if (!confirm(`Supprimer le chantier “${project.title}” ?`)) return;
    category.projects = projects.filter(item => item.id !== project.id);
    category.projects.forEach((item, index) => { item.order = index; });
    markDirty();
  }
  if ((action === 'media-up' || action === 'media-down') && project) {
    const mediaIndex = project.media.findIndex(file => file.id === mediaId);
    moveElement(project.media, mediaIndex, action === 'media-up' ? -1 : 1);
  }
  if (action === 'delete-media' && project) {
    const media = project.media.find(file => file.id === mediaId);
    if (!media || !confirm(`Retirer ce fichier “${media.label || 'Photo'}” du site ?`)) return;
    project.media = project.media.filter(file => file.id !== mediaId);
    project.media.forEach((file, index) => { file.order = index; });
    markDirty();
    try {
      await saveRepositoryData('Retrait d’un fichier du portefeuille');
      await deleteRepositoryFile(media.src, 'Suppression d’un ancien fichier du portefeuille');
    } catch { /* message déjà affiché */ }
  }
  renderCategoryList();
  renderCategoryEditor();
  renderDashboard();
}

async function uploadProjectMedia(projectId) {
  const category = getSelectedCategory();
  const project = getProject(category, projectId);
  const fileInput = document.getElementById(`uploadFiles-${projectId}`);
  const labelInput = document.getElementById(`uploadLabel-${projectId}`);
  const files = [...(fileInput?.files || [])];
  if (!category || !project || !files.length) {
    alert('Choisis au moins une photo ou une vidéo.');
    return;
  }

  setBusy(true, `Envoi de ${files.length} fichier(s) sur GitHub…`);
  try {
    for (let index = 0; index < files.length; index += 1) {
      let file = files[index];
      if (file.type.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
        throw new Error(`${file.name} dépasse 25 Mo. Compresse la vidéo avant de l’ajouter.`);
      }
      if (file.type.startsWith('image/')) file = await optimizeImage(file);
      const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : (file.type.startsWith('video/') ? 'mp4' : 'webp');
      const filename = `${Date.now()}-${index + 1}-${slugify(file.name.replace(/\.[^.]+$/, ''))}.${extension}`;
      const path = `assets/portfolio/${slugify(category.id)}/${filename}`;
      setGlobalStatus(`Envoi ${index + 1}/${files.length} : ${file.name}`);
      await uploadRepositoryFile(path, file, `Ajout de ${file.name} au portefeuille`);
      project.media ||= [];
      project.media.push({
        id: uid(`${project.id}-media`),
        type: file.type.startsWith('video/') ? 'video' : 'image',
        src: path,
        label: labelInput?.value || (file.type.startsWith('video/') ? 'Vidéo' : 'Photo'),
        alt: `${category.title} — ${labelInput?.value || 'Photo'}`,
        order: project.media.length,
      });
    }
    markDirty();
    setBusy(false);
    await saveRepositoryData('Mise à jour du portefeuille et de ses fichiers');
    renderCategoryEditor();
    renderCategoryList();
    renderDashboard();
  } catch (error) {
    setGlobalStatus(`Envoi impossible : ${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function addCategory() {
  const title = prompt('Nom de la nouvelle catégorie :', 'Nouvelle catégorie');
  if (!title) return;
  let id = slugify(title);
  let suffix = 2;
  while (currentCategories().some(category => category.id === id)) id = `${slugify(title)}-${suffix++}`;
  const category = { id, title, description: '', visible: true, order: currentCategories().length, projects: [] };
  currentCategories().push(category);
  state.selectedCategoryId = id;
  markDirty();
  renderCategoryList();
  renderCategoryEditor();
  renderDashboard();
}

function renderObjectList() {
  const root = $('#objectList');
  if (!root || !state.data) return;
  const query = ($('#objectSearch')?.value || '').trim().toLowerCase();
  const objects = currentObjects().filter(item => `${item.name} ${item.category}`.toLowerCase().includes(query));
  if (!objects.length) {
    root.innerHTML = '<div class="empty-state">Aucun objet trouvé.</div>';
    return;
  }
  root.innerHTML = objects.map(item => `<article class="object-row">
    <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></div>
    <div class="object-category">${escapeHtml(item.category)}</div>
    <div class="object-price internal-value">${Number(item.price || 0).toFixed(2)} €</div>
    <div class="object-weight internal-value">${Number(item.weightKg || 0).toFixed(1)} kg</div>
    <div><span class="visibility ${item.visible === false ? 'off' : ''}">${item.visible === false ? 'Masqué' : 'Visible'}</span><button class="button secondary small edit-object" data-object-id="${escapeHtml(item.id)}" style="margin-left:8px">Modifier</button></div>
  </article>`).join('');
  $$('.edit-object', root).forEach(button => button.addEventListener('click', () => openObjectEditor(button.dataset.objectId)));
}

function openObjectEditor(objectId = '') {
  const modal = $('#objectEditor');
  const existing = currentObjects().find(item => item.id === objectId);
  const item = existing ? { ...existing } : { id: '', name: '', category: 'Mobilier', price: 0, weightKg: 0, wasteType: 'Mobilier', visible: true };
  const objectCategories = [
    'Mobilier',
    'Literie',
    'Canapés',
    'Informatique / TV',
    'Petits objets',
    'Électroménager',
    'Salle de bain / Cuisine',
    'Extérieur / Divers',
  ];
  const defaultWasteTypeByCategory = {
    'Mobilier': 'Mobilier',
    'Literie': 'Literie',
    'Canapés': 'Mobilier',
    'Informatique / TV': 'Tout-venant',
    'Petits objets': 'Tout-venant',
    'Électroménager': 'Tout-venant',
    'Salle de bain / Cuisine': 'Tout-venant',
    'Extérieur / Divers': 'Tout-venant',
  };
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>${existing ? 'Modifier l’objet' : 'Ajouter un objet'}</h3><button class="close-button" type="button">×</button></div>
    <form id="objectForm" class="form-grid">
      <label>Nom de l’objet<input id="objectNameInput" value="${escapeHtml(item.name)}" required></label>
      <label>Identifiant<input id="objectIdInput" value="${escapeHtml(item.id)}" placeholder="créé automatiquement"></label>
      <label>Catégorie de l’objet<select id="objectCategoryInput" required>${objectCategories.map(category => `<option value="${escapeHtml(category)}" ${item.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select><small>Le bouton « Tous » est ajouté automatiquement sur le site.</small></label>
      <label>Prix unitaire interne (€)<input id="objectPriceInput" type="number" min="0" step="0.01" value="${Number(item.price || 0)}" required></label>
      <label>Poids unitaire interne (kg)<input id="objectWeightInput" type="number" min="0" step="0.1" value="${Number(item.weightKg || 0)}" required></label>
      <label class="checkbox-label full"><input id="objectVisibleInput" type="checkbox" ${item.visible !== false ? 'checked' : ''}> Afficher cet objet dans le panier client</label>
      <div class="button-row full"><button class="button primary" type="submit">Enregistrer</button>${existing ? '<button id="deleteObjectButton" class="button danger" type="button">Supprimer définitivement</button>' : ''}</div>
    </form>
  </div>`;
  modal.classList.remove('hidden');
  $('.close-button', modal).addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', event => { if (event.target === modal) modal.classList.add('hidden'); }, { once: true });
  $('#objectNameInput', modal).addEventListener('input', event => {
    if (!existing && !$('#objectIdInput', modal).dataset.manual) $('#objectIdInput', modal).value = slugify(event.target.value).replaceAll('-', '_');
  });
  $('#objectIdInput', modal).addEventListener('input', event => { event.target.dataset.manual = '1'; });
  $('#objectForm', modal).addEventListener('submit', event => {
    event.preventDefault();
    const newId = slugify($('#objectIdInput', modal).value || $('#objectNameInput', modal).value).replaceAll('-', '_');
    const duplicate = currentObjects().some(object => object.id === newId && (!existing || object.id !== existing.id));
    if (duplicate) return alert('Cet identifiant existe déjà. Choisis-en un autre.');
    const selectedCategory = $('#objectCategoryInput', modal).value;
    const updated = {
      id: newId,
      name: $('#objectNameInput', modal).value.trim(),
      category: selectedCategory,
      price: Number($('#objectPriceInput', modal).value || 0),
      weightKg: Number($('#objectWeightInput', modal).value || 0),
      // Ce champ reste interne pour calculer les frais de déchetterie.
      // Pour un objet existant, on garde sa valeur actuelle. Pour un nouvel objet,
      // une valeur simple est choisie automatiquement selon la catégorie du site.
      wasteType: existing?.wasteType || defaultWasteTypeByCategory[selectedCategory] || 'Tout-venant',
      visible: $('#objectVisibleInput', modal).checked,
    };
    if (existing) Object.assign(existing, updated);
    else currentObjects().push(updated);
    markDirty();
    modal.classList.add('hidden');
    renderObjectList();
    renderDashboard();
  });
  $('#deleteObjectButton', modal)?.addEventListener('click', () => {
    if (!confirm(`Supprimer définitivement “${existing.name}” ? Il est souvent préférable de le masquer.`)) return;
    state.data.objects = currentObjects().filter(object => object.id !== existing.id);
    markDirty();
    modal.classList.add('hidden');
    renderObjectList();
    renderDashboard();
  });
}


const REQUEST_STATUS_LABELS = {
  new: 'Nouvelle',
  review: 'À vérifier',
  quoted: 'Devis envoyé',
  accepted: 'Acceptée',
  refused: 'Refusée',
  done: 'Terminée',
};

function getRequestsConfig() {
  const config = state.data?.requests || {};
  return {
    url: String(config.supabaseUrl || '').trim().replace(/\/$/, ''),
    key: String(config.supabaseAnonKey || '').trim(),
  };
}

function getRequestsClient() {
  const { url, key } = getRequestsConfig();
  if (!url || !key) throw new Error('Enregistre d’abord l’adresse Supabase et la clé publique.');
  if (!window.supabase?.createClient) throw new Error('Le module des demandes ne s’est pas chargé. Recharge la page.');
  const signature = `${url}|${key}`;
  if (!state.requestsClient || state.requestsClientSignature !== signature) {
    state.requestsClient = window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'as-encombrants-demandes-auth',
      },
    });
    state.requestsClientSignature = signature;
  }
  return state.requestsClient;
}

function renderRequestsSetup() {
  if (!state.data) return;
  const config = getRequestsConfig();
  if ($('#requestsSupabaseUrl')) $('#requestsSupabaseUrl').value = config.url;
  if ($('#requestsSupabaseKey')) $('#requestsSupabaseKey').value = config.key;
  if ($('#requestsAdminEmail')) $('#requestsAdminEmail').value = localStorage.getItem('asRequestsAdminEmail') || '';
  updateRequestsConnectionView();
}

function updateRequestsConnectionView() {
  const connected = state.requestsConnected;
  $('#requestsWorkspace')?.classList.toggle('hidden', !connected);
  $('#disconnectRequestsButton')?.classList.toggle('hidden', !connected);
  $('#connectRequestsButton')?.classList.toggle('hidden', connected);
}

async function saveRequestsConfig() {
  const url = $('#requestsSupabaseUrl').value.trim().replace(/\/$/, '');
  const key = $('#requestsSupabaseKey').value.trim();
  if (!url || !key) return setStatus($('#requestsStatus'), 'Colle l’adresse Supabase et la clé publique.', 'error');
  state.data.requests = { supabaseUrl: url, supabaseAnonKey: key };
  state.requestsClient = null;
  state.requestsClientSignature = '';
  markDirty();
  setStatus($('#requestsStatus'), 'Enregistrement sur GitHub…');
  try {
    await saveRepositoryData('Activation des demandes clientes dans l’administration');
    setStatus($('#requestsStatus'), 'Connexion enregistrée. Passe maintenant à l’étape 2.', 'success');
  } catch (error) {
    setStatus($('#requestsStatus'), `Enregistrement impossible : ${error.message}`, 'error');
  }
}

async function connectRequests() {
  const email = $('#requestsAdminEmail').value.trim();
  const password = $('#requestsAdminPassword').value;
  if (!email || !password) return setStatus($('#requestsStatus'), 'Indique ton email et ton mot de passe Supabase.', 'error');
  setStatus($('#requestsStatus'), 'Ouverture des demandes…');
  try {
    const client = getRequestsClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    localStorage.setItem('asRequestsAdminEmail', email);
    $('#requestsAdminPassword').value = '';
    state.requestsConnected = true;
    updateRequestsConnectionView();
    await loadRequests();
    setStatus($('#requestsStatus'), 'Demandes ouvertes.', 'success');
  } catch (error) {
    setStatus($('#requestsStatus'), `Connexion impossible : ${error.message}`, 'error');
  }
}

async function restoreRequestsSession() {
  const { url, key } = getRequestsConfig();
  if (!url || !key) return;
  try {
    const client = getRequestsClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (data?.session) {
      state.requestsConnected = true;
      updateRequestsConnectionView();
      await loadRequests();
      setStatus($('#requestsStatus'), 'Demandes ouvertes.', 'success');
    }
  } catch (error) {
    console.warn('Session demandes non restaurée :', error);
  }
}

async function disconnectRequests() {
  try {
    await state.requestsClient?.auth.signOut();
  } catch { /* rien */ }
  state.requestsConnected = false;
  state.requests = [];
  state.selectedRequestId = '';
  updateRequestsConnectionView();
  renderRequestsList();
  renderRequestDetail();
  renderDashboard();
  setStatus($('#requestsStatus'), 'Demandes fermées.');
}

async function loadRequests() {
  if (!state.requestsConnected) return;
  setStatus($('#requestsStatus'), 'Chargement des demandes…');
  try {
    const client = getRequestsClient();
    const { data, error } = await client
      .from('quote_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    state.requests = Array.isArray(data) ? data : [];
    if (state.selectedRequestId && !state.requests.some(item => item.id === state.selectedRequestId)) state.selectedRequestId = '';
    renderRequestsList();
    renderRequestDetail();
    renderDashboard();
    setStatus($('#requestsStatus'), `${state.requests.length} demande(s) chargée(s).`, 'success');
  } catch (error) {
    setStatus($('#requestsStatus'), `Chargement impossible : ${error.message}`, 'error');
  }
}

function requestDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  } catch { return value; }
}

function renderRequestsList() {
  const root = $('#requestsList');
  if (!root) return;
  if (!state.requestsConnected) {
    root.innerHTML = '';
    return;
  }
  const query = ($('#requestsSearch')?.value || '').trim().toLowerCase();
  const status = $('#requestsStatusFilter')?.value || '';
  const filtered = state.requests.filter(item => {
    const text = `${item.name || ''} ${item.phone || ''} ${item.email || ''} ${item.city || ''} ${item.address || ''}`.toLowerCase();
    return (!query || text.includes(query)) && (!status || (item.status || 'new') === status);
  });
  if (!filtered.length) {
    root.innerHTML = '<div class="empty-state">Aucune demande trouvée.</div>';
    return;
  }
  root.innerHTML = filtered.map(item => {
    const itemStatus = item.status || 'new';
    return `<button type="button" class="request-card ${item.id === state.selectedRequestId ? 'selected' : ''}" data-request-id="${escapeHtml(item.id)}">
      <span class="request-card-top"><strong>${escapeHtml(item.name || 'Client sans nom')}</strong><span class="request-status status-${escapeHtml(itemStatus)}">${escapeHtml(REQUEST_STATUS_LABELS[itemStatus] || itemStatus)}</span></span>
      <span>${escapeHtml(item.city || item.address || 'Adresse non renseignée')}</span>
      <span>${Number(item.estimate || 0).toLocaleString('fr-FR')} € · ${escapeHtml(requestDate(item.created_at))}</span>
    </button>`;
  }).join('');
  $$('.request-card', root).forEach(button => button.addEventListener('click', () => {
    state.selectedRequestId = button.dataset.requestId;
    renderRequestsList();
    renderRequestDetail();
  }));
}

function renderRequestDetail() {
  const root = $('#requestDetail');
  if (!root) return;
  const item = state.requests.find(request => request.id === state.selectedRequestId);
  if (!item) {
    root.innerHTML = '<div class="empty-state">Choisis une demande à gauche.</div>';
    return;
  }
  const itemStatus = item.status || 'new';
  const statusOptions = Object.entries(REQUEST_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${itemStatus === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  root.innerHTML = `
    <div class="request-detail-head">
      <div><h2>${escapeHtml(item.name || 'Client')}</h2><p>${escapeHtml(requestDate(item.created_at))}</p></div>
      <span class="request-status status-${escapeHtml(itemStatus)}">${escapeHtml(REQUEST_STATUS_LABELS[itemStatus] || itemStatus)}</span>
    </div>
    <div class="request-contact-grid">
      <a href="tel:${escapeHtml(item.phone || '')}"><span>Téléphone</span><strong>${escapeHtml(item.phone || 'Non renseigné')}</strong></a>
      <a href="mailto:${escapeHtml(item.email || '')}"><span>Email</span><strong>${escapeHtml(item.email || 'Non renseigné')}</strong></a>
      <div class="full"><span>Adresse</span><strong>${escapeHtml([item.address, item.city].filter(Boolean).join(', ') || 'Non renseignée')}</strong></div>
    </div>
    <div class="request-block"><h3>Objets / demande</h3><pre>${escapeHtml(item.items || 'Non renseigné')}</pre></div>
    <div class="request-block"><h3>Accès</h3><pre>${escapeHtml(item.access_details || 'Non renseigné')}</pre></div>
    <div class="request-block"><h3>Informations complémentaires</h3><pre>${escapeHtml(item.additional_info || 'Aucune')}</pre></div>
    <div class="request-numbers">
      <div><span>Estimation</span><strong>${Number(item.estimate || 0).toLocaleString('fr-FR')} €</strong></div>
      <div><span>Poids estimé</span><strong>${Number(item.estimated_weight_kg || 0).toFixed(1)} kg</strong></div>
      <div><span>Distance</span><strong>${Number(item.travel_distance_km || 0).toFixed(1)} km</strong></div>
      <div><span>Photos</span><strong>${Number(item.photo_count || 0)}</strong></div>
    </div>
    ${item.photos_link ? `<p><a href="${escapeHtml(item.photos_link)}" target="_blank" rel="noopener">Ouvrir le lien des photos</a></p>` : ''}
    ${Number(item.photo_count || 0) > 0 && !item.photos_link ? '<div class="warning">Les fichiers photos joints continuent d’arriver par mail. Seul leur nombre est affiché ici.</div>' : ''}
    <div class="form-grid request-admin-fields">
      <label>Statut<select id="requestStatusInput">${statusOptions}</select></label>
      <label>Prix final du devis (€)<input id="requestQuotePriceInput" type="number" min="0" step="1" value="${Number(item.quote_price ?? item.estimate ?? 0)}"></label>
      <label class="full">Note privée<textarea id="requestAdminNoteInput" rows="3">${escapeHtml(item.admin_note || '')}</textarea></label>
    </div>
    <details class="request-technical"><summary>Voir les calculs internes</summary><pre>${escapeHtml([item.internal_calculation, item.travel_details].filter(Boolean).join('\n\n'))}</pre></details>
    <div class="button-row">
      <button id="saveRequestButton" class="button secondary" type="button">Enregistrer</button>
      <button id="prepareRequestQuoteButton" class="button primary" type="button">Créer le devis</button>
      <button id="deleteRequestButton" class="button danger" type="button">Supprimer</button>
    </div>`;
  $('#saveRequestButton').addEventListener('click', saveSelectedRequest);
  $('#prepareRequestQuoteButton').addEventListener('click', prepareQuoteFromSelectedRequest);
  $('#deleteRequestButton').addEventListener('click', deleteSelectedRequest);
}

async function saveSelectedRequest() {
  const item = state.requests.find(request => request.id === state.selectedRequestId);
  if (!item) return;
  const changes = {
    status: $('#requestStatusInput').value,
    quote_price: Number($('#requestQuotePriceInput').value || 0),
    admin_note: $('#requestAdminNoteInput').value.trim(),
    updated_at: new Date().toISOString(),
  };
  setStatus($('#requestsStatus'), 'Enregistrement de la demande…');
  try {
    const client = getRequestsClient();
    const { error } = await client.from('quote_requests').update(changes).eq('id', item.id);
    if (error) throw error;
    Object.assign(item, changes);
    renderRequestsList();
    renderRequestDetail();
    renderDashboard();
    setStatus($('#requestsStatus'), 'Demande enregistrée.', 'success');
  } catch (error) {
    setStatus($('#requestsStatus'), `Enregistrement impossible : ${error.message}`, 'error');
  }
}

function prepareQuoteFromSelectedRequest() {
  const item = state.requests.find(request => request.id === state.selectedRequestId);
  if (!item) return;
  renderQuoteEditor();
  state.quoteRequestId = item.id;
  state.quoteMailTouched = false;

  const created = item.created_at ? new Date(item.created_at) : new Date();
  const suffix = String(item.id || '').replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase() || String(Date.now()).slice(-5);
  $('#quoteNumber').value = `DEV-${created.getFullYear()}-${suffix}`;
  $('#quoteIssueDate').value = isoDate(new Date());
  $('#quoteValidUntil').value = isoDate(addDays(new Date(), Number(state.data?.site?.quoteValidityDays || 15)));
  $('#quoteClientName').value = item.name || '';
  $('#quoteClientEmail').value = item.email || '';
  $('#quoteClientPhone').value = item.phone || '';
  $('#quoteClientAddress').value = item.address || '';
  $('#quoteClientCity').value = item.city || '';
  $('#quoteClientCountry').value = 'France';
  $('#quoteNotes').value = [item.access_details, item.additional_info, item.admin_note].filter(Boolean).join('\n\n');

  state.quoteLines = parseItemsToQuoteLines(item.items || '');
  const finalPrice = Number(item.quote_price ?? item.estimate ?? 0);
  if (finalPrice > 0) {
    state.quoteLines.push({
      id: uid('quote-line'),
      description: 'Forfait enlèvement, manutention, transport et frais de déchetterie professionnelle',
      quantity: 1,
      unitPrice: finalPrice,
    });
  }
  if (!state.quoteLines.length) state.quoteLines = [emptyQuoteLine()];
  renderQuoteLines();
  regenerateQuoteMail();
  setActiveTab('quotes');
  refreshQuotePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function deleteSelectedRequest() {
  const item = state.requests.find(request => request.id === state.selectedRequestId);
  if (!item || !confirm(`Supprimer définitivement la demande de ${item.name || 'ce client'} ?`)) return;
  try {
    const client = getRequestsClient();
    const { error } = await client.from('quote_requests').delete().eq('id', item.id);
    if (error) throw error;
    state.requests = state.requests.filter(request => request.id !== item.id);
    state.selectedRequestId = '';
    renderRequestsList();
    renderRequestDetail();
    renderDashboard();
    setStatus($('#requestsStatus'), 'Demande supprimée.', 'success');
  } catch (error) {
    setStatus($('#requestsStatus'), `Suppression impossible : ${error.message}`, 'error');
  }
}

function renderSiteForm() {
  const form = $('#siteForm');
  if (!form || !state.data) return;
  const site = state.data.site || (state.data.site = {});
  const fields = [
    ['companyName', 'Nom de l’entreprise', 'text'],
    ['companyAddress', 'Adresse de l’entreprise sur le devis', 'text'],
    ['phoneDisplay', 'Téléphone affiché', 'text'],
    ['phoneHref', 'Téléphone sans espaces', 'text'],
    ['email', 'Adresse email', 'email'],
    ['heroTitle', 'Grand titre de l’accueil', 'text'],
    ['heroAccent', 'Partie rouge du grand titre', 'text'],
    ['heroText', 'Texte sous le grand titre', 'textarea'],
    ['presentationSubtitle', 'Sous-titre de présentation', 'textarea'],
    ['portfolioTitle', 'Titre du portefeuille', 'text'],
    ['portfolioSubtitle', 'Sous-titre du portefeuille', 'textarea'],
    ['bookingUrl', 'Lien de réservation Google Calendar', 'url'],
    ['quoteValidityDays', 'Validité du devis en jours', 'number'],
  ];
  form.innerHTML = fields.map(([key, label, type]) => {
    const value = site[key] ?? '';
    const full = type === 'textarea' ? ' full' : '';
    return type === 'textarea'
      ? `<label class="${full.trim()}">${escapeHtml(label)}<textarea data-site-key="${key}" rows="4">${escapeHtml(value)}</textarea></label>`
      : `<label>${escapeHtml(label)}<input data-site-key="${key}" type="${type}" ${type === 'number' ? 'min="1"' : ''} value="${escapeHtml(value)}"></label>`;
  }).join('') + '<div class="warning full"><strong>Réservation :</strong> colle ici le lien public de ta page de rendez-vous Google Calendar. Il sera proposé dans le message de devis après ta validation.</div>';
  $$('[data-site-key]', form).forEach(input => input.addEventListener('input', () => {
    const key = input.dataset.siteKey;
    site[key] = input.type === 'number' ? Number(input.value || 0) : input.value;
    markDirty();
    if (!state.quoteMailTouched) regenerateQuoteMail();
  }));
}

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

function formatFrenchDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(`${value}T12:00:00`));
  } catch {
    return value;
  }
}

function money(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function emptyQuoteLine(overrides = {}) {
  return {
    id: uid('quote-line'),
    description: '',
    quantity: 1,
    unitPrice: 0,
    ...overrides,
  };
}

function parseItemsToQuoteLines(itemsText) {
  return String(itemsText || '')
    .split(/\n+/)
    .map(line => line.replace(/^\s*[-•]\s*/, '').trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(.*?)\s+x\s*([0-9]+(?:[.,][0-9]+)?)\s*$/i);
      return emptyQuoteLine({
        description: (match?.[1] || line).trim(),
        quantity: Number(String(match?.[2] || 1).replace(',', '.')) || 1,
        unitPrice: 0,
      });
    });
}

function getQuoteEmailConfig() {
  const config = state.data?.quoteEmail || {};
  return {
    publicKey: String(config.publicKey || DEFAULT_EMAILJS_PUBLIC_KEY).trim(),
    serviceId: String(config.serviceId || DEFAULT_EMAILJS_SERVICE_ID).trim(),
    templateId: String(config.templateId || '').trim(),
  };
}

function renderQuoteEmailConfig() {
  const config = getQuoteEmailConfig();
  if ($('#quoteEmailPublicKey')) $('#quoteEmailPublicKey').value = config.publicKey;
  if ($('#quoteEmailServiceId')) $('#quoteEmailServiceId').value = config.serviceId;
  if ($('#quoteEmailTemplateId')) $('#quoteEmailTemplateId').value = config.templateId;
}

function renderQuoteEditor() {
  if (!$('#quoteLines')) return;
  renderQuoteEmailConfig();
  if (state.quoteInitialized) return;
  state.quoteInitialized = true;
  newBlankQuote();
}

function defaultQuoteNumber() {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `DEV-${datePart}-${String(Date.now()).slice(-4)}`;
}

function newBlankQuote() {
  state.quoteRequestId = '';
  state.quoteMailTouched = false;
  $('#quoteClientName').value = '';
  $('#quoteClientEmail').value = '';
  $('#quoteClientPhone').value = '';
  $('#quoteClientAddress').value = '';
  $('#quoteClientCity').value = '';
  $('#quoteClientCountry').value = 'France';
  $('#quoteNumber').value = defaultQuoteNumber();
  $('#quoteIssueDate').value = isoDate(new Date());
  $('#quoteValidUntil').value = isoDate(addDays(new Date(), Number(state.data?.site?.quoteValidityDays || 15)));
  $('#quoteNotes').value = 'Tarif valable sous réserve que les objets, les quantités et les conditions d’accès correspondent aux informations et photos transmises.';
  state.quoteLines = [emptyQuoteLine()];
  renderQuoteLines();
  regenerateQuoteMail();
  refreshQuotePreview();
  setStatus($('#quoteSendStatus'), 'Nouveau devis vierge prêt à remplir.');
}

function quoteLineAmount(line) {
  return Math.max(0, Number(line.quantity || 0)) * Math.max(0, Number(line.unitPrice || 0));
}

function quoteTotal() {
  return state.quoteLines.reduce((sum, line) => sum + quoteLineAmount(line), 0);
}

function renderQuoteLines() {
  const root = $('#quoteLines');
  if (!root) return;
  root.innerHTML = state.quoteLines.map(line => `
    <div class="quote-line-row" data-quote-line-id="${escapeHtml(line.id)}">
      <input class="quote-description" data-quote-field="description" value="${escapeHtml(line.description)}" placeholder="Description de la prestation">
      <input data-quote-field="quantity" type="number" min="0" step="1" value="${Number(line.quantity || 0)}" aria-label="Quantité">
      <input data-quote-field="unitPrice" type="number" min="0" step="0.01" value="${Number(line.unitPrice || 0)}" aria-label="Prix unitaire">
      <strong class="quote-line-amount">${money(quoteLineAmount(line))}</strong>
      <button class="quote-line-remove" type="button" title="Supprimer la ligne" aria-label="Supprimer la ligne">×</button>
    </div>`).join('');

  $$('.quote-line-row', root).forEach(row => {
    const line = state.quoteLines.find(item => item.id === row.dataset.quoteLineId);
    if (!line) return;
    $$('[data-quote-field]', row).forEach(input => input.addEventListener('input', () => {
      const key = input.dataset.quoteField;
      line[key] = key === 'description' ? input.value : Number(input.value || 0);
      $('.quote-line-amount', row).textContent = money(quoteLineAmount(line));
      updateQuoteTotal();
    }));
    $('.quote-line-remove', row).addEventListener('click', () => {
      state.quoteLines = state.quoteLines.filter(item => item.id !== line.id);
      if (!state.quoteLines.length) state.quoteLines.push(emptyQuoteLine());
      renderQuoteLines();
      updateQuoteTotal();
    });
  });
  updateQuoteTotal();
}

function updateQuoteTotal() {
  if ($('#quoteTotal')) $('#quoteTotal').textContent = money(quoteTotal());
  if (!state.quoteMailTouched) regenerateQuoteMail();
}

function addQuoteLine() {
  state.quoteLines.push(emptyQuoteLine());
  renderQuoteLines();
  const rows = $$('.quote-line-row');
  rows.at(-1)?.querySelector('.quote-description')?.focus();
}

function collectQuoteData(requireComplete = false) {
  const data = {
    clientName: $('#quoteClientName').value.trim(),
    clientEmail: $('#quoteClientEmail').value.trim(),
    clientPhone: $('#quoteClientPhone').value.trim(),
    clientAddress: $('#quoteClientAddress').value.trim(),
    clientCity: $('#quoteClientCity').value.trim(),
    clientCountry: $('#quoteClientCountry').value.trim() || 'France',
    quoteNumber: $('#quoteNumber').value.trim() || defaultQuoteNumber(),
    issueDate: $('#quoteIssueDate').value,
    validUntil: $('#quoteValidUntil').value,
    notes: $('#quoteNotes').value.trim(),
    lines: state.quoteLines
      .map(line => ({ description: String(line.description || '').trim(), quantity: Number(line.quantity || 0), unitPrice: Number(line.unitPrice || 0) }))
      .filter(line => line.description || line.quantity || line.unitPrice),
    total: quoteTotal(),
    mailSubject: $('#quoteMailSubject').value.trim(),
    mailBody: $('#quoteMailBody').value.trim(),
  };
  if (requireComplete) {
    if (!data.clientName) throw new Error('Indique le nom du client.');
    if (!data.clientEmail) throw new Error('Indique l’adresse email du client.');
    if (!data.quoteNumber) throw new Error('Indique le numéro du devis.');
    if (!data.lines.some(line => line.description)) throw new Error('Ajoute au moins une ligne de description.');
    if (data.total <= 0) throw new Error('Le total du devis doit être supérieur à 0 €.');
  }
  return data;
}

function regenerateQuoteMail() {
  const site = state.data?.site || {};
  const clientName = $('#quoteClientName')?.value.trim() || 'Madame, Monsieur';
  const number = $('#quoteNumber')?.value.trim() || 'à compléter';
  const total = quoteTotal();
  const validity = $('#quoteValidUntil')?.value;
  $('#quoteMailSubject').value = `Votre devis ${site.companyName || 'AS Encombrants'} n° ${number}`;
  $('#quoteMailBody').value = `Bonjour ${clientName},\n\nVeuillez trouver en pièce jointe votre devis n° ${number}, d’un montant total de ${money(total)}.\n${validity ? `\nCe devis est valable jusqu’au ${formatFrenchDate(validity)}.\n` : ''}\nAprès votre accord, nous pourrons convenir ensemble de la date d’intervention.\n\nJe reste disponible si vous avez une question ou une modification à apporter.\n\nCordialement,\n${site.companyName || 'AS Encombrants'}\n${site.phoneDisplay || ''}\n${site.email || ''}`;
  state.quoteMailTouched = false;
}

async function loadQuoteLogoDataUrl() {
  if (state.quoteLogoDataUrl) return state.quoteLogoDataUrl;
  const response = await fetch('logo-as-encombrants.jpg');
  if (!response.ok) throw new Error('Logo du devis introuvable.');
  const blob = await response.blob();
  state.quoteLogoDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Lecture du logo impossible.'));
    reader.readAsDataURL(blob);
  });
  return state.quoteLogoDataUrl;
}

function pdfSafe(value) {
  return String(value ?? '').replace(/[’‘]/g, "'").replace(/[–—]/g, '-').replace(/\u00a0/g, ' ');
}

function safePdfFilename(number) {
  return `Devis-AS-Encombrants-${String(number || 'client').replace(/[^a-z0-9_-]+/gi, '-')}.pdf`;
}

async function buildQuotePdf(requireComplete = false) {
  const data = collectQuoteData(requireComplete);
  if (!window.jspdf?.jsPDF) throw new Error('Le créateur PDF ne s’est pas chargé. Recharge la page.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const site = state.data?.site || {};
  const companyName = pdfSafe(site.companyName || 'AS Encombrants');
  const companyAddress = pdfSafe(site.companyAddress || "3 Rue Jacques Brel, 38550 Saint Maurice l'Exil, France");
  const phone = pdfSafe(site.phoneDisplay || '07 84 73 05 25');
  const email = pdfSafe(site.email || 'as.encombrants@outlook.fr');
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 15;
  const right = pageWidth - 15;

  const drawFooter = () => {
    const y = pageHeight - 18;
    doc.setDrawColor(195);
    doc.setLineWidth(0.25);
    doc.line(left, y - 6, right, y - 6);
    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text(companyName, left, y);
    doc.setFont('times', 'normal');
    doc.text(`, ${companyAddress}`, left + doc.getTextWidth(companyName), y);
    doc.setFont('times', 'bold');
    doc.text('Mobile', 123, y);
    doc.setFont('times', 'normal');
    doc.text(` ${phone.replace(/\s/g, '')}`, 135, y);
    doc.setFont('times', 'bold');
    doc.text('E-mail', left, y + 5);
    doc.setFont('times', 'normal');
    doc.text(` ${email}`, left + 10, y + 5);
  };

  doc.setFont('times', 'normal');
  doc.setFontSize(22);
  doc.text('DEVIS', pageWidth / 2, 18, { align: 'center' });
  doc.setDrawColor(190);
  doc.setLineWidth(0.3);
  doc.line(left, 24, right, 24);

  try {
    const logo = await loadQuoteLogoDataUrl();
    doc.addImage(logo, 'JPEG', pageWidth / 2 - 22, 29, 44, 44);
  } catch (error) {
    console.warn(error);
    doc.setFillColor(179, 0, 19);
    doc.circle(pageWidth / 2, 51, 18, 'F');
    doc.setTextColor(255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text('AS', pageWidth / 2, 55, { align: 'center' });
    doc.setTextColor(0);
  }

  doc.setFont('times', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(95);
  doc.text(`${companyName}, ${companyAddress}`, pageWidth / 2, 82, { align: 'center' });
  doc.setTextColor(0);
  doc.line(left, 87, right, 87);

  doc.setFontSize(10);
  let y = 96;
  doc.text('À', left + 2, y);
  y += 6;
  doc.setFont('times', 'bold');
  doc.text(pdfSafe(data.clientName || ''), left + 2, y);
  doc.setFont('times', 'normal');
  const addressLines = [data.clientAddress, data.clientCity, data.clientCountry, data.clientEmail ? `E-mail : ${data.clientEmail}` : '', data.clientPhone ? `Tél. : ${data.clientPhone}` : ''].filter(Boolean).map(pdfSafe);
  addressLines.forEach(line => { y += 5; doc.text(String(line), left + 2, y); });

  const metaX = 132;
  const valueX = right - 2;
  let metaY = 102;
  const meta = [
    ['Devis N°:', data.quoteNumber],
    ["Date d'émission:", formatFrenchDate(data.issueDate)],
    ["Valable jusqu'au:", formatFrenchDate(data.validUntil)],
  ];
  meta.forEach(([label, value]) => {
    doc.setFont('times', 'normal');
    doc.text(label, metaX, metaY);
    doc.setFont('times', 'bold');
    doc.text(pdfSafe(value || ''), valueX, metaY, { align: 'right' });
    metaY += 5.5;
  });

  const tableStart = Math.max(133, y + 12);
  const rows = data.lines.length ? data.lines.map(line => [
    pdfSafe(line.description || ''),
    Number(line.quantity || 0).toLocaleString('fr-FR'),
    Number(line.unitPrice || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    quoteLineAmount(line).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ]) : [['', '', '', '']];

  doc.autoTable({
    startY: tableStart,
    margin: { left, right: 15, bottom: 31 },
    head: [['Description', 'Quantité', 'Prix (€)', 'Montant (€)']],
    body: rows,
    theme: 'plain',
    styles: { font: 'times', fontSize: 9.5, cellPadding: { top: 4, right: 1.5, bottom: 4, left: 1.5 }, lineColor: [190, 190, 190], lineWidth: { bottom: 0.2 } },
    headStyles: { fontStyle: 'bold', textColor: [0, 0, 0], lineColor: [0, 0, 0], lineWidth: { bottom: 0.6 } },
    columnStyles: {
      0: { cellWidth: 108 },
      1: { cellWidth: 22, halign: 'right' },
      2: { cellWidth: 28, halign: 'right' },
      3: { cellWidth: 30, halign: 'right' },
    },
    didDrawPage: drawFooter,
  });

  let finalY = doc.lastAutoTable.finalY + 7;
  if (finalY > pageHeight - 65) {
    doc.addPage();
    drawFooter();
    finalY = 25;
  }
  doc.setDrawColor(0);
  doc.setLineWidth(0.7);
  doc.line(left, finalY, right, finalY);
  doc.setFont('times', 'bold');
  doc.setFontSize(12);
  doc.text('Total (EUR):', left + 2, finalY + 7);
  doc.text(money(data.total), right - 2, finalY + 7, { align: 'right' });

  let noteY = finalY + 18;
  if (data.notes) {
    doc.setFont('times', 'bold');
    doc.setFontSize(9.5);
    doc.text('Conditions / informations :', left + 2, noteY);
    doc.setFont('times', 'normal');
    const noteLines = doc.splitTextToSize(pdfSafe(data.notes), 115);
    doc.text(noteLines, left + 2, noteY + 5);
    noteY += 5 + noteLines.length * 4.2;
  }
  doc.setFont('times', 'bold');
  doc.text('Signature / Cachet :', right - 2, Math.max(noteY, finalY + 17), { align: 'right' });

  if (doc.getNumberOfPages() === 1) drawFooter();
  return { doc, data, filename: safePdfFilename(data.quoteNumber) };
}

async function refreshQuotePreview() {
  const frame = $('#quotePdfPreview');
  if (!frame) return;
  try {
    setStatus($('#quoteSendStatus'), 'Création de l’aperçu…');
    const { doc } = await buildQuotePdf(false);
    const blob = doc.output('blob');
    if (state.quotePreviewUrl) URL.revokeObjectURL(state.quotePreviewUrl);
    state.quotePreviewUrl = URL.createObjectURL(blob);
    frame.src = state.quotePreviewUrl;
    setStatus($('#quoteSendStatus'), 'Aperçu actualisé.', 'success');
  } catch (error) {
    setStatus($('#quoteSendStatus'), `Aperçu impossible : ${error.message}`, 'error');
  }
}

async function downloadQuotePdf() {
  try {
    setStatus($('#quoteSendStatus'), 'Création du PDF…');
    const { doc, filename } = await buildQuotePdf(true);
    doc.save(filename);
    setStatus($('#quoteSendStatus'), 'PDF téléchargé.', 'success');
  } catch (error) {
    setStatus($('#quoteSendStatus'), error.message, 'error');
  }
}

async function saveQuoteEmailConfig() {
  const publicKey = $('#quoteEmailPublicKey').value.trim();
  const serviceId = $('#quoteEmailServiceId').value.trim();
  const templateId = $('#quoteEmailTemplateId').value.trim();
  if (!publicKey || !serviceId || !templateId) return setStatus($('#quoteSendStatus'), 'Remplis les trois réglages EmailJS.', 'error');
  state.data.quoteEmail = { publicKey, serviceId, templateId };
  markDirty();
  try {
    await saveRepositoryData('Réglage de l’envoi des devis clients');
    setStatus($('#quoteSendStatus'), 'Réglages EmailJS enregistrés.', 'success');
  } catch (error) {
    setStatus($('#quoteSendStatus'), `Enregistrement impossible : ${error.message}`, 'error');
  }
}

async function markQuoteRequestAsSent(total) {
  if (!state.quoteRequestId || !state.requestsConnected) return;
  try {
    const client = getRequestsClient();
    const changes = { status: 'quoted', quote_price: Number(total || 0), updated_at: new Date().toISOString() };
    const { error } = await client.from('quote_requests').update(changes).eq('id', state.quoteRequestId);
    if (error) throw error;
    const request = state.requests.find(item => item.id === state.quoteRequestId);
    if (request) Object.assign(request, changes);
    renderRequestsList();
    renderRequestDetail();
    renderDashboard();
  } catch (error) {
    console.warn('Devis envoyé mais statut Supabase non mis à jour :', error);
  }
}

async function sendQuoteToClient() {
  const button = $('#sendQuoteButton');
  try {
    const { doc, data, filename } = await buildQuotePdf(true);
    if (!data.clientEmail) throw new Error('Indique l’adresse email du client.');
    if (!data.mailSubject) throw new Error('Indique l’objet du mail.');
    if (!data.mailBody) throw new Error('Écris le message accompagnant le devis.');

    if (!state.requestsConnected) {
      throw new Error('Ouvre d’abord « Demandes clientes » et connecte-toi à Supabase.');
    }
    if (!confirm(`Envoyer le devis ${data.quoteNumber} à ${data.clientEmail} ?`)) return;

    if (button) button.disabled = true;
    setStatus($('#quoteSendStatus'), 'Création et envoi du PDF…');

    const client = getRequestsClient();
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    const session = sessionData?.session;
    if (!session?.access_token) {
      throw new Error('Ta connexion Supabase a expiré. Reconnecte-toi dans « Demandes clientes ».');
    }

    const pdfDataUri = doc.output('datauristring');
    const attachmentBase64 = String(pdfDataUri).split(',')[1] || '';
    if (!attachmentBase64) throw new Error('Le PDF n’a pas pu être préparé.');

    const { url, key } = getRequestsConfig();
    const response = await fetch(`${url}/functions/v1/send-quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: key,
      },
      body: JSON.stringify({
        to: data.clientEmail,
        subject: data.mailSubject,
        message: data.mailBody,
        filename,
        attachmentBase64,
        quoteNumber: data.quoteNumber,
        clientName: data.clientName,
        replyTo: state.data?.site?.email || '',
      }),
    });

    let result = null;
    const responseText = await response.text();
    if (responseText) {
      try { result = JSON.parse(responseText); } catch { result = { message: responseText }; }
    }
    if (!response.ok) {
      throw new Error(result?.error || result?.message || `Erreur d’envoi (${response.status})`);
    }

    await markQuoteRequestAsSent(data.total);
    setStatus(
      $('#quoteSendStatus'),
      `Devis envoyé avec succès à ${data.clientEmail}.`,
      'success'
    );
  } catch (error) {
    setStatus($('#quoteSendStatus'), `Envoi impossible : ${error.message || error}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function connect() {
  state.owner = $('#ownerInput').value.trim();
  state.repo = $('#repoInput').value.trim();
  state.branch = $('#branchInput').value.trim() || 'main';
  state.token = $('#tokenInput').value.trim();
  const loginStatus = $('#loginStatus');
  setStatus(loginStatus, 'Connexion et chargement du site…');
  try {
    localStorage.setItem('asAdminRepo', JSON.stringify({ owner: state.owner, repo: state.repo, branch: state.branch }));
    sessionStorage.setItem('asAdminToken', state.token);
    await loadRepositoryData();
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    setStatus(loginStatus, '');
    setGlobalStatus('Connexion réussie.', 'success');
  } catch (error) {
    setStatus(loginStatus, `Connexion impossible : ${error.message}`, 'error');
  }
}

function logout() {
  sessionStorage.removeItem('asAdminToken');
  state.token = '';
  state.data = null;
  state.requestsConnected = false;
  state.requests = [];
  state.selectedRequestId = '';
  $('#tokenInput').value = '';
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  setGlobalStatus('');
}

async function reloadFromGitHub() {
  if (state.dirty && !confirm('Abandonner les modifications non publiées et recharger GitHub ?')) return;
  setBusy(true, 'Rechargement depuis GitHub…');
  try {
    await loadRepositoryData();
    setGlobalStatus('Données rechargées depuis GitHub.', 'success');
  } catch (error) {
    setGlobalStatus(`Rechargement impossible : ${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function initialize() {
  try {
    const saved = JSON.parse(localStorage.getItem('asAdminRepo') || '{}');
    if (saved.owner) $('#ownerInput').value = saved.owner;
    if (saved.repo) $('#repoInput').value = saved.repo;
    if (saved.branch) $('#branchInput').value = saved.branch;
  } catch { /* rien */ }
  const sessionToken = sessionStorage.getItem('asAdminToken');
  if (sessionToken) $('#tokenInput').value = sessionToken;

  $('#loginForm').addEventListener('submit', event => { event.preventDefault(); connect(); });
  $('#logoutButton').addEventListener('click', logout);
  $('#publishButton').addEventListener('click', () => saveRepositoryData());
  $('#reloadButton').addEventListener('click', reloadFromGitHub);
  $('#saveRequestsConfigButton').addEventListener('click', saveRequestsConfig);
  $('#connectRequestsButton').addEventListener('click', connectRequests);
  $('#disconnectRequestsButton').addEventListener('click', disconnectRequests);
  $('#refreshRequestsButton').addEventListener('click', loadRequests);
  $('#requestsSearch').addEventListener('input', renderRequestsList);
  $('#requestsStatusFilter').addEventListener('change', renderRequestsList);
  $('#addCategoryButton').addEventListener('click', addCategory);
  $('#addObjectButton').addEventListener('click', () => openObjectEditor());
  $('#objectSearch').addEventListener('input', renderObjectList);
  $('#newQuoteButton').addEventListener('click', newBlankQuote);
  $('#addQuoteLineButton').addEventListener('click', addQuoteLine);
  $('#regenerateQuoteMailButton').addEventListener('click', regenerateQuoteMail);
  $('#previewQuoteButton').addEventListener('click', refreshQuotePreview);
  $('#downloadQuoteButton').addEventListener('click', downloadQuotePdf);
  $('#sendQuoteButton').addEventListener('click', sendQuoteToClient);
  $('#saveQuoteEmailConfigButton')?.addEventListener('click', saveQuoteEmailConfig);
  $('#quoteMailBody').addEventListener('input', () => { state.quoteMailTouched = true; });
  $('#quoteMailSubject').addEventListener('input', () => { state.quoteMailTouched = true; });
  ['quoteClientName','quoteClientEmail','quoteClientPhone','quoteClientAddress','quoteClientCity','quoteClientCountry','quoteNumber','quoteIssueDate','quoteValidUntil','quoteNotes'].forEach(id => {
    $('#' + id).addEventListener('input', () => { if (!state.quoteMailTouched) regenerateQuoteMail(); });
  });
  $$('#adminNav button').forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.tab)));
  window.addEventListener('beforeunload', event => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

initialize();
