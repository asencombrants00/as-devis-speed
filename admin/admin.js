'use strict';

const DATA_PATH = 'data/site-data.json';
const API_VERSION = '2022-11-28';
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;

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
  renderQuoteFields();
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
}

function setActiveTab(tab) {
  state.activeTab = tab;
  $$('#adminNav button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  const titles = {
    dashboard: 'Tableau de bord',
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
  const wasteTypes = ['Bois', 'Déchets verts', 'Mobilier', 'Literie', 'Tout-venant', 'Pneus', 'Électroménager', 'Ferraille / Métaux', 'Gravats', 'Mixte', 'Autre'];
  const categories = [...new Set(currentObjects().map(object => object.category))].sort();
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>${existing ? 'Modifier l’objet' : 'Ajouter un objet'}</h3><button class="close-button" type="button">×</button></div>
    <form id="objectForm" class="form-grid">
      <label>Nom de l’objet<input id="objectNameInput" value="${escapeHtml(item.name)}" required></label>
      <label>Identifiant<input id="objectIdInput" value="${escapeHtml(item.id)}" placeholder="créé automatiquement"></label>
      <label>Catégorie<input id="objectCategoryInput" list="objectCategoryList" value="${escapeHtml(item.category)}" required><datalist id="objectCategoryList">${categories.map(category => `<option value="${escapeHtml(category)}">`).join('')}</datalist></label>
      <label>Type de déchet<select id="objectWasteInput">${wasteTypes.map(type => `<option ${item.wasteType === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}</select></label>
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
    const updated = {
      id: newId,
      name: $('#objectNameInput', modal).value.trim(),
      category: $('#objectCategoryInput', modal).value.trim(),
      price: Number($('#objectPriceInput', modal).value || 0),
      weightKg: Number($('#objectWeightInput', modal).value || 0),
      wasteType: $('#objectWasteInput', modal).value,
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

function renderSiteForm() {
  const form = $('#siteForm');
  if (!form || !state.data) return;
  const site = state.data.site || (state.data.site = {});
  const fields = [
    ['companyName', 'Nom de l’entreprise', 'text'],
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
    generateQuoteOutput();
  }));
}

function renderQuoteFields() {
  const root = $('#quoteFields');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  root.innerHTML = `
    <label>Nom / Prénom<input id="quoteName"></label>
    <label>Téléphone<input id="quotePhone"></label>
    <label>Email client<input id="quoteEmail" type="email"></label>
    <label>Ville / Code postal<input id="quoteCity"></label>
    <label class="full">Adresse complète<input id="quoteAddress"></label>
    <label class="full">Objets inclus<textarea id="quoteObjects" rows="6"></textarea></label>
    <label class="full">Accès<textarea id="quoteAccess" rows="3"></textarea></label>
    <label>Prix validé (€)<input id="quotePrice" type="number" min="0" step="1"></label>
    <label>Validité (jours)<input id="quoteValidity" type="number" min="1" value="${Number(state.data?.site?.quoteValidityDays || 15)}"></label>
    <label class="full">Notes ou conditions particulières<textarea id="quoteNotes" rows="3"></textarea></label>
    <label class="checkbox-label full"><input id="quoteIncludeBooking" type="checkbox" ${state.data?.site?.bookingUrl ? 'checked' : ''}> Ajouter le lien de réservation au message</label>`;
  $$('input,textarea', root).forEach(input => input.addEventListener('input', generateQuoteOutput));
  $('#quoteIncludeBooking').addEventListener('change', generateQuoteOutput);
  generateQuoteOutput();
}

function captureBetween(text, labelPattern, nextPatterns) {
  const next = nextPatterns.map(pattern => `(?:${pattern})`).join('|');
  const regex = new RegExp(`${labelPattern}\\s*:\\s*([\\s\\S]*?)(?=\\s+(?:${next})\\s*:|$)`, 'i');
  return text.match(regex)?.[1]?.trim() || '';
}

function parseRawRequest() {
  const text = $('#rawRequest').value.replace(/\r/g, ' ').replace(/[\t ]+/g, ' ').trim();
  if (!text) return alert('Colle d’abord le mail reçu.');
  const nextLabels = ['Téléphone', 'Email', 'Ville \\/ Code postal', 'Adresse complète', '2\\. Type de demande', '3\\. Objets à enlever', '4\\. Accès et options'];
  const values = {
    name: captureBetween(text, 'Nom \\/ Prénom', nextLabels),
    phone: captureBetween(text, 'Téléphone', ['Email']),
    email: captureBetween(text, 'Email', ['Ville \\/ Code postal']),
    city: captureBetween(text, 'Ville \\/ Code postal', ['Adresse complète']),
    address: captureBetween(text, 'Adresse complète', ['2\\. Type de demande', 'OBJETS À ENLEVER']),
  };

  const objectMatch = text.match(/(?:3\.\s*Objets à enlever|2\.\s*OBJETS À ENLEVER|OBJETS À ENLEVER)[\s:]*([\s\S]*?)(?=(?:4\.\s*Accès|3\.\s*ACCÈS|ACCÈS ET INTERVENTION))/i);
  values.objects = objectMatch?.[1]?.trim().replace(/\s+-\s+/g, '\n- ') || '';
  values.price = text.match(/Estimation affichée au client\s*:\s*([0-9., ]+)\s*€/i)?.[1]?.trim()
    || text.match(/Prix (?:final )?(?:estimé|validé)?\s*:\s*([0-9., ]+)\s*€/i)?.[1]?.trim()
    || '';
  const floor = text.match(/Étage\s*:\s*([^\n]+?)(?=\s+Ascenseur\s*:|$)/i)?.[1]?.trim() || '';
  const elevator = text.match(/Ascenseur\s*:\s*([^\n]+?)(?=\s+Stationnement|$)/i)?.[1]?.trim() || '';
  const parking = text.match(/Stationnement facile\s*:\s*([^\n]+?)(?=\s+Intervention|$)/i)?.[1]?.trim() || '';
  values.access = [floor && `Étage : ${floor}`, elevator && `Ascenseur : ${elevator}`, parking && `Stationnement : ${parking}`].filter(Boolean).join('\n');
  values.notes = text.match(/Informations complémentaires\s*:\s*([\s\S]*?)(?=\s+Estimation affichée|\s+━━━━━━━━|$)/i)?.[1]?.trim() || '';

  $('#quoteName').value = values.name;
  $('#quotePhone').value = values.phone;
  $('#quoteEmail').value = values.email;
  $('#quoteCity').value = values.city;
  $('#quoteAddress').value = values.address;
  $('#quoteObjects').value = values.objects;
  $('#quoteAccess').value = values.access;
  $('#quotePrice').value = values.price.replace(',', '.').replace(/\s/g, '');
  $('#quoteNotes').value = values.notes;
  generateQuoteOutput();
}

function generateQuoteOutput() {
  if (!$('#quoteOutput')) return;
  const site = state.data?.site || {};
  const name = $('#quoteName')?.value.trim() || 'Madame, Monsieur';
  const price = Number($('#quotePrice')?.value || 0);
  const objects = $('#quoteObjects')?.value.trim() || 'Objets indiqués dans votre demande.';
  const address = [$('#quoteAddress')?.value.trim(), $('#quoteCity')?.value.trim()].filter(Boolean).join(', ') || 'Adresse indiquée dans votre demande';
  const access = $('#quoteAccess')?.value.trim();
  const notes = $('#quoteNotes')?.value.trim();
  const validity = Number($('#quoteValidity')?.value || site.quoteValidityDays || 15);
  const includeBooking = $('#quoteIncludeBooking')?.checked && site.bookingUrl;
  const priceText = price > 0 ? `${price.toLocaleString('fr-FR')} € TTC` : 'À compléter avant envoi';

  const message = `Bonjour ${name},

Après vérification de votre demande, voici votre devis AS Encombrants.

MONTANT DU DEVIS : ${priceText}

Objets inclus :
${objects}

Adresse d’intervention :
${address}${access ? `\n\nAccès prévu :\n${access}` : ''}${notes ? `\n\nConditions particulières :\n${notes}` : ''}

Ce prix est valable sous réserve que les objets, les quantités et les conditions d’accès correspondent aux informations et photos transmises.

Pour accepter le devis, répondez simplement à ce mail avec la mention « Bon pour accord ».${includeBooking ? `\n\nAprès votre accord, choisissez votre créneau disponible ici :\n${site.bookingUrl}` : ''}

Ce devis est valable ${validity} jours.

Cordialement,
${site.companyName || 'AS Encombrants'}
${site.phoneDisplay || ''}
${site.email || ''}`;
  $('#quoteOutput').value = message;
}

async function copyQuote() {
  await navigator.clipboard.writeText($('#quoteOutput').value);
  setGlobalStatus('Message client copié.', 'success');
}

function openQuoteMail() {
  const email = $('#quoteEmail').value.trim();
  if (!email) return alert('Renseigne l’adresse email du client.');
  const subject = 'Votre devis AS Encombrants';
  const body = $('#quoteOutput').value;
  window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
  $('#addCategoryButton').addEventListener('click', addCategory);
  $('#addObjectButton').addEventListener('click', () => openObjectEditor());
  $('#objectSearch').addEventListener('input', renderObjectList);
  $('#parseRequestButton').addEventListener('click', parseRawRequest);
  $('#copyQuoteButton').addEventListener('click', copyQuote);
  $('#openMailButton').addEventListener('click', openQuoteMail);
  $$('#adminNav button').forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.tab)));
  window.addEventListener('beforeunload', event => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

initialize();
