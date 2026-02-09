const TICKETMASTER_API_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const TICKETMASTER_API_KEY = 'yMmAApLiWUsGAdwYLY5OyV33NUykHAtb';
const API_BASE = (() => {
    if (window.API_BASE) return window.API_BASE;
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3002';
    }
    return 'https://event-storage-backend.onrender.com';
})();

let guestStats = { xp: 0, level: 1, points: 0 };
let guestNotifications = [];
let guestChats = {};
let accountCheckTimer = null;
const chatCache = new Map();
let chatRefreshTimer = null;

function getCurrentPage() {
    return document.body?.dataset?.page || 'home';
}

function navigateTo(path) {
    window.location.href = path;
}

function setHidden(id, hidden) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', hidden);
}

function showAccountDeletedNotice() {
    alert('Din profil er slettet. Du bliver logget ud.');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
}

function updateUserUI(user) {
    if (!user) return;
    const { name, email, isGuest } = user;
    const initials = (name || '')
        .split(' ')
        .map(part => part[0])
        .join('')
        .toUpperCase()
        .substring(0, 2);

    setText('avatarInitials', initials || '👤');
    setText('avatarName', name || 'Bruger');
    setText('displayUserName', name || 'Bruger');
    setText('displayUserEmail', email || '');

    const statusLabel = document.getElementById('avatarStatus');
    if (statusLabel) {
        statusLabel.textContent = isGuest ? 'Ikke logget ind' : 'Logget ind';
    }

    const friendsBtn = document.getElementById('footerFriendsBtn');
    if (friendsBtn) {
        friendsBtn.classList.toggle('hidden', isGuest);
    }

    const headerStats = document.querySelector('.header-stats');
    if (headerStats) {
        headerStats.classList.toggle('hidden', isGuest);
    }

    renderHeaderAvatar(initials || '👤');
}

function startAccountDeletionWatcher(user) {
    if (!user || user.isGuest || !user.email) return;
    stopAccountDeletionWatcher();
    accountCheckTimer = setInterval(async () => {
        try {
            await apiRequestWithStatus(`/api/users/${encodeURIComponent(user.email)}`);
        } catch (err) {
            if (err.status === 404) {
                try {
                    await apiRequest('/api/users/login', {
                        method: 'POST',
                        body: JSON.stringify({ name: user.name, email: user.email })
                    });
                    return;
                } catch (restoreErr) {
                    stopAccountDeletionWatcher();
                    showAccountDeletedNotice();
                    handleLogout();
                }
            }
        }
    }, 20000);
}

function stopAccountDeletionWatcher() {
    if (accountCheckTimer) {
        clearInterval(accountCheckTimer);
        accountCheckTimer = null;
    }
}

function prepareSettingsPage(user) {
    const nameInput = document.getElementById('settingsName');
    const emailInput = document.getElementById('settingsEmail');
    const deleteBtn = document.getElementById('deleteAccountBtn');
    if (!nameInput || !emailInput) return;

    nameInput.removeAttribute('readonly');
    nameInput.removeAttribute('disabled');
    emailInput.removeAttribute('readonly');
    emailInput.removeAttribute('disabled');

    if (user) {
        nameInput.value = user.name || '';
        emailInput.value = user.email || '';

        if (user.isGuest) {
            nameInput.setAttribute('readonly', 'true');
            nameInput.setAttribute('disabled', 'true');
            emailInput.setAttribute('readonly', 'true');
            emailInput.setAttribute('disabled', 'true');
            deleteBtn?.classList.add('hidden');
        } else {
            deleteBtn?.classList.remove('hidden');
        }
    }

    nameInput.focus();
    nameInput.select?.();
}

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });

    if (!response.ok) {
        throw new Error('API request failed');
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

async function apiRequestWithStatus(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });

    let payload = null;
    if (response.status !== 204) {
        try {
            payload = await response.json();
        } catch (err) {
            payload = null;
        }
    }

    if (!response.ok) {
        const error = new Error('API request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

async function apiRequestWithCredentials(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        credentials: 'include',
        ...options
    });

    if (!response.ok) {
        throw new Error('API request failed');
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

function getAdminAuth() {
    const raw = sessionStorage.getItem('adminAuth');
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (err) {
        return null;
    }
}

function setAdminAuth(auth) {
    if (!auth) {
        sessionStorage.removeItem('adminAuth');
        return;
    }
    sessionStorage.setItem('adminAuth', JSON.stringify(auth));
}

async function adminRequest(path, options = {}) {
    const auth = getAdminAuth();
    if (!auth) {
        throw new Error('admin auth missing');
    }
    return apiRequestWithStatus(path, {
        ...options,
        headers: {
            ...(options.headers || {}),
            'X-Admin-Email': auth.email,
            'X-Admin-Password': auth.password
        }
    });
}

function buildTicketmasterUrl(params) {
    const query = new URLSearchParams({
        apikey: TICKETMASTER_API_KEY,
        ...params
    });
    return `${TICKETMASTER_API_URL}?${query.toString()}`;
}

let storedInterested = [];
let storedAttending = [];
let storedInterestedSet = new Set();
let storedAttendingSet = new Set();

function getEventKey(event) {
    return event.eventId || event.id || `${event.name || ''}__${event.rawDate || ''}__${event.city || ''}`;
}

function getEventId(event) {
    return event.eventId || event.id || getEventKey(event);
}

function normalizeEventForStorage(event) {
    return {
        eventId: getEventId(event),
        name: event.name || 'Begivenhed',
        city: event.city || '',
        date: event.date || '',
        rawDate: event.rawDate || '',
        url: event.url || '',
        price: typeof event.price === 'number' ? event.price : null,
        currency: event.currency || 'DKK'
    };
}

async function refreshStoredEvents() {
    const current = getCurrentUser();
    if (!current || current.isGuest) {
        storedInterested = [];
        storedAttending = [];
        storedInterestedSet = new Set();
        storedAttendingSet = new Set();
        renderInterestedFolder();
        return;
    }

    const email = encodeURIComponent(current.email);
    const [interested, attending] = await Promise.all([
        apiRequest(`/api/events/${email}?type=interested`),
        apiRequest(`/api/events/${email}?type=attending`)
    ]);

    storedInterested = interested || [];
    storedAttending = attending || [];
    storedInterestedSet = new Set(storedInterested.map(item => item.eventId));
    storedAttendingSet = new Set(storedAttending.map(item => item.eventId));
    renderInterestedFolder();
}

function isEventStored(type, event) {
    const eventId = getEventId(event);
    return type === 'interested'
        ? storedInterestedSet.has(eventId)
        : storedAttendingSet.has(eventId);
}

async function toggleEventStored(type, event) {
    const current = getCurrentUser();
    if (!current || current.isGuest) return;

    const email = encodeURIComponent(current.email);
    const eventId = getEventId(event);
    const exists = isEventStored(type, event);

    if (exists) {
        await apiRequest(`/api/events/${email}?type=${encodeURIComponent(type)}&eventId=${encodeURIComponent(eventId)}`, {
            method: 'DELETE'
        });

        if (type === 'interested') {
            storedInterested = storedInterested.filter(item => item.eventId !== eventId);
            storedInterestedSet.delete(eventId);
        } else {
            storedAttending = storedAttending.filter(item => item.eventId !== eventId);
            storedAttendingSet.delete(eventId);
        }
    } else {
        const payload = normalizeEventForStorage(event);
        await apiRequest(`/api/events/${email}`, {
            method: 'POST',
            body: JSON.stringify({ type, event: payload })
        });

        if (type === 'interested') {
            storedInterested = [...storedInterested, payload];
            storedInterestedSet.add(eventId);
        } else {
            storedAttending = [...storedAttending, payload];
            storedAttendingSet.add(eventId);
        }
    }

    renderInterestedFolder();
}

function toggleInterestedFolder() {
    const panel = document.getElementById('interestedFolder');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        renderInterestedFolder();
    }
}

function renderInterestedFolder() {
    const list = document.getElementById('interestedFolderList');
    if (!list) return;
    list.innerHTML = '';
    const events = storedInterested;
    if (events.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = 'Ingen interesserede begivenheder endnu.';
        list.appendChild(empty);
        return;
    }

    events.forEach(event => {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'event-row';

        const main = document.createElement('div');
        main.className = 'event-main';

        const link = document.createElement('a');
        link.href = event.url || '#';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = event.name || 'Begivenhed';

        const meta = document.createElement('span');
        const priceText = event.price ? ` · ${formatPrice(event.price, event.currency)}` : '';
        meta.textContent = `${event.city || 'Danmark'} · ${event.date || 'Dato TBA'}${priceText}`;

        main.appendChild(link);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'event-actions';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'event-action-btn event-action-interested active';
        removeBtn.textContent = 'Fjern interesse';
        removeBtn.addEventListener('click', () => {
            toggleEventStored('interested', event);
        });

        actions.appendChild(removeBtn);
        row.appendChild(main);
        row.appendChild(actions);
        li.appendChild(row);
        list.appendChild(li);
    });
}

function getUserKey() {
    const current = getCurrentUser();
    if (!current) return 'guest';
    return current.email || 'guest';
}

function isGuestUser() {
    const current = getCurrentUser();
    return !current || current.isGuest;
}

function getUserStatsKey() {
    if (isGuestUser()) return null;
    return `userStats:${getUserKey()}`;
}

function getNotificationsKey() {
    if (isGuestUser()) return null;
    return `notifications:${getUserKey()}`;
}

function getChatKey(contactId) {
    if (isGuestUser()) return null;
    return `chat:${getUserKey()}:${contactId}`;
}

function getUserStats() {
    if (isGuestUser()) {
        return { ...guestStats };
    }
    const raw = localStorage.getItem(getUserStatsKey());
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            // ignore parse issues
        }
    }
    return { xp: 0, level: 1, points: 0 };
}

function saveUserStats(stats) {
    if (isGuestUser()) {
        guestStats = { ...stats };
        updateStatsUI(guestStats);
        return;
    }
    localStorage.setItem(getUserStatsKey(), JSON.stringify(stats));
    updateStatsUI(stats);
}

function xpToNextLevel(level) {
    return 100 + (level - 1) * 25;
}

function applyXp(stats, gainedXp) {
    let xp = stats.xp + gainedXp;
    let level = stats.level;
    let needed = xpToNextLevel(level);
    while (xp >= needed) {
        xp -= needed;
        level += 1;
        needed = xpToNextLevel(level);
    }
    return { ...stats, xp, level };
}

function calculatePurchaseBonus(level) {
    const base = 10 + level;
    let percent = 0.5;
    if (level >= 16 && level <= 30) {
        percent = 0.25;
    } else if (level >= 31) {
        percent = 0.01;
    }
    const bonus = Math.round(base * percent);
    return { base, bonus, percent };
}

function awardPurchaseRewards(amountDkk, event) {
    if (isGuestUser()) {
        addNotification('Gæster kan ikke optjene point eller xp.');
        return;
    }
    if (!amountDkk || amountDkk <= 0) {
        addNotification('Køb registreret, men pris mangler – ingen point/xp tilføjet.');
        return;
    }

    const stats = getUserStats();
    const roundedAmount = Math.round(amountDkk);
    const bonus = calculatePurchaseBonus(stats.level);
    const totalXp = roundedAmount + bonus.base + bonus.bonus;

    let updated = { ...stats, points: stats.points + roundedAmount };
    updated = applyXp(updated, totalXp);
    saveUserStats(updated);

    const eventName = event?.name ? ` for ${event.name}` : '';
    addNotification(`Køb gennemført${eventName}. +${roundedAmount} point og +${totalXp} xp.`);
}

function updateStatsUI(stats = getUserStats()) {
    const headerPoints = document.getElementById('headerPoints');
    const headerLevel = document.getElementById('headerLevel');
    const shopPoints = document.getElementById('shopPoints');
    if (headerPoints) headerPoints.textContent = stats.points;
    if (shopPoints) shopPoints.textContent = stats.points;
    if (headerLevel) headerLevel.textContent = stats.level;
}

function addNotification(text) {
    if (isGuestUser()) {
        guestNotifications.unshift({ text, stamp: new Date().toLocaleString('da-DK', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) });
        guestNotifications = guestNotifications.slice(0, 50);
        renderNotifications();
        return;
    }
    const list = getNotifications();
    const stamp = new Date().toLocaleString('da-DK', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
    list.unshift({ text, stamp });
    localStorage.setItem(getNotificationsKey(), JSON.stringify(list.slice(0, 50)));
    renderNotifications();
}

function getNotifications() {
    if (isGuestUser()) return [...guestNotifications];
    const raw = localStorage.getItem(getNotificationsKey());
    if (!raw) return [];
    try {
        return JSON.parse(raw) || [];
    } catch (e) {
        return [];
    }
}

function renderNotifications() {
    const list = document.getElementById('notificationsList');
    if (!list) return;
    list.innerHTML = '';
    const items = getNotifications();
    if (items.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'Ingen notifikationer endnu.';
        list.appendChild(li);
        return;
    }
    items.forEach(item => {
        const li = document.createElement('li');
        li.textContent = `${item.text} (${item.stamp})`;
        list.appendChild(li);
    });
}

const pointShopItems = [
    { id: 'skin_fire', name: '🔥 Flamme Outfit', description: 'Unikt outfit til din avatar.', price: 350 },
    { id: 'pet_dragon', name: '🐉 Mini Drage', description: 'Følgesvend til din profil.', price: 520 },
    { id: 'badge_gold', name: '🥇 Guld Badge', description: 'Vis dit niveau frem.', price: 180 },
    { id: 'theme_neon', name: '🌈 Neon Tema', description: 'Skift farvetema.', price: 260 }
];

const dkkShopItems = [
    { id: 'vip_pass', name: '🎫 VIP Pass', description: 'Adgang til eksklusive events.', price: 129 },
    { id: 'pro_avatar', name: '✨ Pro Avatar Pack', description: 'Ekstra tilpasninger.', price: 79 },
    { id: 'supporter', name: '❤️ Supporter Pack', description: 'Støt projektet.', price: 49 }
];

function renderShopItems(items, container, mode) {
    if (!container) return;
    container.innerHTML = '';
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'shop-item';

        const title = document.createElement('h4');
        title.textContent = item.name;

        const desc = document.createElement('p');
        desc.textContent = item.description;

        const price = document.createElement('p');
        price.textContent = mode === 'points'
            ? `${item.price} point`
            : `${item.price} DKK`;

        const btn = document.createElement('button');
        btn.textContent = mode === 'points' ? 'Køb for point' : 'Køb for DKK';
        btn.addEventListener('click', () => handleShopPurchase(item, mode));

        card.appendChild(title);
        card.appendChild(desc);
        card.appendChild(price);
        card.appendChild(btn);
        container.appendChild(card);
    });
}

function initPointShop() {
    renderShopItems(pointShopItems, document.getElementById('shopPointsGrid'), 'points');
    renderShopItems(dkkShopItems, document.getElementById('shopDkkGrid'), 'dkk');
}

function handleShopPurchase(item, mode) {
    if (isGuestUser()) {
        addNotification('Gæsteprofil kan ikke gemme køb eller point.');
        return;
    }
    const current = getCurrentUser();
    const stats = getUserStats();
    if (mode === 'points') {
        if (stats.points < item.price) {
            addNotification('Du har ikke nok point til dette køb.');
            return;
        }
        saveUserStats({ ...stats, points: stats.points - item.price });
        if (current?.email) {
            apiRequest(`/api/items/${encodeURIComponent(current.email)}`, {
                method: 'POST',
                body: JSON.stringify({ itemName: item.name, source: 'shop-points' })
            }).catch(() => null);
        }
        addNotification(`Købte ${item.name} for ${item.price} point.`);
        return;
    }
    if (current?.email) {
        apiRequest(`/api/items/${encodeURIComponent(current.email)}`, {
            method: 'POST',
            body: JSON.stringify({ itemName: item.name, source: 'shop-dkk' })
        }).catch(() => null);
    }
    addNotification('DKK-køb afventer betaling. Point gives først når transaktionen er gennemført.');
}

function switchShopTab(tab) {
    const pointsGrid = document.getElementById('shopPointsGrid');
    const dkkGrid = document.getElementById('shopDkkGrid');
    const tabs = document.querySelectorAll('.shop-tab');
    tabs.forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`.shop-tab[data-shop-tab="${tab}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    if (tab === 'dkk') {
        pointsGrid?.classList.add('hidden');
        dkkGrid?.classList.remove('hidden');
    } else {
        pointsGrid?.classList.remove('hidden');
        dkkGrid?.classList.add('hidden');
    }
}

let currentChatContact = null;

function createChatContactItem(contact) {
    const item = document.createElement('div');
    item.className = 'chat-contact';
    item.dataset.contactId = contact.id;

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = contact.initials || '🤖';
    loadUserAvatarPreview(contact.email, avatar, contact.initials || '🤖');

    const meta = document.createElement('div');
    meta.className = 'friend-meta';

    const name = document.createElement('div');
    name.className = 'friend-name';
    name.textContent = contact.name;

    const sub = document.createElement('div');
    sub.className = 'friend-subtext';
    sub.textContent = contact.subtitle;

    meta.appendChild(name);
    meta.appendChild(sub);

    item.appendChild(avatar);
    item.appendChild(meta);
    item.addEventListener('click', () => selectChatContact(contact.id));
    return item;
}

function renderChatMessages(contactId) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    if (!contactId) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Vælg en kontakt for at skrive.';
        container.appendChild(empty);
        return;
    }
    let messages = [];
    if (contactId === 'assistant' || isGuestUser()) {
        messages = guestChats[contactId] || [];
    } else {
        messages = chatCache.get(contactId) || [];
    }
    messages.forEach(msg => {
        const bubble = document.createElement('div');
        bubble.className = `chat-message ${msg.from === 'me' ? 'self' : 'other'}`;
        bubble.textContent = msg.text;
        container.appendChild(bubble);
    });
    container.scrollTop = container.scrollHeight;
}

function saveChatMessage(contactId, message) {
    if (contactId === 'assistant' || isGuestUser()) {
        const messages = guestChats[contactId] || [];
        messages.push(message);
        guestChats[contactId] = messages.slice(-100);
        renderChatMessages(contactId);
        return;
    }
    const messages = chatCache.get(contactId) || [];
    messages.push(message);
    chatCache.set(contactId, messages.slice(-200));
    renderChatMessages(contactId);
}

function selectChatContact(contactId) {
    currentChatContact = contactId;
    const contacts = document.querySelectorAll('.chat-contact');
    contacts.forEach(el => el.classList.remove('active'));
    const active = document.querySelector(`.chat-contact[data-contact-id="${contactId}"]`);
    if (active) active.classList.add('active');
    if (contactId && contactId !== 'assistant' && !isGuestUser()) {
        loadChatThread(contactId);
    } else {
        renderChatMessages(contactId);
    }
}

function startChatAutoRefresh() {
    stopChatAutoRefresh();
    chatRefreshTimer = setInterval(() => {
        if (!currentChatContact) return;
        if (currentChatContact === 'assistant') return;
        if (isGuestUser()) return;
        loadChatThread(currentChatContact);
    }, 1000);
}

function stopChatAutoRefresh() {
    if (chatRefreshTimer) {
        clearInterval(chatRefreshTimer);
        chatRefreshTimer = null;
    }
}

async function loadChatThread(contactId) {
    const current = getCurrentUser();
    if (!current || !current.email) return;
    try {
        const rows = await apiRequest(`/api/chats/${encodeURIComponent(current.email)}?with=${encodeURIComponent(contactId)}`);
        chatCache.set(contactId, (rows || []).map(row => ({
            from: row.fromEmail === current.email ? 'me' : 'other',
            text: row.message,
            at: Date.parse(row.createdAt) || Date.now()
        })));
        renderChatMessages(contactId);
    } catch (err) {
        renderChatMessages(contactId);
    }
}

async function loadChatContacts() {
    const container = document.getElementById('chatContacts');
    if (!container) return;
    container.innerHTML = '';

    const assistantContact = {
        id: 'assistant',
        name: 'Begivenheds vejleder',
        subtitle: 'AI assistent',
        initials: 'AI',
        email: null
    };
    const current = getCurrentUser();

    const title = document.createElement('div');
    title.className = 'chat-section-title';
    title.textContent = 'Kontakter';
    container.appendChild(title);

    const aiLabel = document.createElement('div');
    aiLabel.className = 'chat-section-title';
    aiLabel.textContent = 'AI assistent';
    container.appendChild(aiLabel);
    container.appendChild(createChatContactItem(assistantContact));

    const friendsLabel = document.createElement('div');
    friendsLabel.className = 'chat-section-title';
    friendsLabel.textContent = 'Venner';
    container.appendChild(friendsLabel);

    const contacts = [assistantContact];
    if (current && !current.isGuest) {
        const friends = await getFriends(current.email);
        const allUsers = await getAllUserProfiles();
        friends.forEach(email => {
            const user = allUsers.find(u => u.email === email) || { name: email, email };
            const initials = (user.name || email)
                .split(' ')
                .map(part => part[0])
                .join('')
                .substring(0, 2)
                .toUpperCase();
            const contact = { id: email, name: user.name || email, subtitle: user.email || email, initials, email };
            contacts.push(contact);
            container.appendChild(createChatContactItem(contact));
        });
    }

    if (!currentChatContact && contacts.length > 0) {
        selectChatContact(contacts[0].id);
    }

    startChatAutoRefresh();
}

function getAssistantReply(text) {
    const lower = text.toLowerCase();
    if (lower.includes('event') || lower.includes('begiven')) {
        return 'Jeg kan hjælpe dig med at finde de bedste begivenheder. Prøv at gå til event-listen.';
    }
    if (lower.includes('point') || lower.includes('xp')) {
        return 'Du tjener point og xp ved køb eller når du trykker deltager på en begivenhed.';
    }
    if (lower.includes('ven')) {
        return 'Du kan tilføje venner via venne-siden og chatte her.';
    }
    return 'Jeg hjælper gerne. Spørg mig om events, point eller funktioner.';
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !currentChatContact) return;
    input.value = '';

    saveChatMessage(currentChatContact, { from: 'me', text, at: Date.now() });

    if (currentChatContact === 'assistant') {
        const reply = getAssistantReply(text);
        setTimeout(() => {
            saveChatMessage(currentChatContact, { from: 'assistant', text: reply, at: Date.now() });
        }, 600);
        return;
    }

    if (!isGuestUser()) {
        const current = getCurrentUser();
        if (current?.email) {
            apiRequest(`/api/chats/${encodeURIComponent(current.email)}`, {
                method: 'POST',
                body: JSON.stringify({ to: currentChatContact, message: text })
            }).then(() => loadChatThread(currentChatContact)).catch(() => null);
        }
    }
}

function formatPrice(price, currency = 'DKK') {
    if (price == null) return '';
    return new Intl.NumberFormat('da-DK', { style: 'currency', currency }).format(price);
}

// Avatar 3D variables
let avatarScene, avatarCamera, avatarRenderer;
let avatarScenePreview, avatarCameraPreview, avatarRendererPreview;
let avatarGroup, headMesh, bodyMesh, armMeshes = [], legMeshes = [], hairMesh, eyeMeshes = [];
let avatarGroupPreview, previewGroup;
let mouseX = 0, mouseY = 0;
let pendingMitidCpr = null;
let currentAvatarState = {
    bodyType: 'normal',
    headShape: 'box',
    headColor: '#FDBCB4',
    hairColor: '#8B4513',
    bodyColor: '#4169E1',
    pantsColor: '#333333',
    shoesColor: '#000000',
    expression: 'happy'
};
let avaturnAvatarData = null;
let avaturnSdkLoaded = false;
let avaturnInitInProgress = false;
const userAvatarPreviewCache = new Map();
let avaturnPreviewRenderer = null;
let avaturnPreviewScene = null;
let avaturnPreviewCamera = null;
let avaturnPreviewModel = null;
let avaturnPreviewModelUrl = null;
let avaturnPreviewAnimating = false;
let gltfLoaderPromise = null;
const AVATURN_SDK_SOURCES = [
    { type: 'module', url: 'https://cdn.jsdelivr.net/npm/@avaturn/sdk/dist/index.js' },
    { type: 'module', url: 'https://unpkg.com/@avaturn/sdk/dist/index.js' },
    { type: 'script', url: 'https://cdn.jsdelivr.net/npm/@avaturn/sdk/dist/avaturn-sdk.umd.js' },
    { type: 'script', url: 'https://unpkg.com/@avaturn/sdk/dist/avaturn-sdk.umd.js' }
];

function resizeAvatarCanvas() {
    const canvas = document.getElementById('avatarCanvas');
    if (canvas && avatarRenderer && avatarCamera) {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        avatarRenderer.setSize(width, height, false);
        avatarCamera.aspect = width / height;
        avatarCamera.updateProjectionMatrix();
    }

    const previewCanvas = document.getElementById('avatarCanvasPreview');
    if (previewCanvas && avatarRendererPreview && avatarCameraPreview) {
        const rect = previewCanvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        avatarRendererPreview.setSize(width, height, false);
        avatarCameraPreview.aspect = width / height;
        avatarCameraPreview.updateProjectionMatrix();
    }
}

function initAvatarScene() {
    const canvas = document.getElementById('avatarCanvas');
    if (!canvas) return;

    // Scene setup
    avatarScene = new THREE.Scene();
    avatarScene.background = new THREE.Color(0x667eea);

    // Camera
    avatarCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    avatarCamera.position.z = 3.5;

    // Renderer
    avatarRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    avatarRenderer.setPixelRatio(window.devicePixelRatio);
    resizeAvatarCanvas();

    // Lighting
    const light1 = new THREE.DirectionalLight(0xffffff, 1);
    light1.position.set(5, 5, 5);
    avatarScene.add(light1);
    
    const light2 = new THREE.DirectionalLight(0xffffff, 0.5);
    light2.position.set(-5, -5, 5);
    avatarScene.add(light2);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    avatarScene.add(ambientLight);

    // Avatar group
    avatarGroup = new THREE.Group();
    avatarScene.add(avatarGroup);

    // Create avatar parts
    createAvatarParts();

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        avatarGroup.rotation.y += 0.005;
        avatarGroup.rotation.x = mouseY * 0.2;
        avatarRenderer.render(avatarScene, avatarCamera);
    }
    animate();

    // Mouse movement
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouseY = ((e.clientY - rect.top) / rect.height - 0.5) * 0.8;
    });

    // Wheel zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoom = e.deltaY > 0 ? 0.1 : -0.1;
        avatarCamera.position.z = Math.max(2, Math.min(6, avatarCamera.position.z + zoom));
    });
}

function initAvatarPreview() {
    const canvas = document.getElementById('avatarCanvasPreview');
    if (!canvas) return;

    // Scene setup
    avatarScenePreview = new THREE.Scene();
    avatarScenePreview.background = new THREE.Color(0x667eea);

    // Camera
    avatarCameraPreview = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    avatarCameraPreview.position.z = 3.5;

    // Renderer
    avatarRendererPreview = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    avatarRendererPreview.setPixelRatio(window.devicePixelRatio);
    resizeAvatarCanvas();

    // Lighting
    const light1 = new THREE.DirectionalLight(0xffffff, 1);
    light1.position.set(5, 5, 5);
    avatarScenePreview.add(light1);
    
    const light2 = new THREE.DirectionalLight(0xffffff, 0.5);
    light2.position.set(-5, -5, 5);
    avatarScenePreview.add(light2);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    avatarScenePreview.add(ambientLight);

    // Avatar group
    avatarGroupPreview = new THREE.Group();
    avatarScenePreview.add(avatarGroupPreview);

    // Create avatar parts for preview
    createAvatarPartsPreview();

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        avatarGroupPreview.rotation.y += 0.005;
        avatarRendererPreview.render(avatarScenePreview, avatarCameraPreview);
    }
    animate();
}

function createAvatarParts() {
    avatarGroup.children = [];
    eyeMeshes = [];
    armMeshes = [];
    legMeshes = [];

    const bodyType = document.getElementById('bodyType').value || 'normal';
    const headShape = document.getElementById('headShape').value || 'box';
    
    // Create head based on shape
    let headGeometry;
    if (headShape === 'sphere') {
        headGeometry = new THREE.SphereGeometry(0.35, 32, 32);
    } else if (headShape === 'oval') {
        headGeometry = new THREE.SphereGeometry(0.35, 32, 32);
        headGeometry.scale(1, 1.2, 1);
    } else {
        headGeometry = new THREE.BoxGeometry(0.6, 0.8, 0.6);
    }

    const headMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.headColor });
    headMesh = new THREE.Mesh(headGeometry, headMaterial);
    headMesh.position.y = 0.8;
    avatarGroup.add(headMesh);

    // Hair
    const hairGeometry = new THREE.BoxGeometry(0.7, 0.35, 0.65);
    const hairMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.hairColor });
    hairMesh = new THREE.Mesh(hairGeometry, hairMaterial);
    hairMesh.position.y = 1.25;
    hairMesh.position.z = -0.05;
    avatarGroup.add(hairMesh);

    // Eyes
    const eyeGeometry = new THREE.SphereGeometry(0.08, 16, 16);
    const eyeMaterial = new THREE.MeshPhongMaterial({ color: 0x000000 });
    
    const eye1 = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye1.position.set(-0.15, 0.95, 0.35);
    avatarGroup.add(eye1);
    eyeMeshes.push(eye1);

    const eye2 = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye2.position.set(0.15, 0.95, 0.35);
    avatarGroup.add(eye2);
    eyeMeshes.push(eye2);

    // Expression details (eyebrows)
    const browGeometry = new THREE.BoxGeometry(0.12, 0.05, 0.02);
    const browMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.hairColor });
    
    const brow1 = new THREE.Mesh(browGeometry, browMaterial);
    brow1.position.set(-0.15, 1.1, 0.35);
    avatarGroup.add(brow1);

    const brow2 = new THREE.Mesh(browGeometry, browMaterial);
    brow2.position.set(0.15, 1.1, 0.35);
    avatarGroup.add(brow2);

    // Body sizing based on type
    let bodyGeometry, bodyY;
    switch(currentAvatarState.bodyType) {
        case 'slim':
            bodyGeometry = new THREE.BoxGeometry(0.35, 0.9, 0.3);
            bodyY = -0.15;
            break;
        case 'athletic':
            bodyGeometry = new THREE.BoxGeometry(0.6, 0.85, 0.35);
            bodyY = -0.1;
            break;
        case 'large':
            bodyGeometry = new THREE.BoxGeometry(0.75, 0.8, 0.45);
            bodyY = -0.1;
            break;
        default:
            bodyGeometry = new THREE.BoxGeometry(0.5, 0.85, 0.35);
            bodyY = -0.15;
    }

    const bodyMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.bodyColor });
    bodyMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
    bodyMesh.position.y = bodyY;
    avatarGroup.add(bodyMesh);

    // Arms
    const armGeometry = new THREE.BoxGeometry(0.15, 0.7, 0.15);
    const armMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.headColor });

    const arm1 = new THREE.Mesh(armGeometry, armMaterial);
    arm1.position.set(-0.4, 0.2, 0);
    avatarGroup.add(arm1);
    armMeshes.push(arm1);

    const arm2 = new THREE.Mesh(armGeometry, armMaterial);
    arm2.position.set(0.4, 0.2, 0);
    avatarGroup.add(arm2);
    armMeshes.push(arm2);

    // Pants
    const pantsGeometry = new THREE.BoxGeometry(0.5, 0.4, 0.35);
    const pantsMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.pantsColor });
    const pants = new THREE.Mesh(pantsGeometry, pantsMaterial);
    pants.position.y = -0.65;
    avatarGroup.add(pants);

    // Legs
    const legGeometry = new THREE.BoxGeometry(0.2, 0.5, 0.2);
    const shoesMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.shoesColor });

    const leg1 = new THREE.Mesh(legGeometry, shoesMaterial);
    leg1.position.set(-0.15, -1.3, 0);
    avatarGroup.add(leg1);
    legMeshes.push(leg1);

    const leg2 = new THREE.Mesh(legGeometry, shoesMaterial);
    leg2.position.set(0.15, -1.3, 0);
    avatarGroup.add(leg2);
    legMeshes.push(leg2);

    // Update preview too
    if (avatarGroupPreview) {
        createAvatarPartsPreview();
    }
}

function createAvatarPartsPreview() {
    avatarGroupPreview.children = [];

    const bodyType = currentAvatarState.bodyType;
    const headShape = currentAvatarState.headShape;
    
    // Create head based on shape
    let headGeometry;
    if (headShape === 'sphere') {
        headGeometry = new THREE.SphereGeometry(0.35, 32, 32);
    } else if (headShape === 'oval') {
        headGeometry = new THREE.SphereGeometry(0.35, 32, 32);
        headGeometry.scale(1, 1.2, 1);
    } else {
        headGeometry = new THREE.BoxGeometry(0.6, 0.8, 0.6);
    }

    const headMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.headColor });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 0.8;
    avatarGroupPreview.add(head);

    // Hair
    const hairGeometry = new THREE.BoxGeometry(0.7, 0.35, 0.65);
    const hairMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.hairColor });
    const hair = new THREE.Mesh(hairGeometry, hairMaterial);
    hair.position.y = 1.25;
    hair.position.z = -0.05;
    avatarGroupPreview.add(hair);

    // Eyes
    const eyeGeometry = new THREE.SphereGeometry(0.08, 16, 16);
    const eyeMaterial = new THREE.MeshPhongMaterial({ color: 0x000000 });
    
    const eye1 = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye1.position.set(-0.15, 0.95, 0.35);
    avatarGroupPreview.add(eye1);

    const eye2 = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye2.position.set(0.15, 0.95, 0.35);
    avatarGroupPreview.add(eye2);

    // Body sizing based on type
    let bodyGeometry, bodyY;
    switch(bodyType) {
        case 'slim':
            bodyGeometry = new THREE.BoxGeometry(0.35, 0.9, 0.3);
            bodyY = -0.15;
            break;
        case 'athletic':
            bodyGeometry = new THREE.BoxGeometry(0.6, 0.85, 0.35);
            bodyY = -0.1;
            break;
        case 'large':
            bodyGeometry = new THREE.BoxGeometry(0.75, 0.8, 0.45);
            bodyY = -0.1;
            break;
        default:
            bodyGeometry = new THREE.BoxGeometry(0.5, 0.85, 0.35);
            bodyY = -0.15;
    }

    const bodyMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.bodyColor });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = bodyY;
    avatarGroupPreview.add(body);

    // Arms
    const armGeometry = new THREE.BoxGeometry(0.15, 0.7, 0.15);
    const armMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.headColor });

    const arm1 = new THREE.Mesh(armGeometry, armMaterial);
    arm1.position.set(-0.4, 0.2, 0);
    avatarGroupPreview.add(arm1);

    const arm2 = new THREE.Mesh(armGeometry, armMaterial);
    arm2.position.set(0.4, 0.2, 0);
    avatarGroupPreview.add(arm2);

    // Pants
    const pantsGeometry = new THREE.BoxGeometry(0.5, 0.4, 0.35);
    const pantsMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.pantsColor });
    const pants = new THREE.Mesh(pantsGeometry, pantsMaterial);
    pants.position.y = -0.65;
    avatarGroupPreview.add(pants);

    // Legs
    const legGeometry = new THREE.BoxGeometry(0.2, 0.5, 0.2);
    const shoesMaterial = new THREE.MeshPhongMaterial({ color: currentAvatarState.shoesColor });

    const leg1 = new THREE.Mesh(legGeometry, shoesMaterial);
    leg1.position.set(-0.15, -1.3, 0);
    avatarGroupPreview.add(leg1);

    const leg2 = new THREE.Mesh(legGeometry, shoesMaterial);
    leg2.position.set(0.15, -1.3, 0);
    avatarGroupPreview.add(leg2);
}

function updateAvatarColors() {
    currentAvatarState.headColor = document.getElementById('headColor').value;
    currentAvatarState.hairColor = document.getElementById('hairColor').value;
    currentAvatarState.bodyColor = document.getElementById('bodyColor').value;
    currentAvatarState.pantsColor = document.getElementById('pantsColor').value;
    currentAvatarState.shoesColor = document.getElementById('shoesColor').value;

    // Update colors on existing meshes
    const meshes = avatarGroup.children;
    if (meshes[0] && meshes[0].material) {
        meshes[0].material.color.setStyle(currentAvatarState.headColor); // Head
    }
    if (meshes[1] && meshes[1].material) {
        meshes[1].material.color.setStyle(currentAvatarState.hairColor); // Hair
    }
    meshes.forEach((mesh, i) => {
        if (i === 5 || i === 6) {
            mesh.material.color.setStyle(currentAvatarState.headColor); // Arms
        }
    });

    if (avatarGroupPreview) {
        createAvatarPartsPreview();
    }
}

function updateAvatarBody() {
    currentAvatarState.bodyType = document.getElementById('bodyType').value;
    createAvatarParts();
}

function updateAvatarHead() {
    currentAvatarState.headShape = document.getElementById('headShape').value;
    createAvatarParts();
}

function updateAvatarExpression() {
    currentAvatarState.expression = document.getElementById('expression').value;
    createAvatarParts();
}

function resetAvatar() {
    currentAvatarState = {
        bodyType: 'normal',
        headShape: 'box',
        headColor: '#FDBCB4',
        hairColor: '#8B4513',
        bodyColor: '#4169E1',
        pantsColor: '#333333',
        shoesColor: '#000000',
        expression: 'happy'
    };
    
    document.getElementById('bodyType').value = 'normal';
    document.getElementById('headShape').value = 'box';
    document.getElementById('headColor').value = '#FDBCB4';
    document.getElementById('hairColor').value = '#8B4513';
    document.getElementById('bodyColor').value = '#4169E1';
    document.getElementById('pantsColor').value = '#333333';
    document.getElementById('shoesColor').value = '#000000';
    document.getElementById('expression').value = 'happy';
    
    createAvatarParts();
}

async function saveAvatarAppearance() {
    const currentUser = sessionStorage.getItem('currentUser');
    if (currentUser) {
        const user = JSON.parse(currentUser);
        if (user.isGuest) {
            alert('✅ Avatar gemt lokalt for gæst.');
            return;
        }
        await apiRequest(`/api/avatar/${encodeURIComponent(user.email)}`, {
            method: 'PUT',
            body: JSON.stringify({ data: currentAvatarState })
        });
        alert('✅ Avatar gemt!');
    }
}

async function saveAvaturnAvatar(data) {
    const user = getCurrentUser();
    if (!user) return;
    const payload = { provider: 'avaturn', export: data };
    avaturnAvatarData = payload;
    if (user.isGuest) {
        localStorage.setItem('guestAvaturnAvatar', JSON.stringify(payload));
        renderAvatarPreview();
        renderHeaderAvatar();
        alert('✅ Avaturn avatar gemt lokalt for gæst.');
        return;
    }

    localStorage.setItem(`userAvaturnAvatar:${user.email}`, JSON.stringify(payload));
    await apiRequestWithCredentials(`/api/avatar/${encodeURIComponent(user.email)}`, {
        method: 'PUT',
        body: JSON.stringify({ data: payload })
    });
    renderAvatarPreview();
    renderHeaderAvatar();
    alert('✅ Avaturn avatar gemt!');
}

async function loadAvatarAppearance() {
    const currentUser = sessionStorage.getItem('currentUser');
    if (currentUser) {
        const user = JSON.parse(currentUser);
        avaturnAvatarData = null;
        if (user.isGuest) {
            const avatarRaw = localStorage.getItem('guestAvaturnAvatar');
            if (avatarRaw) {
                try {
                    avaturnAvatarData = JSON.parse(avatarRaw);
                } catch (err) {
                    // ignore parse issues
                }
            }
            return;
        }
        try {
            const response = await apiRequestWithCredentials(`/api/avatar/${encodeURIComponent(user.email)}`);
            if (response?.data) {
                if (response.data.provider === 'avaturn') {
                    avaturnAvatarData = response.data;
                    return;
                }
                currentAvatarState = response.data;

                // Restore form values
                const bodyTypeInput = document.getElementById('bodyType');
                const headShapeInput = document.getElementById('headShape');
                const headColorInput = document.getElementById('headColor');
                const hairColorInput = document.getElementById('hairColor');
                const bodyColorInput = document.getElementById('bodyColor');
                const pantsColorInput = document.getElementById('pantsColor');
                const shoesColorInput = document.getElementById('shoesColor');
                const expressionInput = document.getElementById('expression');

                if (bodyTypeInput) bodyTypeInput.value = currentAvatarState.bodyType;
                if (headShapeInput) headShapeInput.value = currentAvatarState.headShape;
                if (headColorInput) headColorInput.value = currentAvatarState.headColor;
                if (hairColorInput) hairColorInput.value = currentAvatarState.hairColor;
                if (bodyColorInput) bodyColorInput.value = currentAvatarState.bodyColor;
                if (pantsColorInput) pantsColorInput.value = currentAvatarState.pantsColor;
                if (shoesColorInput) shoesColorInput.value = currentAvatarState.shoesColor;
                if (expressionInput) expressionInput.value = currentAvatarState.expression;
            }
        } catch (err) {
            // ignore missing avatar
        }

        if (!avaturnAvatarData) {
            const stored = localStorage.getItem(`userAvaturnAvatar:${user.email}`);
            if (stored) {
                try {
                    avaturnAvatarData = JSON.parse(stored);
                } catch (err) {
                    // ignore parse issues
                }
            }
        }
    }
}

function getAvaturnPreviewUrl(data) {
    if (!data) return null;
    const exportData = data.export || data;
    return (
        exportData?.avatar?.image?.url ||
        exportData?.avatar?.imageUrl ||
        exportData?.avatarImageUrl ||
        exportData?.preview?.url ||
        exportData?.previewUrl ||
        exportData?.thumbnailUrl ||
        exportData?.avatar?.thumbnail?.url ||
        exportData?.avatar?.thumbnailUrl ||
        exportData?.data?.avatar?.image?.url ||
        exportData?.data?.avatar?.imageUrl ||
        exportData?.data?.avatarImageUrl ||
        exportData?.data?.preview?.url ||
        exportData?.data?.previewUrl ||
        exportData?.data?.thumbnailUrl ||
        data?.data?.avatar?.image?.url ||
        data?.data?.avatar?.imageUrl ||
        data?.data?.avatarImageUrl ||
        data?.data?.preview?.url ||
        data?.data?.previewUrl ||
        data?.data?.thumbnailUrl ||
        null
    );
}

function getAvaturnModelUrl(data) {
    if (!data) return null;
    const exportData = data.export || data;
    return (
        exportData?.avatar?.model?.url ||
        exportData?.avatar?.modelUrl ||
        exportData?.model?.url ||
        exportData?.modelUrl ||
        exportData?.avatarModelUrl ||
        exportData?.glbUrl ||
        exportData?.avatar?.glbUrl ||
        exportData?.data?.avatar?.model?.url ||
        exportData?.data?.avatar?.modelUrl ||
        exportData?.data?.model?.url ||
        exportData?.data?.modelUrl ||
        data?.data?.avatar?.model?.url ||
        data?.data?.avatar?.modelUrl ||
        data?.data?.model?.url ||
        data?.data?.modelUrl ||
        null
    );
}

async function loadGltfLoader() {
    if (gltfLoaderPromise) return gltfLoaderPromise;
    gltfLoaderPromise = import('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/loaders/GLTFLoader.js')
        .then(module => module.GLTFLoader)
        .catch(() => import('https://unpkg.com/three@0.128.0/examples/jsm/loaders/GLTFLoader.js').then(module => module.GLTFLoader));
    return gltfLoaderPromise;
}

function fitCameraToObject(camera, object, offset = 1.6) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2))) * offset;

    camera.position.set(center.x, center.y + size.y * 0.1, cameraZ);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
}

async function renderAvaturnModelPreview(data) {
    const canvas = document.getElementById('avatarCanvasPreview');
    if (!canvas) return false;

    const modelUrl = getAvaturnModelUrl(data);
    if (!modelUrl) return false;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    if (!avaturnPreviewRenderer) {
        avaturnPreviewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        avaturnPreviewRenderer.setPixelRatio(window.devicePixelRatio);
        avaturnPreviewScene = new THREE.Scene();
        avaturnPreviewCamera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000);

        const light1 = new THREE.DirectionalLight(0xffffff, 1);
        light1.position.set(5, 5, 5);
        avaturnPreviewScene.add(light1);

        const light2 = new THREE.DirectionalLight(0xffffff, 0.6);
        light2.position.set(-5, 5, 5);
        avaturnPreviewScene.add(light2);

        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        avaturnPreviewScene.add(ambient);
    }

    avaturnPreviewRenderer.setSize(width, height, false);
    avaturnPreviewCamera.aspect = width / height;
    avaturnPreviewCamera.updateProjectionMatrix();

    if (avaturnPreviewModelUrl !== modelUrl) {
        const GLTFLoader = await loadGltfLoader();
        const loader = new GLTFLoader();
        loader.setCrossOrigin('anonymous');

        const gltf = await new Promise((resolve, reject) => {
            loader.load(modelUrl, resolve, undefined, reject);
        });

        if (avaturnPreviewModel) {
            avaturnPreviewScene.remove(avaturnPreviewModel);
        }

        avaturnPreviewModel = gltf.scene;
        avaturnPreviewScene.add(avaturnPreviewModel);
        fitCameraToObject(avaturnPreviewCamera, avaturnPreviewModel);
        avaturnPreviewModelUrl = modelUrl;
    }

    if (!avaturnPreviewAnimating) {
        avaturnPreviewAnimating = true;
        const animate = () => {
            if (!avaturnPreviewRenderer || !avaturnPreviewScene || !avaturnPreviewCamera) {
                avaturnPreviewAnimating = false;
                return;
            }
            if (avaturnPreviewModel) {
                avaturnPreviewModel.rotation.y += 0.005;
            }
            avaturnPreviewRenderer.render(avaturnPreviewScene, avaturnPreviewCamera);
            requestAnimationFrame(animate);
        };
        animate();
    } else {
        avaturnPreviewRenderer.render(avaturnPreviewScene, avaturnPreviewCamera);
    }

    return true;
}

function applyAvatarImage(el, url) {
    if (!el || !url) return;
    el.textContent = '';
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundRepeat = 'no-repeat';
}

async function loadUserAvatarPreview(email, el, fallbackText) {
    if (!el) return;
    if (fallbackText && !el.textContent) {
        el.textContent = fallbackText;
    }
    if (!email) return;

    if (userAvatarPreviewCache.has(email)) {
        const cachedUrl = userAvatarPreviewCache.get(email);
        if (cachedUrl) applyAvatarImage(el, cachedUrl);
        return;
    }

    const current = getCurrentUser();
    if (current?.email && current.email === email) {
        const stored = localStorage.getItem(`userAvaturnAvatar:${email}`);
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                const localUrl = getAvaturnPreviewUrl(parsed);
                userAvatarPreviewCache.set(email, localUrl || null);
                if (localUrl) applyAvatarImage(el, localUrl);
                return;
            } catch (err) {
                userAvatarPreviewCache.set(email, null);
            }
        }
    }

    try {
        const response = await apiRequestWithCredentials(`/api/avatar/${encodeURIComponent(email)}`);
        const url = response?.data?.provider === 'avaturn'
            ? getAvaturnPreviewUrl(response.data)
            : null;
        userAvatarPreviewCache.set(email, url || null);
        if (url && el.isConnected) {
            applyAvatarImage(el, url);
        }
    } catch (err) {
        userAvatarPreviewCache.set(email, null);
    }
}

function getInitialsFromUser(user) {
    const seed = (user?.name || user?.email || '').trim();
    if (!seed) return '👤';
    return seed
        .split(' ')
        .map(part => part[0])
        .join('')
        .substring(0, 2)
        .toUpperCase();
}

function renderAvatarPreview() {
    const previewCanvas = document.getElementById('avatarCanvasPreview');
    const container = document.querySelector('.avatar-canvas-clickable');
    if (!container) return;

    let img = document.getElementById('avaturnPreviewImage');
    if (!img) {
        img = document.createElement('img');
        img.id = 'avaturnPreviewImage';
        img.className = 'avaturn-preview-image';
        container.appendChild(img);
    }

    const previewUrl = getAvaturnPreviewUrl(avaturnAvatarData);
    if (previewUrl) {
        img.src = previewUrl;
        img.style.display = 'block';
        if (previewCanvas) previewCanvas.style.display = 'none';
        return;
    }

    if (avaturnAvatarData) {
        img.style.display = 'none';
        if (previewCanvas) previewCanvas.style.display = 'block';
        renderAvaturnModelPreview(avaturnAvatarData).catch(() => null);
        return;
    }

    img.style.display = 'none';
    if (previewCanvas) previewCanvas.style.display = 'block';
}

function renderHeaderAvatar(fallbackInitials) {
    const avatarCircle = document.getElementById('avatarInitials');
    if (!avatarCircle) return;

    const previewUrl = getAvaturnPreviewUrl(avaturnAvatarData);
    if (previewUrl) {
        avatarCircle.textContent = '';
        avatarCircle.style.backgroundImage = `url('${previewUrl}')`;
        avatarCircle.style.backgroundSize = 'cover';
        avatarCircle.style.backgroundPosition = 'center';
        avatarCircle.style.backgroundRepeat = 'no-repeat';
        return;
    }

    avatarCircle.style.backgroundImage = '';
    avatarCircle.style.backgroundSize = '';
    avatarCircle.style.backgroundPosition = '';
    avatarCircle.style.backgroundRepeat = '';
    if (fallbackInitials) {
        avatarCircle.textContent = fallbackInitials;
    }
}

async function initAvaturn() {
    const container = document.getElementById('avaturn-sdk-container');
    if (!container) return;
    if (avaturnInitInProgress) return;
    avaturnInitInProgress = true;
    container.innerHTML = '<p>Indlaeser Avaturn editor...</p>';

    try {
        const AvaturnSDK = await loadAvaturnSdk();
        if (!AvaturnSDK) {
            throw new Error('Avaturn SDK ikke tilgaengelig');
        }

        container.innerHTML = '';
        const sdk = new AvaturnSDK();
        const url = 'https://hookedirl.avaturn.dev';
        await sdk.init(container, { url });
        sdk.on('export', async (data) => {
            await saveAvaturnAvatar(data);
        });
    } catch (err) {
        console.error('Avaturn init fejl', err);
        container.innerHTML = '<p>Kunne ikke indlaese Avaturn. Proev igen senere.</p>';
    } finally {
        avaturnInitInProgress = false;
    }
}

async function loadAvaturnSdk() {
    if (avaturnSdkLoaded && window.AvaturnSDK) return window.AvaturnSDK;
    for (const source of AVATURN_SDK_SOURCES) {
        try {
            if (source.type === 'module') {
                const sdkModule = await import(source.url);
                const AvaturnSDK = sdkModule?.AvaturnSDK || sdkModule?.default || sdkModule;
                if (AvaturnSDK) {
                    avaturnSdkLoaded = true;
                    return AvaturnSDK;
                }
            } else {
                await loadScript(source.url);
                if (window.AvaturnSDK) {
                    avaturnSdkLoaded = true;
                    return window.AvaturnSDK;
                }
            }
        } catch (err) {
            // Try next source.
        }
    }
    return null;
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Kunne ikke indlaese ${url}`));
        document.head.appendChild(script);
    });
}

function openProfilePage() {
    navigateTo('/profile/');
}

function backToDashboard() {
    navigateTo('/');
}

function openPointShop() {
    navigateTo('/pointshop/');
}

function closePointShop() {
    navigateTo('/');
}

function openEventsPage() {
    navigateTo('/events/');
}

function goHome() {
    navigateTo('/');
}

function openAdminPage() {
    navigateTo('/admin/');
}

function openAllEventsPage() {
    navigateTo('/all-events/');
}

function closeEventsPage() {
    navigateTo('/');
}

function closeAllEventsPage() {
    navigateTo('/');
}

async function openFriendsPage() {
    if (isGuestUser()) {
        addNotification('Gæster har ikke adgang til venner.');
        return;
    }
    navigateTo('/friends/');
}

function closeFriendsPage() {
    navigateTo('/');
}

function openSettingsPage() {
    navigateTo('/settings/');
}

function closeSettingsPage() {
    navigateTo('/');
}

function openNotificationsPage() {
    navigateTo('/notifications/');
}

function closeNotificationsPage() {
    navigateTo('/');
}

async function openChatPage() {
    navigateTo('/chat/');
}

function showAdminPanel(isAuthed) {
    setHidden('adminLogin', isAuthed);
    setHidden('adminPanel', !isAuthed);
    setHidden('adminLogoutBtn', !isAuthed);
}

function showAdminError(message = '') {
    const el = document.getElementById('adminError');
    if (el) {
        el.textContent = message;
    }
}

function showAdminCreateError(message = '') {
    const el = document.getElementById('adminCreateError');
    if (el) {
        el.textContent = message;
    }
}

function formatAdminDate(value) {
    if (!value) return 'Ukendt';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Ukendt';
    return parsed.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function handleAdminLogin() {
    const emailInput = document.getElementById('adminEmail');
    const passwordInput = document.getElementById('adminPassword');
    if (!emailInput || !passwordInput) return;

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    showAdminError('');

    if (!email || !password) {
        showAdminError('Udfyld både e-mail og adgangskode.');
        return;
    }

    try {
        await apiRequest('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        setAdminAuth({ email, password });
        showAdminPanel(true);
        await loadAdminUsers();
    } catch (err) {
        showAdminError('Forkert admin-login.');
    }
}

function handleAdminLogout() {
    setAdminAuth(null);
    showAdminPanel(false);
}

async function handleAdminCreateUser() {
    const nameInput = document.getElementById('adminCreateName');
    const emailInput = document.getElementById('adminCreateEmail');
    const passwordInput = document.getElementById('adminCreatePassword');
    if (!nameInput || !emailInput || !passwordInput) return;

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    showAdminCreateError('');

    if (!name || !email) {
        showAdminCreateError('Navn og e-mail er påkrævet.');
        return;
    }

    try {
        await adminRequest('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({ name, email, password })
        });
        nameInput.value = '';
        emailInput.value = '';
        passwordInput.value = '';
        await loadAdminUsers();
    } catch (err) {
        if (err.status === 401) {
            handleAdminLogout();
            showAdminCreateError('Admin-login kræves.');
            return;
        }
        if (err.status === 409) {
            showAdminCreateError('E-mail findes allerede.');
            return;
        }
        showAdminCreateError('Kunne ikke oprette bruger.');
    }
}

async function handleAdminTogglePremium(email, isPremium) {
    if (!email) return;
    try {
        await adminRequest('/api/admin/premium', {
            method: 'POST',
            body: JSON.stringify({ email, isPremium })
        });
        await loadAdminUsers();
    } catch (err) {
        if (err.status === 401) {
            handleAdminLogout();
            showAdminError('Admin-login kræves.');
            return;
        }
        showAdminError('Kunne ikke opdatere premium.');
    }
}

async function handleAdminGrantItem() {
    const emailInput = document.getElementById('adminItemEmail');
    const itemInput = document.getElementById('adminItemName');
    if (!emailInput || !itemInput) return;
    const email = emailInput.value.trim();
    const itemName = itemInput.value.trim();
    showAdminCreateError('');
    if (!email || !itemName) {
        showAdminCreateError('E-mail og genstand er påkrævet.');
        return;
    }
    try {
        await adminRequest('/api/admin/items', {
            method: 'POST',
            body: JSON.stringify({ email, itemName, source: 'admin' })
        });
        itemInput.value = '';
    } catch (err) {
        showAdminCreateError('Kunne ikke give genstand.');
    }
}

async function handleAdminDeleteUser(email) {
    if (!email) return;
    const ok = confirm(`Slet brugeren ${email}?`);
    if (!ok) return;
    try {
        await adminRequest(`/api/admin/users/${encodeURIComponent(email)}`, {
            method: 'DELETE'
        });
        await loadAdminUsers();
    } catch (err) {
        showAdminCreateError('Kunne ikke slette brugeren.');
    }
}

async function loadAdminUsers() {
    const list = document.getElementById('adminUsersList');
    if (!list) return;
    list.innerHTML = '';

    try {
        const users = await adminRequest('/api/admin/users');
        if (!Array.isArray(users) || users.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'Ingen brugere endnu.';
            list.appendChild(li);
            return;
        }

        users.forEach(user => {
            const li = document.createElement('li');
            li.className = 'admin-user-row';

            const info = document.createElement('div');
            info.className = 'admin-user-info';
            info.innerHTML = `
                <strong>${user.name || 'Ukendt'}</strong>
                <span>${user.email || ''}</span>
                <span>Oprettet: ${formatAdminDate(user.createdAt)}</span>
                <span>${user.isPremium ? 'Premium: Ja' : 'Premium: Nej'}</span>
            `;

            const actions = document.createElement('div');
            actions.className = 'admin-user-actions';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'admin-delete-btn';
            deleteBtn.textContent = 'Slet';
            deleteBtn.addEventListener('click', () => handleAdminDeleteUser(user.email));

            const premiumBtn = document.createElement('button');
            premiumBtn.type = 'button';
            premiumBtn.className = 'admin-premium-btn';
            premiumBtn.textContent = user.isPremium ? 'Fjern premium' : 'Giv premium';
            premiumBtn.addEventListener('click', () => handleAdminTogglePremium(user.email, !user.isPremium));

            actions.appendChild(premiumBtn);
            actions.appendChild(deleteBtn);
            li.appendChild(info);
            li.appendChild(actions);
            list.appendChild(li);
        });
    } catch (err) {
        if (err.status === 401) {
            handleAdminLogout();
            showAdminError('Admin-login kræves.');
        }
        const li = document.createElement('li');
        li.textContent = 'Kunne ikke hente brugere.';
        list.appendChild(li);
    }
}

function initAdminPage() {
    const auth = getAdminAuth();
    showAdminPanel(Boolean(auth));
    if (auth) {
        loadAdminUsers();
    }
}

function closeChatPage() {
    navigateTo('/');
    stopChatAutoRefresh();
}

function getCurrentUser() {
    const currentUser = sessionStorage.getItem('currentUser');
    if (!currentUser) return null;
    return JSON.parse(currentUser);
}

async function getAllUserProfiles() {
    try {
        const users = await apiRequest('/api/users');
        const seen = new Set();
        return (users || []).filter(u => {
            if (!u.email || seen.has(u.email)) return false;
            seen.add(u.email);
            return true;
        });
    } catch (err) {
        return [];
    }
}

async function getFriends(email) {
    return apiRequest(`/api/friends/${encodeURIComponent(email)}`);
}

async function getFriendsOfFriends(email) {
    const directFriends = await getFriends(email);
    const fofSet = new Set();

    await Promise.all((directFriends || []).map(async (friendEmail) => {
        const friendsOfFriend = await getFriends(friendEmail);
        (friendsOfFriend || []).forEach(fof => {
            if (fof !== email && !directFriends.includes(fof)) {
                fofSet.add(fof);
            }
        });
    }));

    return Array.from(fofSet);
}

async function getRequests(email) {
    return apiRequest(`/api/requests/${encodeURIComponent(email)}`);
}

async function sendFriendRequest(targetEmail) {
    const current = getCurrentUser();
    if (!current || !current.email || current.isGuest) return;
    if (targetEmail === current.email) return;

    await apiRequest(`/api/requests/${encodeURIComponent(targetEmail)}`, {
        method: 'POST',
        body: JSON.stringify({ fromEmail: current.email })
    });
    await loadFriendsData();
}

async function acceptFriendRequest(fromEmail) {
    const current = getCurrentUser();
    if (!current || !current.email) return;

    await apiRequest(`/api/friends/${encodeURIComponent(current.email)}`, {
        method: 'POST',
        body: JSON.stringify({ friendEmail: fromEmail })
    });

    await apiRequest(`/api/friends/${encodeURIComponent(fromEmail)}`, {
        method: 'POST',
        body: JSON.stringify({ friendEmail: current.email })
    });

    await apiRequest(`/api/requests/${encodeURIComponent(current.email)}?fromEmail=${encodeURIComponent(fromEmail)}`, {
        method: 'DELETE'
    });

    await loadFriendsData();
}

async function declineFriendRequest(fromEmail) {
    const current = getCurrentUser();
    if (!current || !current.email) return;
    await apiRequest(`/api/requests/${encodeURIComponent(current.email)}?fromEmail=${encodeURIComponent(fromEmail)}`, {
        method: 'DELETE'
    });
    await loadFriendsData();
}

async function getUserLocationMap() {
    return apiRequest('/api/locations');
}

async function saveUserLocation(email, location) {
    await apiRequest(`/api/locations/${encodeURIComponent(email)}`, {
        method: 'POST',
        body: JSON.stringify({
            lat: location.lat,
            lng: location.lng,
            updatedAt: location.updatedAt
        })
    });
}

async function updateUserLocation() {
    const current = getCurrentUser();
    if (!current || !current.email || current.isGuest) return;

    const status = document.getElementById('friendsLocationStatus');
    if (!navigator.geolocation) {
        if (status) status.textContent = 'Lokation er ikke tilgængelig på denne enhed.';
        return;
    }

    if (status) status.textContent = 'Henter lokation...';
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const location = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                updatedAt: Date.now()
            };
            await saveUserLocation(current.email, location);
            if (status) status.textContent = '';
            await loadFriendsData();
        },
        () => {
            if (status) status.textContent = 'Tillad lokation for bedre forslag.';
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
}

function getDistanceKm(a, b) {
    if (!a || !b) return null;
    const toRad = (v) => v * Math.PI / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    return R * c;
}

function buildFriendItem(user, options = {}) {
    const item = document.createElement('div');
    item.className = 'friend-item';

    const avatar = document.createElement('div');
    avatar.className = 'friend-avatar';
    const initials = getInitialsFromUser(user);
    avatar.textContent = initials;
    loadUserAvatarPreview(user.email, avatar, initials);

    const meta = document.createElement('div');
    meta.className = 'friend-meta';

    const name = document.createElement('div');
    name.className = 'friend-name';
    name.textContent = user.name || 'Ukendt bruger';

    const sub = document.createElement('div');
    sub.className = 'friend-subtext';
    sub.textContent = options.subtext || user.email || '';

    meta.appendChild(name);
    meta.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';

    if (options.actions) {
        options.actions.forEach(btn => actions.appendChild(btn));
    }

    if (options.chip) {
        const chip = document.createElement('div');
        chip.className = 'friend-chip';
        chip.textContent = options.chip;
        actions.appendChild(chip);
    }

    item.appendChild(avatar);
    item.appendChild(meta);
    item.appendChild(actions);

    item.addEventListener('click', (e) => {
        if (e.target.tagName.toLowerCase() === 'button') return;
        openFriendModal(user, options.distanceKm);
    });

    return item;
}

function openFriendModal(user, distanceKm) {
    const modal = document.getElementById('friendModal');
    const name = document.getElementById('friendModalName');
    const info = document.getElementById('friendModalInfo');
    const avatar = document.getElementById('friendModalAvatar');
    if (!modal || !name || !info) return;

    name.textContent = user.name || 'Profil';
    if (avatar) {
        const initials = getInitialsFromUser(user);
        avatar.textContent = initials;
        avatar.style.backgroundImage = '';
        avatar.style.backgroundSize = '';
        avatar.style.backgroundPosition = '';
        avatar.style.backgroundRepeat = '';
        loadUserAvatarPreview(user.email, avatar, initials);
    }
    const distanceText = distanceKm ? `${distanceKm.toFixed(1)} km væk` : 'Afstand ukendt';
    info.innerHTML = `
        <div><strong>E-mail:</strong> ${user.email || 'Ukendt'}</div>
        <div><strong>Afstand:</strong> ${distanceText}</div>
        <div><strong>Status:</strong> ${user.isFriend ? 'Ven' : 'Ikke ven'}</div>
    `;
    modal.classList.add('show');
}

function closeFriendModal() {
    const modal = document.getElementById('friendModal');
    if (modal) modal.classList.remove('show');
}

function handleFriendSearch() {
    const input = document.getElementById('friendsSearchInput');
    if (!input) return;
    const query = input.value.trim().toLowerCase();
    renderSearchResults(query);
}

async function renderSearchResults(query = '') {
    const container = document.getElementById('friendsSearchResults');
    if (!container) return;
    container.innerHTML = '';

    const current = getCurrentUser();
    if (!current) return;
    const allUsers = (await getAllUserProfiles()).filter(u => u.email !== current.email);

    const filtered = query
        ? allUsers.filter(u => (u.name || '').toLowerCase().includes(query) || (u.email || '').toLowerCase().includes(query))
        : [];

    if (!query) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Skriv for at søge efter brugere.';
        container.appendChild(empty);
        return;
    }

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Ingen brugere fundet.';
        container.appendChild(empty);
        return;
    }

    const friends = await getFriends(current.email);
    const requests = await getRequests(current.email);
    filtered.forEach(user => {
        const isFriend = friends.includes(user.email);
        const isRequested = requests.includes(user.email);
        const button = document.createElement('button');
        button.className = isFriend ? 'friend-secondary-btn' : 'friend-add-btn';
        button.textContent = isFriend ? 'Venner' : (isRequested ? 'Afventer' : 'Tilføj');
        if (isFriend || isRequested) {
            button.disabled = true;
        }
        button.addEventListener('click', () => sendFriendRequest(user.email));

        user.isFriend = isFriend;
        container.appendChild(buildFriendItem(user, { actions: [button] }));
    });
}

async function renderSuggestions() {
    const container = document.getElementById('friendsSuggestions');
    const status = document.getElementById('friendsLocationStatus');
    if (!container) return;
    container.innerHTML = '';

    const current = getCurrentUser();
    if (!current || !current.email) return;

    const allUsers = (await getAllUserProfiles()).filter(u => u.email !== current.email);
    const locationMap = await getUserLocationMap();
    const currentLocation = locationMap[current.email];
    const friends = await getFriends(current.email);
    const requests = await getRequests(current.email);

    const hasLocation = !!currentLocation;
    if (!hasLocation) {
        if (status) status.textContent = 'Lokation ikke tilladt – viser alternative forslag.';
    } else if (status) {
        status.textContent = '';
    }

    let suggestions = [];

    if (hasLocation) {
        suggestions = allUsers
            .map(user => {
                const distance = locationMap[user.email]
                    ? getDistanceKm(currentLocation, locationMap[user.email])
                    : null;
                return { ...user, distance };
            })
            .sort((a, b) => {
                if (a.distance == null && b.distance == null) return 0;
                if (a.distance == null) return 1;
                if (b.distance == null) return -1;
                return a.distance - b.distance;
            })
            .slice(0, 8);
    } else {
        const fofEmails = await getFriendsOfFriends(current.email);
        const fofUsers = allUsers.filter(u => fofEmails.includes(u.email));
        suggestions = (fofUsers.length > 0 ? fofUsers : allUsers)
            .slice(0, 8)
            .map(user => ({ ...user, distance: null }));
    }

    if (suggestions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Ingen forslag endnu.';
        container.appendChild(empty);
        return;
    }

    suggestions.forEach(user => {
        const isFriend = friends.includes(user.email);
        const isRequested = requests.includes(user.email);
        const button = document.createElement('button');
        button.className = isFriend ? 'friend-secondary-btn' : 'friend-add-btn';
        button.textContent = isFriend ? 'Venner' : (isRequested ? 'Afventer' : 'Tilføj');
        if (isFriend || isRequested) button.disabled = true;
        button.addEventListener('click', () => sendFriendRequest(user.email));

        const distanceText = user.distance != null ? `${user.distance.toFixed(1)} km væk` : 'Forslag';
        user.isFriend = isFriend;
        container.appendChild(buildFriendItem(user, {
            subtext: distanceText,
            actions: [button],
            distanceKm: user.distance
        }));
    });
}

async function renderRequests() {
    const container = document.getElementById('friendsRequests');
    if (!container) return;
    container.innerHTML = '';

    const current = getCurrentUser();
    if (!current || !current.email) return;
    const requests = await getRequests(current.email);
    const allUsers = await getAllUserProfiles();

    if (requests.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Ingen anmodninger.';
        container.appendChild(empty);
        return;
    }

    requests.forEach(email => {
        const user = allUsers.find(u => u.email === email) || { name: email, email };
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'friend-add-btn';
        acceptBtn.textContent = 'Acceptér';
        acceptBtn.addEventListener('click', () => acceptFriendRequest(email));

        const declineBtn = document.createElement('button');
        declineBtn.className = 'friend-secondary-btn';
        declineBtn.textContent = 'Afvis';
        declineBtn.addEventListener('click', () => declineFriendRequest(email));

        container.appendChild(buildFriendItem(user, { actions: [acceptBtn, declineBtn] }));
    });
}

async function renderFriendsList() {
    const container = document.getElementById('friendsList');
    if (!container) return;
    container.innerHTML = '';

    const current = getCurrentUser();
    if (!current || !current.email) return;
    const friends = await getFriends(current.email);
    const allUsers = await getAllUserProfiles();

    if (friends.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'friends-empty';
        empty.textContent = 'Du har ingen venner endnu.';
        container.appendChild(empty);
        return;
    }

    friends.forEach(email => {
        const user = allUsers.find(u => u.email === email) || { name: email, email };
        user.isFriend = true;
        container.appendChild(buildFriendItem(user, { chip: 'Ven' }));
    });
}

async function loadFriendsData() {
    await renderSuggestions();
    await renderRequests();
    await renderFriendsList();
    await renderSearchResults(document.getElementById('friendsSearchInput')?.value.trim().toLowerCase() || '');
}

async function saveSettings() {
    const name = document.getElementById('settingsName').value.trim();
    const email = document.getElementById('settingsEmail').value.trim();
    const errorEl = document.getElementById('settingsError');
    if (errorEl) errorEl.innerHTML = '';

    if (isGuestUser()) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Gæster kan ikke ændre navn eller e-mail</p>';
        return;
    }

    if (!name || !email) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Brugernavn og e-mail er påkrævet</p>';
        return;
    }

    const currentUser = sessionStorage.getItem('currentUser');
    if (!currentUser) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Du er ikke logget ind</p>';
        return;
    }

    const user = JSON.parse(currentUser);
    const oldEmail = user.email;

    if (!user.isGuest) {
        try {
            await apiRequest(`/api/users/${encodeURIComponent(oldEmail)}`, {
                method: 'PUT',
                body: JSON.stringify({ name, email })
            });
        } catch (err) {
            if (errorEl) errorEl.innerHTML = '<p class="error-message">Kunne ikke gemme ændringer</p>';
            return;
        }
    }

    const updatedUser = { ...user, name, email };
    sessionStorage.setItem('currentUser', JSON.stringify(updatedUser));

    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    setText('avatarInitials', initials);
    setText('avatarName', name);
    setText('displayUserName', name);
    setText('displayUserEmail', email);

    await refreshStoredEvents();
    await loadFriendsData();

    if (errorEl) errorEl.innerHTML = '<p class="success-message">Gemt</p>';
}

async function deleteAccount() {
    const currentUser = sessionStorage.getItem('currentUser');
    if (!currentUser) {
        alert('Du er ikke logget ind.');
        return;
    }

    const user = JSON.parse(currentUser);
    if (!confirm('Er du sikker på, at du vil slette din konto? Dette kan ikke fortrydes.')) {
        return;
    }

    if (!user.isGuest) {
        try {
            await apiRequest(`/api/users/${encodeURIComponent(user.email)}`, {
                method: 'DELETE'
            });
        } catch (err) {
            alert('Kunne ikke slette konto. Prøv igen.');
            return;
        }
    }

    handleLogout();
    alert('Din konto er slettet.');
}

function openPolicy(type) {
    if (type === 'privacy') {
        alert('Privatlivspolitik kommer snart.');
    } else {
        alert('Vilkår og betingelser kommer snart.');
    }
}

function getDateRangeIso() {
    const start = new Date();
    const end = new Date();
    end.setMonth(end.getMonth() + 3);
    const toTicketmasterIso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
        start: toTicketmasterIso(start),
        end: toTicketmasterIso(end)
    };
}

function formatEventDate(dateString) {
    if (!dateString) return 'Dato TBA';
    const date = new Date(dateString);
    return date.toLocaleDateString('da-DK', {
        day: '2-digit',
        month: 'short'
    });
}

function getFallbackEvents() {
    return [
        { name: 'Roskilde Festival', city: 'Roskilde', date: 'Dato TBA', url: '#', price: 899, currency: 'DKK' },
        { name: 'Tinderbox', city: 'Odense', date: 'Dato TBA', url: '#', price: 799, currency: 'DKK' },
        { name: 'NorthSide', city: 'Aarhus', date: 'Dato TBA', url: '#', price: 699, currency: 'DKK' },
        { name: 'Smukfest', city: 'Skanderborg', date: 'Dato TBA', url: '#', price: 849, currency: 'DKK' },
        { name: 'Copenhagen Jazz Festival', city: 'København', date: 'Dato TBA', url: '#', price: 399, currency: 'DKK' }
    ];
}

function updateEventsUI(events, options = {}) {
    const top3 = document.getElementById('eventsTop3');
    const list = document.getElementById('eventsList');

    if (!top3 && !list) return;

    if (top3) {
        top3.innerHTML = '';
        const topThree = events.slice(0, 3);
        const medals = ['🥇', '🥈', '🥉'];
        topThree.forEach((event, index) => {
            const li = document.createElement('li');
            const medal = medals[index] || '🏅';
            li.innerHTML = `
                <span class="rank">${medal} ${index + 1}.</span>
                <span class="event-title">${event.name}</span>
                <span class="event-city">${event.city}</span>
            `;
            top3.appendChild(li);
        });
    }

    if (list) {
        list.innerHTML = '';
        events.slice(0, 50).forEach(event => {
            const li = document.createElement('li');
            const row = document.createElement('div');
            row.className = 'event-row';

            const main = document.createElement('div');
            main.className = 'event-main';

            const link = document.createElement('a');
            link.href = event.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = event.name;

            const meta = document.createElement('span');
            const priceText = event.price ? ` · ${formatPrice(event.price, event.currency)}` : '';
            meta.textContent = `${event.city} · ${event.date}${priceText}`;

            main.appendChild(link);
            main.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'event-actions';

            const interestedBtn = document.createElement('button');
            interestedBtn.className = 'event-action-btn event-action-interested';
            if (isEventStored('interested', event)) {
                interestedBtn.classList.add('active');
                interestedBtn.textContent = 'Interesseret ✔';
            } else {
                interestedBtn.textContent = 'Interesseret';
            }
            interestedBtn.addEventListener('click', async () => {
                await toggleEventStored('interested', event);
                updateEventsUI(events);
            });

            const attendBtn = document.createElement('button');
            attendBtn.className = 'event-action-btn event-action-attend';
            if (isEventStored('attending', event)) {
                attendBtn.classList.add('active');
                attendBtn.textContent = 'Deltager ✔';
            } else {
                attendBtn.textContent = 'Deltager';
            }
            attendBtn.addEventListener('click', async () => {
                const wasStored = isEventStored('attending', event);
                if (!wasStored) {
                    if (event.url && event.url !== '#') {
                        window.location.assign(event.url);
                    } else {
                        addNotification('Ticketmaster-link mangler for denne begivenhed.');
                    }
                }
                await toggleEventStored('attending', event);
                if (!wasStored) {
                    awardPurchaseRewards(event.price, event);
                }
                updateEventsUI(events);
            });

            actions.appendChild(interestedBtn);
            actions.appendChild(attendBtn);

            row.appendChild(main);
            row.appendChild(actions);
            li.appendChild(row);
            list.appendChild(li);
        });
    }
}

function updateAllEventsUI(events) {
    const list = document.getElementById('allEventsList');
    if (!list) return;
    list.innerHTML = '';

    events.slice(0, 100).forEach(event => {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'event-row';

        const main = document.createElement('div');
        main.className = 'event-main';

        const link = document.createElement('a');
        link.href = event.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = event.name;

        const meta = document.createElement('span');
        const priceText = event.price ? ` · ${formatPrice(event.price, event.currency)}` : '';
        meta.textContent = `${event.city} · ${event.date}${priceText}`;

        main.appendChild(link);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'event-actions';

        const interestedBtn = document.createElement('button');
        interestedBtn.className = 'event-action-btn event-action-interested';
        if (isEventStored('interested', event)) {
            interestedBtn.classList.add('active');
            interestedBtn.textContent = 'Interesseret ✔';
        } else {
            interestedBtn.textContent = 'Interesseret';
        }
        interestedBtn.addEventListener('click', async () => {
            await toggleEventStored('interested', event);
            updateAllEventsUI(events);
        });

        const attendBtn = document.createElement('button');
        attendBtn.className = 'event-action-btn event-action-attend';
        if (isEventStored('attending', event)) {
            attendBtn.classList.add('active');
            attendBtn.textContent = 'Deltager ✔';
        } else {
            attendBtn.textContent = 'Deltager';
        }
        attendBtn.addEventListener('click', async () => {
            const wasStored = isEventStored('attending', event);
            if (!wasStored) {
                if (event.url && event.url !== '#') {
                    window.location.assign(event.url);
                } else {
                    addNotification('Ticketmaster-link mangler for denne begivenhed.');
                }
            }
            await toggleEventStored('attending', event);
            if (!wasStored) {
                awardPurchaseRewards(event.price, event);
            }
            updateAllEventsUI(events);
        });

        actions.appendChild(interestedBtn);
        actions.appendChild(attendBtn);

        row.appendChild(main);
        row.appendChild(actions);
        li.appendChild(row);
        list.appendChild(li);
    });
}

async function loadEvents() {
    const top3 = document.getElementById('eventsTop3');
    const list = document.getElementById('eventsList');

    const range = getDateRangeIso();
    const url = buildTicketmasterUrl({
        countryCode: 'DK',
        size: '50',
        sort: 'date,asc',
        startDateTime: range.start,
        endDateTime: range.end,
        locale: '*'
    });

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            updateEventsUI(getFallbackEvents());
            return;
        }
        const items = data?._embedded?.events || [];

        const events = items.map(item => {
            const city = item._embedded?.venues?.[0]?.city?.name || 'Danmark';
            const rawDate = item.dates?.start?.dateTime || item.dates?.start?.localDate || '';
            const date = formatEventDate(rawDate);
            const priceRange = item.priceRanges?.[0] || {};
            const price = typeof priceRange.min === 'number' ? priceRange.min : (typeof priceRange.max === 'number' ? priceRange.max : null);
            return {
                id: item.id,
                name: item.name,
                city,
                date,
                rawDate,
                url: item.url || '#',
                price,
                currency: priceRange.currency || 'DKK'
            };
        });

        if (events.length === 0) {
            updateEventsUI(getFallbackEvents());
            return;
        }

        updateEventsUI(events);
    } catch (error) {
        updateEventsUI(getFallbackEvents());
    }
}

async function loadAllEvents() {
    const list = document.getElementById('allEventsList');
    const range = getDateRangeIso();
    const url = buildTicketmasterUrl({
        countryCode: 'DK',
        size: '100',
        startDateTime: range.start,
        endDateTime: range.end,
        locale: '*'
    });

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            updateAllEventsUI(getFallbackEvents());
            return;
        }

        const items = data?._embedded?.events || [];
        const events = items.map(item => {
            const city = item._embedded?.venues?.[0]?.city?.name || 'Danmark';
            const rawDate = item.dates?.start?.dateTime || item.dates?.start?.localDate || '';
            const date = formatEventDate(rawDate);
            const priceRange = item.priceRanges?.[0] || {};
            const price = typeof priceRange.min === 'number' ? priceRange.min : (typeof priceRange.max === 'number' ? priceRange.max : null);
            return {
                id: item.id,
                name: item.name,
                city,
                date,
                rawDate,
                url: item.url || '#',
                price,
                currency: priceRange.currency || 'DKK'
            };
        });

        events.sort((a, b) => {
            const aTime = a.rawDate ? new Date(a.rawDate).getTime() : Number.POSITIVE_INFINITY;
            const bTime = b.rawDate ? new Date(b.rawDate).getTime() : Number.POSITIVE_INFINITY;
            return aTime - bTime;
        });

        if (events.length === 0) {
            updateAllEventsUI(getFallbackEvents());
            return;
        }

        updateAllEventsUI(events);
    } catch (error) {
        updateAllEventsUI(getFallbackEvents());
    }
}

function openFullscreenMap() {
    const map = document.getElementById('fullscreenMap');
    if (map) map.classList.add('show');
}

function closeFullscreenMap() {
    const map = document.getElementById('fullscreenMap');
    if (map) map.classList.remove('show');
}

// Simuleret database af brugere (gemmes nu i backend)
function initializeDatabase() {}

function toggleForm() {
    document.getElementById('loginForm').classList.toggle('hidden');
    document.getElementById('registerForm').classList.toggle('hidden');
    clearErrors();
}

function clearErrors() {
    const loginError = document.getElementById('loginError');
    if (loginError) loginError.innerHTML = '';
    document.getElementById('registerError').innerHTML = '';
}

async function handleRegister() {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;
    const errorDiv = document.getElementById('registerError');

    clearErrors();

    if (!name) {
        errorDiv.innerHTML = '<p class="error-message">Navn er påkrævet</p>';
        return;
    }

    if (!email) {
        errorDiv.innerHTML = '<p class="error-message">E-mail er påkrævet</p>';
        return;
    }

    if (!password || !confirmPassword) {
        errorDiv.innerHTML = '<p class="error-message">Adgangskode er påkrævet</p>';
        return;
    }

    if (password !== confirmPassword) {
        errorDiv.innerHTML = '<p class="error-message">Adgangskoderne stemmer ikke overens</p>';
        return;
    }

    if (password.length < 6) {
        errorDiv.innerHTML = '<p class="error-message">Adgangskoden skal være mindst 6 tegn</p>';
        return;
    }

    try {
        await apiRequest('/api/users/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, password })
        });

        errorDiv.innerHTML = '<p class="success-message">Profil oprettet! Du kan nu logge ind</p>';
    } catch (err) {
        errorDiv.innerHTML = '<p class="error-message">Denne e-mail er allerede registreret</p>';
        return;
    }
    
    setTimeout(() => {
        toggleForm();
        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) loginEmail.value = email;
        document.getElementById('regName').value = '';
        document.getElementById('regEmail').value = '';
        document.getElementById('regPassword').value = '';
        document.getElementById('regConfirmPassword').value = '';
    }, 1500);
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');

    clearErrors();

    if (!email || !password) {
        errorDiv.innerHTML = '<p class="error-message">E-mail og adgangskode er påkrævet</p>';
        return;
    }

    try {
        const user = await apiRequest('/api/users/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        await loginUser(user.name, user.email, false, { skipServerLogin: true });
    } catch (err) {
        errorDiv.innerHTML = '<p class="error-message">Forkert e-mail eller adgangskode</p>';
    }
}

function handleGuestLogin() {
    loginUser('Gæst', 'gæst@eksempel.dk', true);
}

function handleMitIDLogin() {
    document.getElementById('mitidModal').classList.add('show');
    document.getElementById('mitidForm').classList.remove('hidden');
    document.getElementById('mitidRegister').classList.add('hidden');
    document.getElementById('mitidLoading').classList.remove('show');
    document.getElementById('mitidError').innerHTML = '';
    document.getElementById('mitidRegisterError').innerHTML = '';
    document.getElementById('mitidInput').focus();
}

function getMitidProfileKey(cpr) {
    return `mitidProfile:${cpr}`;
}

function closeMitIDModal() {
    document.getElementById('mitidModal').classList.remove('show');
    document.getElementById('mitidForm').classList.remove('hidden');
    document.getElementById('mitidRegister').classList.add('hidden');
    document.getElementById('mitidLoading').classList.remove('show');
    document.getElementById('mitidInput').value = '';
    document.getElementById('mitidRegName').value = '';
    document.getElementById('mitidRegEmail').value = '';
    document.getElementById('mitidError').innerHTML = '';
    document.getElementById('mitidRegisterError').innerHTML = '';
    pendingMitidCpr = null;
}

function backToMitIDLogin() {
    document.getElementById('mitidRegister').classList.add('hidden');
    document.getElementById('mitidForm').classList.remove('hidden');
    document.getElementById('mitidRegisterError').innerHTML = '';
    document.getElementById('mitidInput').focus();
}

async function confirmMitIDLogin() {
    const cprNumber = document.getElementById('mitidInput').value.trim();
    const errorEl = document.getElementById('mitidError');
    if (errorEl) errorEl.innerHTML = '';
    
    if (!cprNumber) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Angiv venligst dit CPR-nummer</p>';
        return;
    }

    if (!/^\d{6}-\d{4}$/.test(cprNumber)) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Ugyldigt CPR-format. Brug formatet: DDMMYY-XXXX</p>';
        return;
    }

    try {
        const user = await apiRequest(`/api/mitid/${encodeURIComponent(cprNumber)}`);
        localStorage.setItem(getMitidProfileKey(cprNumber), JSON.stringify({
            name: user.name,
            email: user.email
        }));
        await loginUser(user.name, user.email, false, { skipServerLogin: true });
        closeMitIDModal();
        return;
    } catch (err) {
        // continue to registration step
    }

    const cachedProfileRaw = localStorage.getItem(getMitidProfileKey(cprNumber));
    if (cachedProfileRaw) {
        try {
            const cachedProfile = JSON.parse(cachedProfileRaw);
            if (cachedProfile?.name && cachedProfile?.email) {
                const user = await apiRequest('/api/mitid/register', {
                    method: 'POST',
                    body: JSON.stringify({ name: cachedProfile.name, email: cachedProfile.email, cpr: cprNumber })
                });
                await loginUser(user.name, user.email, false, { skipServerLogin: true });
                closeMitIDModal();
                return;
            }
        } catch (err) {
            // fall through to manual register
        }
    }

    pendingMitidCpr = cprNumber;
    document.getElementById('mitidForm').classList.add('hidden');
    document.getElementById('mitidRegister').classList.remove('hidden');
    document.getElementById('mitidRegName').focus();
}

async function confirmMitIDRegister() {
    const name = document.getElementById('mitidRegName').value.trim();
    const email = document.getElementById('mitidRegEmail').value.trim();
    const errorEl = document.getElementById('mitidRegisterError');
    if (errorEl) errorEl.innerHTML = '';

    if (!pendingMitidCpr) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">CPR-nummer mangler. Prøv igen.</p>';
        return;
    }

    if (!name) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Brugernavn er påkrævet</p>';
        return;
    }

    if (!email) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">E-mail er påkrævet</p>';
        return;
    }

    try {
        const user = await apiRequest('/api/mitid/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, cpr: pendingMitidCpr })
        });
        localStorage.setItem(getMitidProfileKey(pendingMitidCpr), JSON.stringify({ name, email }));
        await loginUser(user.name, user.email, false, { skipServerLogin: true });
        closeMitIDModal();
    } catch (err) {
        if (errorEl) errorEl.innerHTML = '<p class="error-message">Kunne ikke oprette MitID bruger</p>';
    }
}

// Allow Enter key to submit
document.addEventListener('DOMContentLoaded', function() {
    const mitidInput = document.getElementById('mitidInput');
    if (mitidInput) {
        mitidInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                confirmMitIDLogin();
            }
        });
    }

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendChatMessage();
            }
        });
    }

    initPointShop();
    updateStatsUI();
    renderNotifications();
});

window.addEventListener('resize', () => {
    resizeAvatarCanvas();
});

document.addEventListener('DOMContentLoaded', function() {
    const mapFloat = document.getElementById('mapFloat');
    if (!mapFloat) return;

    let isDragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragReady = false;
    let dragTimer = null;
    const dragDelay = 200;
    const dragThreshold = 6;

    const onPointerMove = (e) => {
        if (!dragReady) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < dragThreshold && Math.abs(dy) < dragThreshold) return;
        moved = true;

        const newLeft = startLeft + dx;
        const newTop = startTop + dy;

        mapFloat.style.left = `${newLeft}px`;
        mapFloat.style.top = `${newTop}px`;
        mapFloat.style.right = 'auto';
        mapFloat.style.bottom = 'auto';
    };

    const onPointerUp = () => {
        if (dragTimer) {
            clearTimeout(dragTimer);
            dragTimer = null;
        }
        if (!dragReady) {
            moved = false;
            return;
        }
        dragReady = false;
        isDragging = false;
        mapFloat.classList.remove('dragging');
        if (!moved) {
            mapFloat.style.left = '';
            mapFloat.style.top = '';
            mapFloat.style.right = '';
            mapFloat.style.bottom = '';
        }
        mapFloat.releasePointerCapture?.(mapFloat.pointerId);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
    };

    mapFloat.addEventListener('pointerdown', (e) => {
        moved = false;
        dragReady = false;
        isDragging = true;
        mapFloat.setPointerCapture?.(e.pointerId);

        const rect = mapFloat.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;

        dragTimer = setTimeout(() => {
            dragReady = true;
            mapFloat.classList.add('dragging');
        }, dragDelay);

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
    });

    mapFloat.addEventListener('click', (e) => {
        if (moved) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        openFullscreenMap();
    });
});

async function loginUser(name, email, isGuest, options = {}) {
    const payload = JSON.stringify({ name, email, isGuest });
    sessionStorage.setItem('currentUser', payload);
    localStorage.setItem('currentUser', payload);
    if (!isGuest && !options.skipServerLogin) {
        await apiRequest('/api/users/login', {
            method: 'POST',
            body: JSON.stringify({ name, email })
        });
    }
    if (isGuest) {
        guestStats = { xp: 0, level: 1, points: 0 };
        guestNotifications = [];
        guestChats = {};
    }
    await showDashboard(name, email, isGuest);
}

async function showDashboard(name, email, isGuest) {
    const container = document.querySelector('.container');
    if (container) container.classList.add('hidden');
    setHidden('loginForm', true);
    setHidden('registerForm', true);
    setHidden('dashboard', true);
    setHidden('menu', false);
    setHidden('profilePage', true);
    setHidden('eventsPage', true);
    setHidden('allEventsPage', true);
    setHidden('settingsPage', true);
    setHidden('friendsPage', true);
    setHidden('pointShopPage', true);
    setHidden('notificationsPage', true);
    setHidden('chatPage', true);
    setHidden('footerMenu', false);
    updateUserUI({ name, email, isGuest });
    
    // Update avatar with user initials
    // Load saved appearance and init preview
    await loadAvatarAppearance();
    renderAvatarPreview();
    renderHeaderAvatar();
    await initAvaturn();
    await loadPopularItems();

    updateStatsUI();
    renderNotifications();

    await refreshStoredEvents();
    await loadEvents();
    await updateUserLocation();
    startAccountDeletionWatcher({ name, email, isGuest });
}

function handleProfile() {
    openProfilePage();
}

function handleSettings() {
    openSettingsPage();
}

function handleLogout() {
    sessionStorage.removeItem('currentUser');
    localStorage.removeItem('currentUser');
    guestStats = { xp: 0, level: 1, points: 0 };
    guestNotifications = [];
    guestChats = {};
    stopAccountDeletionWatcher();
    stopChatAutoRefresh();

    if (getCurrentPage() !== 'home') {
        navigateTo('/');
        return;
    }

    const container = document.querySelector('.container');
    if (container) container.classList.remove('hidden');
    setHidden('loginForm', false);
    setHidden('menu', true);
    setHidden('eventsPage', true);
    setHidden('allEventsPage', true);
    setHidden('settingsPage', true);
    setHidden('friendsPage', true);
    setHidden('footerMenu', true);
    setHidden('pointShopPage', true);
    setHidden('notificationsPage', true);
    setHidden('chatPage', true);
    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    if (loginEmail) loginEmail.value = '';
    if (loginPassword) loginPassword.value = '';
    clearErrors();
    updateStatsUI({ xp: 0, level: 1, points: 0 });
}

async function checkLogin() {
    let currentUser = sessionStorage.getItem('currentUser');
    if (!currentUser) {
        const storedUser = localStorage.getItem('currentUser');
        if (storedUser) {
            sessionStorage.setItem('currentUser', storedUser);
            currentUser = storedUser;
        }
    }
    const currentPage = getCurrentPage();
    if (currentPage === 'admin') {
        initAdminPage();
        return;
    }
    if (!currentUser) {
        if (currentPage !== 'home') {
            navigateTo('/');
        }
        return;
    }

    const user = JSON.parse(currentUser);
    await ensureUserExists(user);
    if (getCurrentPage() === 'home') {
        await showDashboard(user.name, user.email, user.isGuest);
        return;
    }

    await applyUserToPage(user);
}

async function ensureUserExists(user) {
    if (!user || user.isGuest || !user.email) return;
    try {
        await apiRequestWithStatus(`/api/users/${encodeURIComponent(user.email)}`);
    } catch (err) {
        if (err.status === 404) {
            await apiRequest('/api/users/login', {
                method: 'POST',
                body: JSON.stringify({ name: user.name, email: user.email })
            });
        }
    }
}

async function applyUserToPage(user) {
    updateUserUI(user);
    updateStatsUI();
    renderNotifications();
    await refreshStoredEvents();
    startAccountDeletionWatcher(user);

    const page = getCurrentPage();
    if (page === 'friends' && user.isGuest) {
        addNotification('Gæster har ikke adgang til venner.');
        navigateTo('/');
        return;
    }

    if (page === 'profile') {
        await loadAvatarAppearance();
        renderHeaderAvatar();
        await initAvaturn();
        return;
    }

    if (page === 'events') {
        await loadEvents();
        return;
    }

    if (page === 'all-events') {
        await loadAllEvents();
        return;
    }

    if (page === 'settings') {
        prepareSettingsPage(user);
        return;
    }

    if (page === 'friends') {
        await loadFriendsData();
        await updateUserLocation();
        return;
    }

    if (page === 'pointshop') {
        initPointShop();
        switchShopTab('points');
        return;
    }

    if (page === 'notifications') {
        renderNotifications();
        return;
    }

    if (page === 'chat') {
        await loadChatContacts();
    }
}

async function loadPopularItems() {
    const list = document.getElementById('popularItemsList');
    if (!list) return;
    list.innerHTML = '';
    try {
        const rows = await apiRequest('/api/items/popular');
        if (!Array.isArray(rows) || rows.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'Ingen data endnu.';
            list.appendChild(li);
            return;
        }

        rows.slice(0, 5).forEach((row, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="popular-rank">${index + 1}</span> ${row.itemName} <span class="popular-count">${row.count}x</span>`;
            list.appendChild(li);
        });
    } catch (err) {
        const li = document.createElement('li');
        li.textContent = 'Kunne ikke hente data.';
        list.appendChild(li);
    }
}

// Initialisering
initializeDatabase();
checkLogin();
