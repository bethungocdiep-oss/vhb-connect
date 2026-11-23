
const API = '/api';

let token = localStorage.getItem('vhb_token');
let me = JSON.parse(localStorage.getItem('vhb_user') || 'null');

let category = 'Tất cả';
let authMode = 'login';
let socket = null;
let currentRoom = null;
let selectedTopic = 'Học tập';

let localStream = null;
let peers = {};
let micStatus = 'none';

const $ = id => document.getElementById(id);

// ==========================================
// 1. API
// ==========================================

async function api(url, opts = {}) {
    const headers = {
        ...(opts.headers || {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
    };

    let body = opts.body;

    if (body && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }

    const response = await fetch(API + url, {
        ...opts,
        headers,
        body
    });

    let data = {};

    try {
        data = await response.json();
    } catch {}

    if (!response.ok) {
        throw Error(data.message || 'Có lỗi xảy ra.');
    }

    return data;
}

// ==========================================
// 2. THÔNG BÁO
// ==========================================

function notify(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');

    clearTimeout(window.toastTimer);

    window.toastTimer = setTimeout(() => {
        $('toast').classList.remove('show');
    }, 2800);
}

// ==========================================
// 3. KIỂM TRA ĐĂNG NHẬP
// ==========================================

function logged() {
    if (!token || !me) {
        openAuth('login');
        notify('Vui lòng đăng nhập trước.');
        return false;
    }

    return true;
}

// ==========================================
// 4. HIỂN THỊ TÀI KHOẢN
// ==========================================

function updateAccount() {
    if (me) {
        $('account').innerHTML = `
            <button class="account-button" onclick="openProfile()">
                <span class="account-avatar">♡</span>
                <span>${escapeHtml(me.display_name)}</span>
                <span>⌄</span>
            </button>
        `;
    } else {
        $('account').innerHTML = `
            <button class="btn secondary"
                    onclick="openAuth('login')">
                Đăng nhập / Đăng ký
            </button>
        `;
    }
}

// ==========================================
// 5. ĐĂNG NHẬP / ĐĂNG KÝ
// ==========================================

function openAuth(mode) {
    authMode = mode;

    $('authModal').classList.remove('hidden');

    $('authHeading').textContent =
        mode === 'login' ? 'Đăng nhập' : 'Đăng ký tài khoản';

    $('nameLabel').classList.toggle(
        'hidden',
        mode === 'login'
    );

    $('switchAuth').textContent =
        mode === 'login'
            ? 'Chưa có tài khoản? Đăng ký'
            : 'Đã có tài khoản? Đăng nhập';

    $('password').value = '';
}

function closeAuth() {
    $('authModal').classList.add('hidden');
}

function switchAuth() {
    openAuth(authMode === 'login' ? 'register' : 'login');
}

async function submitAuth() {
    try {
        const username = $('username').value.trim();
        const password = $('password').value;

        if (!/^[a-zA-Z0-9]+$/.test(username)) {
            throw Error('Mã sinh viên chỉ gồm chữ và số.');
        }

        const body = {
            username,
            password,
            display_name: $('displayName').value.trim()
        };

        const data = await api('/auth/' + authMode, {
            method: 'POST',
            body
        });

        token = data.token;
        me = data.user;

        localStorage.setItem('vhb_token', token);
        localStorage.setItem('vhb_user', JSON.stringify(me));

        closeAuth();
        updateAccount();
        connectSocket();

        notify('Đăng nhập thành công.');

        loadRooms();

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 6. HỒ SƠ CÁ NHÂN
// ==========================================

async function openProfile() {
    if (!logged()) return;

    try {
        const data = await api('/profile');

        me = data.user;

        localStorage.setItem('vhb_user', JSON.stringify(me));

        $('profileUsername').value = me.username || '';
        $('profileName').value = me.display_name || '';

        $('profileAvatar').textContent =
            (me.display_name || '♡').charAt(0).toUpperCase();

        $('profileModal').classList.remove('hidden');

    } catch (error) {
        notify(error.message);
    }
}

function closeProfile() {
    $('profileModal').classList.add('hidden');
}

async function saveProfile() {
    try {
        const display_name = $('profileName').value.trim();

        if (!display_name) {
            throw Error('Vui lòng nhập họ tên.');
        }

        const data = await api('/profile', {
            method: 'PATCH',
            body: { display_name }
        });

        me = data.user;

        localStorage.setItem('vhb_user', JSON.stringify(me));

        updateAccount();

        $('profileAvatar').textContent =
            me.display_name.charAt(0).toUpperCase();

        notify('Đã cập nhật hồ sơ.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 7. ĐĂNG XUẤT
// ==========================================

function logout() {
    stopAudio();

    if (socket) {
        socket.disconnect();
        socket = null;
    }

    token = null;
    me = null;
    currentRoom = null;

    localStorage.removeItem('vhb_token');
    localStorage.removeItem('vhb_user');

    closeProfile();

    updateAccount();
    showExplore();
    loadRooms();

    notify('Đã đăng xuất.');
}

// ==========================================
// 8. ĐIỀU HƯỚNG
// ==========================================

function setNav(active) {
    $('navExplore').classList.toggle('active', active === 'explore');
    $('navRooms').classList.toggle('active', active === 'rooms');
}

function showExplore() {
    $('explore').classList.remove('hidden');
    $('myRooms').classList.add('hidden');
    $('roomView').classList.add('hidden');

    setNav('explore');

    if (currentRoom) {
        stopAudio();
        currentRoom = null;
    }

    loadRooms();
}

async function showMyRooms() {
    if (!logged()) return;

    if (currentRoom) {
        stopAudio();
        currentRoom = null;
    }

    $('explore').classList.add('hidden');
    $('myRooms').classList.remove('hidden');
    $('roomView').classList.add('hidden');

    setNav('rooms');

    try {
        const rooms = await api('/rooms');

        const mine = rooms.filter(r =>
            r.host_id == me.id
        );

        $('myRoomsList').innerHTML = mine.length
            ? mine.map(r => roomCard(r)).join('')
            : `<div class="empty-state">
                Bạn chưa tạo phòng nào.
                </div>`;

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 9. LỌC DANH MỤC
// ==========================================

function setCategory(value, element) {
    category = value;

    document.querySelectorAll('.chip').forEach(x => {
        x.classList.remove('active');
    });

    element.classList.add('active');

    loadRooms();
}

// ==========================================
// 10. HIỂN THỊ THẺ PHÒNG
// ==========================================

function roomCard(room) {
    return `
        <article class="card">

            <div class="live">● ĐANG MỞ</div>

            <h3>${escapeHtml(room.title)}</h3>

            <p>${escapeHtml(
                room.description || 'Phòng trò chuyện sinh viên VHB.'
            )}</p>

            <div class="card-foot">

                <small>
                    ${escapeHtml(room.category)}
                    · ${room.member_count || 0} người
                </small>

                <button class="btn secondary"
                        onclick="joinRoom(${room.id})">
                    Tham gia →
                </button>

            </div>

        </article>
    `;
}

// ==========================================
// 11. TẢI PHÒNG
// ==========================================

async function loadRooms() {
    try {
        let rooms = await api('/rooms');

        const keyword = ($('search').value || '').toLowerCase();

        rooms = rooms.filter(r => {
            const matchCategory =
                category === 'Tất cả' || r.category === category;

            const matchSearch =
                (r.title + ' ' + (r.description || ''))
                .toLowerCase()
                .includes(keyword);

            return matchCategory && matchSearch;
        });

        $('roomCount').textContent = rooms.length;

        $('roomsList').innerHTML = rooms.length
            ? rooms.map(roomCard).join('')
            : `<div class="empty-state">
                Chưa có phòng phù hợp.
                Hãy tạo phòng mới nhé!
               </div>`;

    } catch (error) {
        $('roomsList').innerHTML = `
            <div class="empty-state">
                Không tải được danh sách phòng.
                Kiểm tra máy chủ và cơ sở dữ liệu.
            </div>
        `;
    }
}

// ==========================================
// 12. MODAL TẠO PHÒNG
// ==========================================

function createRoomPrompt() {
    if (!logged()) return;

    $('roomTitle').value = '';
    $('roomDescription').value = '';

    selectedTopic = 'Học tập';

    document.querySelectorAll('.topic-option').forEach(button => {
        button.classList.toggle(
            'active',
            button.dataset.category === selectedTopic
        );
    });

    $('createRoomModal').classList.remove('hidden');
}

function closeCreateRoom() {
    $('createRoomModal').classList.add('hidden');
}

function selectTopic(element) {
    document.querySelectorAll('.topic-option').forEach(button => {
        button.classList.remove('active');
    });

    element.classList.add('active');

    selectedTopic = element.dataset.category;
}

async function submitCreateRoom() {
    try {
        const title = $('roomTitle').value.trim();
        const description = $('roomDescription').value.trim();

        if (!title) {
            throw Error('Vui lòng nhập tên phòng.');
        }

        $('createRoomButton').disabled = true;

        const result = await api('/rooms', {
            method: 'POST',
            body: {
                title,
                description,
                category: selectedTopic
            }
        });

        closeCreateRoom();

        notify('Tạo phòng thành công.');

        await loadRooms();

        await joinRoom(result.id);

    } catch (error) {
        notify(error.message);
    } finally {
        $('createRoomButton').disabled = false;
    }
}

// ==========================================
// 13. THAM GIA PHÒNG
// ==========================================

async function joinRoom(id) {
    if (!logged()) return;

    try {
        const result = await api(`/rooms/${id}/join`, {
            method: 'POST'
        });

        if (result.status === 'pending') {
            notify('Đã gửi yêu cầu. Chờ chủ phòng duyệt nhé!');
            return;
        }

        if (result.status === 'joined') {
            currentRoom = id;

            if (socket) {
                socket.emit('room:join', id);
            }

            await renderRoom();

            return;
        }

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 14. HIỂN THỊ PHÒNG
// ==========================================

async function renderRoom() {
    try {
        const room = await api(`/rooms/${currentRoom}`);

        const host = room.host_id == me.id;

        $('explore').classList.add('hidden');
        $('myRooms').classList.add('hidden');
        $('roomView').classList.remove('hidden');

        setNav('rooms');

        $('roomView').innerHTML = `

            <div class="section-head">

                <div>
                    <button class="btn secondary"
                            onclick="leaveRoom()">
                        ← Rời phòng
                    </button>

                    <h2>${escapeHtml(room.title)}</h2>

                    <p>
                        ${escapeHtml(room.category)}
                        · Chủ phòng:
                        ${escapeHtml(room.host_name)}
                    </p>
                </div>

                ${host ? `
                    <button class="btn secondary"
                            onclick="closeRoom()">
                        Đóng phòng
                    </button>
                ` : ''}

            </div>

            <div class="room-layout">

                <div class="panel">

                    <div class="stage">

                        <div class="mic">🎙️</div>

                        <h3>Trò chuyện Live Audio</h3>

                        <p id="audioStatus">
                            ${host
                                ? 'Bạn là chủ phòng và có quyền bật micro.'
                                : 'Bạn cần được chủ phòng duyệt trước khi bật micro.'}
                        </p>

                    </div>

                    <button class="btn primary"
                            id="micButton"
                            onclick="requestMic()">
                        ${host ? 'Bật micro' : 'Xin bật micro'}
                    </button>

                    <div class="chat" id="chat">

                        ${room.messages.map(m => `
                            <p>
                                <b>${escapeHtml(m.display_name)}:</b>

                                ${String(m.content).startsWith('/uploads/')
                                    ? `<img src="${escapeHtml(m.content)}" alt="Hình ảnh">`
                                    : escapeHtml(m.content)}
                            </p>
                        `).join('')}

                    </div>

                    <div class="chat-form">

                        <input class="chat-input"
                               id="message"
                               placeholder="Nhập tin nhắn..."
                               onkeydown="if(event.key==='Enter')sendMessage()">

                        <button class="btn primary"
                                onclick="sendMessage()">
                            Gửi
                        </button>

                        <label class="btn secondary" for="photo">
                            Ảnh
                        </label>

                        <input id="photo"
                               type="file"
                               accept="image/*"
                               hidden
                               onchange="sendPhoto()">

                    </div>

                    <audio id="remoteAudio" class="audio-player"
                           autoplay></audio>

                    <div id="remoteAudios"></div>

                </div>

                <div class="panel">

                    <h3>Người tham gia (${room.members.length})</h3>

                    <div id="membersList">

                        ${room.members.map(m => `
                            <div class="member">
                                <span>
                                    ${escapeHtml(m.display_name)}
                                    ${m.id == room.host_id ? '👑' : ''}
                                </span>

                                ${host && m.id != me.id ? `
                                    <button class="btn secondary"
                                            onclick="kick(${m.id})">
                                        Mời ra
                                    </button>
                                ` : ''}
                            </div>
                        `).join('')}

                    </div>

                    ${host ? `
                        <hr>

                        <h3>Yêu cầu tham gia phòng</h3>
                        <div id="joinRequests" class="mic-requests">
                            Đang tải...
                        </div>

                        <hr>

                        <h3>Yêu cầu bật micro</h3>
                        <div id="micRequests" class="mic-requests">
                            Đang tải...
                        </div>
                    ` : `
                        <hr>
                        <p class="mic-requests">
                            Chủ phòng sẽ duyệt yêu cầu tham gia và bật micro của bạn.
                        </p>
                    `}

                </div>

            </div>
        `;

        micStatus = await getMicStatus();

        updateMicButton();

        if (host) {
            loadJoinRequests();
            loadMicRequests();
        }

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 15. CẬP NHẬT NÚT MICRO
// ==========================================

async function getMicStatus() {
    const data = await api(`/rooms/${currentRoom}/mic-status`);
    return data.status;
}

function updateMicButton() {
    const button = $('micButton');

    if (!button) return;

    if (localStream) {
        button.textContent = 'Tắt micro';
        button.onclick = stopAudio;
        return;
    }

    if (micStatus === 'approved') {
        button.textContent = 'Bật micro';
        button.onclick = startAudio;
    } else if (micStatus === 'pending') {
        button.textContent = 'Đang chờ duyệt';
        button.onclick = requestMic;
    } else if (micStatus === 'rejected') {
        button.textContent = 'Xin bật micro lại';
        button.onclick = requestMic;
    } else {
        button.textContent = 'Xin bật micro';
        button.onclick = requestMic;
    }
}

// ==========================================
// 16. XIN BẬT MICRO
// ==========================================

async function requestMic() {
    try {
        if (micStatus === 'approved') {
            return startAudio();
        }

        await api(`/rooms/${currentRoom}/mic-requests`, {
            method: 'POST'
        });

        micStatus = 'pending';

        updateMicButton();

        notify('Đã gửi yêu cầu bật micro.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 17. CHỦ PHÒNG DUYỆT MICRO
// ==========================================

async function loadMicRequests() {
    try {
        const rows = await api(`/rooms/${currentRoom}/mic-requests`);

        const element = $('micRequests');

        if (!element) return;

        element.innerHTML = rows.length
            ? rows.map(x => `
                <div class="member">

                    <span>${escapeHtml(x.display_name)}</span>

                    <span>
                        <button class="btn primary"
                                onclick="decideMic(${x.id},'approved')">
                            Cho phép
                        </button>

                        <button class="btn secondary"
                                onclick="decideMic(${x.id},'rejected')">
                            Từ chối
                        </button>
                    </span>

                </div>
            `).join('')
            : 'Chưa có yêu cầu.';

    } catch (error) {
        notify(error.message);
    }
}

async function decideMic(id, status) {
    try {
        await api(`/rooms/${currentRoom}/mic-requests/${id}`, {
            method: 'PATCH',
            body: { status }
        });

        loadMicRequests();

        notify('Đã xử lý yêu cầu micro.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 18. CHỦ PHÒNG DUYỆT THAM GIA
// ==========================================

async function loadJoinRequests() {
    try {
        const rows = await api(`/rooms/${currentRoom}/join-requests`);

        const element = $('joinRequests');

        if (!element) return;

        element.innerHTML = rows.length
            ? rows.map(x => `
                <div class="member">

                    <span>${escapeHtml(x.display_name)}</span>

                    <span>
                        <button class="btn primary"
                                onclick="decideJoin(${x.id},'approved')">
                            Duyệt
                        </button>

                        <button class="btn secondary"
                                onclick="decideJoin(${x.id},'rejected')">
                            Từ chối
                        </button>
                    </span>

                </div>
            `).join('')
            : 'Chưa có yêu cầu tham gia.';

    } catch (error) {
        notify(error.message);
    }
}

async function decideJoin(id, status) {
    try {
        await api(`/rooms/${currentRoom}/join-requests/${id}`, {
            method: 'PATCH',
            body: { status }
        });

        loadJoinRequests();
        renderRoom();

        notify(status === 'approved'
            ? 'Đã duyệt thành viên.'
            : 'Đã từ chối thành viên.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 19. MỜI THÀNH VIÊN RA
// ==========================================

async function kick(id) {
    if (!confirm('Bạn có chắc muốn mời thành viên này ra khỏi phòng?')) {
        return;
    }

    try {
        await api(`/rooms/${currentRoom}/members/${id}`, {
            method: 'DELETE'
        });

        renderRoom();

        notify('Đã mời thành viên ra khỏi phòng.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 20. ĐÓNG PHÒNG
// ==========================================

async function closeRoom() {
    if (!confirm('Bạn có chắc muốn đóng phòng này?')) {
        return;
    }

    try {
        const oldRoom = currentRoom;

        stopAudio();

        await api(`/rooms/${oldRoom}`, {
            method: 'DELETE'
        });

        if (socket) {
            socket.emit('room:leave', oldRoom);
        }

        currentRoom = null;

        showExplore();

        notify('Đã đóng phòng.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 21. RỜI PHÒNG
// ==========================================

async function leaveRoom() {
    const oldRoom = currentRoom;

    if (!oldRoom) return;

    stopAudio();

    try {
        await api(`/rooms/${oldRoom}/leave`, {
            method: 'POST'
        });
    } catch (error) {
        // Vẫn rời giao diện nếu phòng đã đóng.
    }

    if (socket) {
        socket.emit('room:leave', oldRoom);
    }

    currentRoom = null;

    showExplore();
}

// ==========================================
// 22. GỬI TIN NHẮN
// ==========================================

async function sendMessage() {
    const element = $('message');
    const content = element.value.trim();

    if (!content || !currentRoom) return;

    try {
        await api(`/rooms/${currentRoom}/messages`, {
            method: 'POST',
            body: { content }
        });

        element.value = '';

        renderRoom();

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 23. GỬI HÌNH ẢNH
// ==========================================

async function sendPhoto() {
    const file = $('photo').files[0];

    if (!file) return;

    if (!file.type.startsWith('image/')) {
        notify('Vui lòng chọn hình ảnh.');
        return;
    }

    const form = new FormData();

    form.append('image', file);

    try {
        await api(`/rooms/${currentRoom}/messages`, {
            method: 'POST',
            body: form
        });

        $('photo').value = '';

        renderRoom();

        notify('Đã gửi hình ảnh.');

    } catch (error) {
        notify(error.message);
    }
}

// ==========================================
// 24. WEBRTC - BẬT MICRO
// ==========================================

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

async function startAudio() {
    try {
        if (localStream) return;

        if (micStatus !== 'approved') {
            notify('Bạn chưa được chủ phòng duyệt micro.');
            return;
        }

        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });

        if (!socket || !currentRoom) {
            stopAudio();
            return;
        }

        socket.emit('audio:start', {
            roomId: currentRoom
        });

        $('audioStatus').textContent = 'Micro đang hoạt động 🎙️';

        updateMicButton();

        notify('Đã bật micro.');

    } catch (error) {
        localStream = null;

        notify('Không thể bật micro. Hãy kiểm tra quyền truy cập micro.');
    }
}

// ==========================================
// 25. WEBRTC - TẮT MICRO
// ==========================================

function stopAudio() {
    if (socket && currentRoom) {
        socket.emit('audio:stop', {
            roomId: currentRoom
        });
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    Object.keys(peers).forEach(id => {
        peers[id].close();
        delete peers[id];
    });

    const audioContainer = $('remoteAudios');

    if (audioContainer) {
        audioContainer.innerHTML = '';
    }

    const audioStatus = $('audioStatus');

    if (audioStatus) {
        audioStatus.textContent = 'Micro đã tắt.';
    }

    updateMicButton();
}

// ==========================================
// 26. TẠO KẾT NỐI PEER
// ==========================================

async function makeOffer(peerId) {
    if (!localStream || !socket || !currentRoom) return;

    const pc = new RTCPeerConnection(rtcConfig);

    peers[peerId] = pc;

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('audio:ice-candidate', {
                to: peerId,
                roomId: currentRoom,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = event => {
        addRemoteAudio(peerId, event.streams[0]);
    };

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    socket.emit('audio:offer', {
        to: peerId,
        roomId: currentRoom,
        offer
    });
}

function addRemoteAudio(peerId, stream) {
    let audio = document.getElementById('audio-' + peerId);

    if (!audio) {
        audio = document.createElement('audio');

        audio.id = 'audio-' + peerId;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.className = 'audio-player';

        $('remoteAudios')?.appendChild(audio);
    }

    audio.srcObject = stream;

    audio.play().catch(() => {
        notify('Hãy tương tác với trang để cho phép phát âm thanh.');
    });
}

// ==========================================
// 27. SOCKET.IO
// ==========================================

function connectSocket() {
    if (!token) return;

    if (socket) {
        socket.disconnect();
    }

    socket = io({
        auth: { token }
    });

    socket.on('connect_error', error => {
        console.error('Socket:', error.message);
    });

    socket.on('message:new', data => {
        if (currentRoom && data.room_id == currentRoom) {
            renderRoom();
        }
    });

    socket.on('members:changed', () => {
        if (currentRoom) {
            renderRoom();
        }
    });

    socket.on('join:request', data => {
        if (currentRoom == data.roomId) {
            loadJoinRequests();
            notify('Có sinh viên xin tham gia phòng.');
        }
    });

    socket.on('join:decision', data => {
        if (data.status === 'approved') {
            notify('Chủ phòng đã duyệt yêu cầu tham gia.');

            joinRoom(data.roomId);
        } else {
            notify('Yêu cầu tham gia phòng đã bị từ chối.');
        }
    });

    socket.on('mic:request', data => {
        if (currentRoom == data.roomId) {
            loadMicRequests();
            notify('Có yêu cầu bật micro mới.');
        }
    });

    socket.on('mic:decision', data => {
        if (data.roomId == currentRoom) {
            micStatus = data.status;

            updateMicButton();

            notify(data.status === 'approved'
                ? 'Chủ phòng đã cho phép bật micro.'
                : 'Yêu cầu bật micro bị từ chối.');
        }
    });

    socket.on('removed:from-room', data => {
        if (data.roomId == currentRoom) {
            stopAudio();

            currentRoom = null;

            showExplore();

            notify('Chủ phòng đã mời bạn ra khỏi phòng.');
        }
    });

    socket.on('room:closed', () => {
        stopAudio();

        currentRoom = null;

        showExplore();

        notify('Phòng đã đóng.');
    });

    // Người mới bắt đầu phát âm thanh
    socket.on('audio:peer-ready', async data => {
        if (localStream) {
            await makeOffer(data.from);
        }
    });

    // Nhận danh sách người đang phát
    socket.on('audio:existing-peers', async data => {
        for (const peerId of data.peers) {
            if (localStream) {
                await makeOffer(peerId);
            }
        }
    });

    // Nhận Offer
    socket.on('audio:offer', async data => {
        if (!localStream || !currentRoom) return;

        try {
            let pc = peers[data.from];

            if (!pc) {
                pc = new RTCPeerConnection(rtcConfig);
                peers[data.from] = pc;

                localStream.getTracks().forEach(track => {
                    pc.addTrack(track, localStream);
                });

                pc.onicecandidate = event => {
                    if (event.candidate) {
                        socket.emit('audio:ice-candidate', {
                            to: data.from,
                            roomId: currentRoom,
                            candidate: event.candidate
                        });
                    }
                };

                pc.ontrack = event => {
                    addRemoteAudio(data.from, event.streams[0]);
                };
            }

            await pc.setRemoteDescription(
                new RTCSessionDescription(data.offer)
            );

            const answer = await pc.createAnswer();

            await pc.setLocalDescription(answer);

            socket.emit('audio:answer', {
                to: data.from,
                roomId: currentRoom,
                answer
            });

        } catch (error) {
            console.error('WebRTC offer:', error);
        }
    });

    // Nhận Answer
    socket.on('audio:answer', async data => {
        const pc = peers[data.from];

        if (!pc) return;

        try {
            await pc.setRemoteDescription(
                new RTCSessionDescription(data.answer)
            );
        } catch (error) {
            console.error('WebRTC answer:', error);
        }
    });

    // Nhận ICE Candidate
    socket.on('audio:ice-candidate', async data => {
        const pc = peers[data.from];

        if (!pc) return;

        try {
            await pc.addIceCandidate(
                new RTCIceCandidate(data.candidate)
            );
        } catch (error) {
            console.error('ICE:', error);
        }
    });

    // Người khác tắt micro
    socket.on('audio:peer-left', data => {
        if (peers[data.from]) {
            peers[data.from].close();
            delete peers[data.from];
        }

        const audio = $('audio-' + data.from);

        if (audio) {
            audio.remove();
        }
    });

    socket.on('audio:error', data => {
        notify(data.message);
    });
}

// ==========================================
// 28. LÀM SẠCH HTML
// ==========================================

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]
    );
}

// ==========================================
// 29. KHỞI TẠO
// ==========================================

updateAccount();

if (token && me) {
    connectSocket();
}

loadRooms();
