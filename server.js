
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const pool = require('./database');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'vhb_connect_secret_change_this';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN,
        methods: ['GET', 'POST', 'PATCH', 'DELETE']
    }
});

app.use(cors({
    origin: CLIENT_ORIGIN === '*' ? true : CLIENT_ORIGIN
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. THƯ MỤC VÀ FILE TĨNH
// ==========================================

const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(publicDir, 'uploads');

if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadDir));

// ==========================================
// 2. UPLOAD HÌNH ẢNH
// ==========================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = crypto.randomBytes(16).toString('hex');

        cb(null, name + ext);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 5 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Chỉ được gửi hình ảnh.'));
        }

        cb(null, true);
    }
});

// ==========================================
// 3. KHỞI TẠO BẢNG YÊU CẦU THAM GIA
// ==========================================

async function ensureTables() {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS room_join_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id INT NOT NULL,
            user_id INT NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            UNIQUE KEY unique_join_request (room_id, user_id),

            FOREIGN KEY (room_id)
                REFERENCES rooms(id)
                ON DELETE CASCADE,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);
}

// ==========================================
// 4. HÀM HỖ TRỢ
// ==========================================

function createToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username
        },
        JWT_SECRET,
        {
            expiresIn: '7d'
        }
    );
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar: user.avatar || null
    };
}

function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

async function isMember(roomId, userId) {
    const [rows] = await pool.execute(
        `SELECT id
         FROM room_members
         WHERE room_id = ? AND user_id = ?`,
        [roomId, userId]
    );

    return rows.length > 0;
}

async function isHost(roomId, userId) {
    const [rows] = await pool.execute(
        `SELECT id
         FROM rooms
         WHERE id = ? AND host_id = ?`,
        [roomId, userId]
    );

    return rows.length > 0;
}

async function hasMicPermission(roomId, userId) {
    if (await isHost(roomId, userId)) {
        return true;
    }

    const [rows] = await pool.execute(
        `SELECT id
         FROM mic_requests
         WHERE room_id = ?
           AND user_id = ?
           AND status = 'approved'`,
        [roomId, userId]
    );

    return rows.length > 0;
}

async function getRoom(roomId) {
    const [rows] = await pool.execute(
        `SELECT *
         FROM rooms
         WHERE id = ?`,
        [roomId]
    );

    return rows[0] || null;
}

function roomChannel(roomId) {
    return 'room_' + roomId;
}

function userChannel(userId) {
    return 'user_' + userId;
}

// ==========================================
// 5. XÁC THỰC JWT
// ==========================================

async function auth(req, res, next) {
    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith('Bearer ')) {
            return res.status(401).json({
                message: 'Vui lòng đăng nhập.'
            });
        }

        const token = header.split(' ')[1];

        const decoded = jwt.verify(token, JWT_SECRET);

        const [users] = await pool.execute(
            `SELECT id, username, display_name, avatar
             FROM users
             WHERE id = ?`,
            [decoded.id]
        );

        if (!users.length) {
            return res.status(401).json({
                message: 'Tài khoản không tồn tại.'
            });
        }

        req.user = users[0];

        next();

    } catch (error) {
        return res.status(401).json({
            message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.'
        });
    }
}

// ==========================================
// 6. ĐĂNG KÝ
// ==========================================

app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const {
        username,
        display_name,
        password
    } = req.body;

    if (!username || !display_name || !password) {
        return res.status(400).json({
            message: 'Vui lòng nhập đầy đủ thông tin.'
        });
    }

    if (!/^[a-zA-Z0-9]+$/.test(username.trim())) {
        return res.status(400).json({
            message: 'Mã sinh viên chỉ gồm chữ và số.'
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            message: 'Mật khẩu phải có ít nhất 6 ký tự.'
        });
    }

    if (display_name.trim().length > 80) {
        return res.status(400).json({
            message: 'Tên hiển thị tối đa 80 ký tự.'
        });
    }

    const [existing] = await pool.execute(
        `SELECT id
         FROM users
         WHERE username = ?`,
        [username.trim()]
    );

    if (existing.length) {
        return res.status(409).json({
            message: 'Mã sinh viên đã được đăng ký.'
        });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await pool.execute(
        `INSERT INTO users
         (username, display_name, password_hash)
         VALUES (?, ?, ?)`,
        [
            username.trim(),
            display_name.trim(),
            passwordHash
        ]
    );

    const user = {
        id: result.insertId,
        username: username.trim(),
        display_name: display_name.trim(),
        avatar: null
    };

    res.status(201).json({
        message: 'Đăng ký thành công.',
        token: createToken(user),
        user: publicUser(user)
    });
}));

// ==========================================
// 7. ĐĂNG NHẬP
// ==========================================

app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const {
        username,
        password
    } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            message: 'Vui lòng nhập mã sinh viên và mật khẩu.'
        });
    }

    const [rows] = await pool.execute(
        `SELECT *
         FROM users
         WHERE username = ?`,
        [username.trim()]
    );

    if (!rows.length) {
        return res.status(401).json({
            message: 'Mã sinh viên hoặc mật khẩu không chính xác.'
        });
    }

    const user = rows[0];

    const valid = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!valid) {
        return res.status(401).json({
            message: 'Mã sinh viên hoặc mật khẩu không chính xác.'
        });
    }

    res.json({
        message: 'Đăng nhập thành công.',
        token: createToken(user),
        user: publicUser(user)
    });
}));

// ==========================================
// 8. HỒ SƠ CÁ NHÂN
// ==========================================

// Lấy hồ sơ
app.get('/api/profile', auth, asyncRoute(async (req, res) => {
    res.json({
        user: publicUser(req.user)
    });
}));

// Cập nhật tên hiển thị
app.patch('/api/profile', auth, asyncRoute(async (req, res) => {
    const displayName = String(
        req.body.display_name || ''
    ).trim();

    if (!displayName) {
        return res.status(400).json({
            message: 'Tên hiển thị không được để trống.'
        });
    }

    if (displayName.length > 80) {
        return res.status(400).json({
            message: 'Tên hiển thị tối đa 80 ký tự.'
        });
    }

    await pool.execute(
        `UPDATE users
         SET display_name = ?
         WHERE id = ?`,
        [displayName, req.user.id]
    );

    const [rows] = await pool.execute(
        `SELECT id, username, display_name, avatar
         FROM users
         WHERE id = ?`,
        [req.user.id]
    );

    res.json({
        message: 'Cập nhật hồ sơ thành công.',
        user: publicUser(rows[0])
    });
}));

// ==========================================
// 9. DANH SÁCH PHÒNG TRÒ CHUYỆN
// ==========================================

app.get('/api/rooms', asyncRoute(async (req, res) => {
    const [rooms] = await pool.execute(`
        SELECT
            r.id,
            r.title,
            r.description,
            r.category,
            r.host_id,
            r.created_at,
            u.display_name AS host_name,
            COUNT(rm.user_id) AS member_count

        FROM rooms r

        JOIN users u
            ON u.id = r.host_id

        LEFT JOIN room_members rm
            ON rm.room_id = r.id

        GROUP BY
            r.id,
            r.title,
            r.description,
            r.category,
            r.host_id,
            r.created_at,
            u.display_name

        ORDER BY r.created_at DESC
    `);

    res.json(rooms);
}));

// ==========================================
// 10. TẠO PHÒNG LIVE AUDIO
// ==========================================

app.post('/api/rooms', auth, asyncRoute(async (req, res) => {
    const {
        title,
        description,
        category
    } = req.body;

    const validCategories = [
        'Học tập',
        'Âm nhạc',
        'Đời sống',
        'Giải trí'
    ];

    if (!title || !title.trim()) {
        return res.status(400).json({
            message: 'Vui lòng nhập tên phòng.'
        });
    }

    if (title.trim().length > 100) {
        return res.status(400).json({
            message: 'Tên phòng tối đa 100 ký tự.'
        });
    }

    if (!validCategories.includes(category)) {
        return res.status(400).json({
            message: 'Vui lòng chọn chủ đề hợp lệ.'
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `INSERT INTO rooms
             (title, description, category, host_id)
             VALUES (?, ?, ?, ?)`,
            [
                title.trim(),
                String(description || '').trim(),
                category,
                req.user.id
            ]
        );

        const roomId = result.insertId;

        // Chủ phòng tự động trở thành thành viên
        await connection.execute(
            `INSERT INTO room_members
             (room_id, user_id)
             VALUES (?, ?)`,
            [roomId, req.user.id]
        );

        await connection.commit();

        res.status(201).json({
            message: 'Tạo phòng thành công.',
            id: roomId
        });

    } catch (error) {
        await connection.rollback();
        throw error;

    } finally {
        connection.release();
    }
}));

// ==========================================
// 11. CHI TIẾT PHÒNG
// ==========================================

app.get('/api/rooms/:id', auth, asyncRoute(async (req, res) => {
    const roomId = Number(req.params.id);

    const room = await getRoom(roomId);

    if (!room) {
        return res.status(404).json({
            message: 'Phòng không tồn tại.'
        });
    }

    if (!await isMember(roomId, req.user.id)) {
        return res.status(403).json({
            message: 'Bạn chưa được tham gia phòng này.'
        });
    }

    const [hostRows] = await pool.execute(
        `SELECT display_name
         FROM users
         WHERE id = ?`,
        [room.host_id]
    );

    const [members] = await pool.execute(
        `SELECT
            u.id,
            u.username,
            u.display_name,
            u.avatar

         FROM room_members rm

         JOIN users u
            ON u.id = rm.user_id

         WHERE rm.room_id = ?

         ORDER BY rm.joined_at ASC`,
        [roomId]
    );

    const [messages] = await pool.execute(
        `SELECT
            m.id,
            m.content,
            m.created_at,
            u.id AS user_id,
            u.display_name,
            u.avatar

         FROM messages m

         JOIN users u
            ON u.id = m.user_id

         WHERE m.room_id = ?

         ORDER BY m.created_at ASC
         LIMIT 200`,
        [roomId]
    );

    res.json({
        ...room,
        host_name: hostRows[0]?.display_name || '',
        members,
        messages
    });
}));

// ==========================================
// 12. GỬI YÊU CẦU THAM GIA PHÒNG
// ==========================================

app.post('/api/rooms/:id/join', auth, asyncRoute(async (req, res) => {
    const roomId = Number(req.params.id);

    const room = await getRoom(roomId);

    if (!room) {
        return res.status(404).json({
            message: 'Phòng không tồn tại.'
        });
    }

    if (await isMember(roomId, req.user.id)) {
        return res.json({
            message: 'Bạn đã ở trong phòng.',
            status: 'joined'
        });
    }

    // Gửi lại yêu cầu nếu trước đó đã bị từ chối
    await pool.execute(
        `INSERT INTO room_join_requests
         (room_id, user_id, status)
         VALUES (?, ?, 'pending')

         ON DUPLICATE KEY UPDATE
            status = 'pending',
            created_at = CURRENT_TIMESTAMP`,
        [roomId, req.user.id]
    );

    io.to(userChannel(room.host_id)).emit(
        'join:request',
        {
            roomId,
            userId: req.user.id,
            display_name: req.user.display_name
        }
    );

    res.json({
        message: 'Đã gửi yêu cầu. Vui lòng chờ chủ phòng duyệt.',
        status: 'pending'
    });
}));

// ==========================================
// 13. CHỦ PHÒNG XEM YÊU CẦU THAM GIA
// ==========================================

app.get('/api/rooms/:id/join-requests', auth, asyncRoute(async (req, res) => {
    const roomId = Number(req.params.id);

    if (!await isHost(roomId, req.user.id)) {
        return res.status(403).json({
            message: 'Chỉ chủ phòng mới có quyền xem.'
        });
    }

    const [rows] = await pool.execute(
        `SELECT
            jr.id,
            jr.user_id,
            jr.status,
            jr.created_at,
            u.username,
            u.display_name,
            u.avatar

         FROM room_join_requests jr

         JOIN users u
            ON u.id = jr.user_id

         WHERE jr.room_id = ?
           AND jr.status = 'pending'

         ORDER BY jr.created_at ASC`,
        [roomId]
    );

    res.json(rows);
}));

// ==========================================
// 14. CHỦ PHÒNG DUYỆT YÊU CẦU THAM GIA
// ==========================================

app.patch(
    '/api/rooms/:id/join-requests/:requestId',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);
        const requestId = Number(req.params.requestId);

        const status = req.body.status;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                message: 'Trạng thái không hợp lệ.'
            });
        }

        if (!await isHost(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Chỉ chủ phòng mới được duyệt.'
            });
        }

        const [requests] = await pool.execute(
            `SELECT *
             FROM room_join_requests
             WHERE id = ?
               AND room_id = ?
               AND status = 'pending'`,
            [requestId, roomId]
        );

        if (!requests.length) {
            return res.status(404).json({
                message: 'Yêu cầu không tồn tại hoặc đã được xử lý.'
            });
        }

        const request = requests[0];

        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            await connection.execute(
                `UPDATE room_join_requests
                 SET status = ?
                 WHERE id = ?`,
                [status, requestId]
            );

            if (status === 'approved') {
                await connection.execute(
                    `INSERT IGNORE INTO room_members
                     (room_id, user_id)
                     VALUES (?, ?)`,
                    [roomId, request.user_id]
                );
            }

            await connection.commit();

        } catch (error) {
            await connection.rollback();
            throw error;

        } finally {
            connection.release();
        }

        io.to(userChannel(request.user_id)).emit(
            'join:decision',
            {
                roomId,
                status
            }
        );

        io.to(roomChannel(roomId)).emit('members:changed');

        res.json({
            message: status === 'approved'
                ? 'Đã duyệt thành viên.'
                : 'Đã từ chối yêu cầu.',
            status
        });
    })
);

// ==========================================
// 15. RỜI PHÒNG
// ==========================================

app.post('/api/rooms/:id/leave', auth, asyncRoute(async (req, res) => {
    const roomId = Number(req.params.id);

    if (await isHost(roomId, req.user.id)) {
        return res.status(400).json({
            message: 'Chủ phòng cần đóng phòng thay vì rời phòng.'
        });
    }

    await pool.execute(
        `DELETE FROM room_members
         WHERE room_id = ? AND user_id = ?`,
        [roomId, req.user.id]
    );

    await pool.execute(
        `DELETE FROM mic_requests
         WHERE room_id = ? AND user_id = ?`,
        [roomId, req.user.id]
    );

    io.to(roomChannel(roomId)).emit('members:changed');

    res.json({
        message: 'Đã rời phòng.'
    });
}));

// ==========================================
// 16. CHỦ PHÒNG MỜI THÀNH VIÊN RA
// ==========================================

app.delete(
    '/api/rooms/:id/members/:userId',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);
        const targetId = Number(req.params.userId);

        if (!await isHost(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Chỉ chủ phòng mới có quyền mời thành viên.'
            });
        }

        if (targetId === req.user.id) {
            return res.status(400).json({
                message: 'Không thể tự mời mình ra khỏi phòng.'
            });
        }

        await pool.execute(
            `DELETE FROM room_members
             WHERE room_id = ? AND user_id = ?`,
            [roomId, targetId]
        );

        await pool.execute(
            `DELETE FROM mic_requests
             WHERE room_id = ? AND user_id = ?`,
            [roomId, targetId]
        );

        io.to(userChannel(targetId)).emit(
            'removed:from-room',
            {
                roomId
            }
        );

        io.to(roomChannel(roomId)).emit('members:changed');

        res.json({
            message: 'Đã mời thành viên ra khỏi phòng.'
        });
    })
);

// ==========================================
// 17. CHỦ PHÒNG ĐÓNG PHÒNG
// ==========================================

app.delete('/api/rooms/:id', auth, asyncRoute(async (req, res) => {
    const roomId = Number(req.params.id);

    if (!await isHost(roomId, req.user.id)) {
        return res.status(403).json({
            message: 'Chỉ chủ phòng mới được đóng phòng.'
        });
    }

    io.to(roomChannel(roomId)).emit('room:closed', {
        roomId
    });

    await pool.execute(
        `DELETE FROM rooms
         WHERE id = ?`,
        [roomId]
    );

    res.json({
        message: 'Đã đóng phòng.'
    });
}));

// ==========================================
// 18. GỬI TIN NHẮN VÀ HÌNH ẢNH
// ==========================================

app.post(
    '/api/rooms/:id/messages',
    auth,
    upload.single('image'),
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);

        if (!await isMember(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Bạn chưa tham gia phòng.'
            });
        }

        let content = '';

        if (req.file) {
            content = '/uploads/' + req.file.filename;
        } else {
            content = String(req.body.content || '').trim();
        }

        if (!content) {
            return res.status(400).json({
                message: 'Nội dung tin nhắn không được để trống.'
            });
        }

        if (!req.file && content.length > 5000) {
            return res.status(400).json({
                message: 'Tin nhắn tối đa 5000 ký tự.'
            });
        }

        const [result] = await pool.execute(
            `INSERT INTO messages
             (room_id, user_id, content)
             VALUES (?, ?, ?)`,
            [roomId, req.user.id, content]
        );

        const message = {
            id: result.insertId,
            room_id: roomId,
            user_id: req.user.id,
            display_name: req.user.display_name,
            avatar: req.user.avatar,
            content,
            created_at: new Date()
        };

        io.to(roomChannel(roomId)).emit(
            'message:new',
            message
        );

        res.status(201).json({
            message: 'Đã gửi tin nhắn.',
            data: message
        });
    })
);

// ==========================================
// 19. GỬI YÊU CẦU BẬT MICRO
// ==========================================

app.post(
    '/api/rooms/:id/mic-requests',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);

        if (!await isMember(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Bạn chưa tham gia phòng.'
            });
        }

        if (await isHost(roomId, req.user.id)) {
            return res.json({
                message: 'Chủ phòng có quyền bật micro.',
                status: 'approved'
            });
        }

        await pool.execute(
            `INSERT INTO mic_requests
             (room_id, user_id, status)
             VALUES (?, ?, 'pending')

             ON DUPLICATE KEY UPDATE
                status = 'pending',
                created_at = CURRENT_TIMESTAMP`,
            [roomId, req.user.id]
        );

        const room = await getRoom(roomId);

        io.to(userChannel(room.host_id)).emit(
            'mic:request',
            {
                roomId,
                userId: req.user.id,
                display_name: req.user.display_name
            }
        );

        res.json({
            message: 'Đã gửi yêu cầu bật micro.',
            status: 'pending'
        });
    })
);

// ==========================================
// 20. KIỂM TRA TRẠNG THÁI MICRO
// ==========================================

app.get(
    '/api/rooms/:id/mic-status',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);

        if (!await isMember(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Bạn chưa ở trong phòng.'
            });
        }

        if (await isHost(roomId, req.user.id)) {
            return res.json({
                status: 'approved'
            });
        }

        const [rows] = await pool.execute(
            `SELECT status
             FROM mic_requests
             WHERE room_id = ?
               AND user_id = ?`,
            [roomId, req.user.id]
        );

        res.json({
            status: rows.length
                ? rows[0].status
                : 'none'
        });
    })
);

// ==========================================
// 21. CHỦ PHÒNG XEM YÊU CẦU MICRO
// ==========================================

app.get(
    '/api/rooms/:id/mic-requests',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);

        if (!await isHost(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Chỉ chủ phòng mới được xem.'
            });
        }

        const [rows] = await pool.execute(
            `SELECT
                mr.id,
                mr.user_id,
                mr.status,
                mr.created_at,
                u.display_name,
                u.username

             FROM mic_requests mr

             JOIN users u
                ON u.id = mr.user_id

             WHERE mr.room_id = ?
               AND mr.status = 'pending'

             ORDER BY mr.created_at ASC`,
            [roomId]
        );

        res.json(rows);
    })
);

// ==========================================
// 22. CHỦ PHÒNG DUYỆT MICRO
// ==========================================

app.patch(
    '/api/rooms/:id/mic-requests/:requestId',
    auth,
    asyncRoute(async (req, res) => {
        const roomId = Number(req.params.id);
        const requestId = Number(req.params.requestId);
        const status = req.body.status;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                message: 'Trạng thái không hợp lệ.'
            });
        }

        if (!await isHost(roomId, req.user.id)) {
            return res.status(403).json({
                message: 'Chỉ chủ phòng mới được duyệt micro.'
            });
        }

        const [rows] = await pool.execute(
            `SELECT *
             FROM mic_requests
             WHERE id = ?
               AND room_id = ?
               AND status = 'pending'`,
            [requestId, roomId]
        );

        if (!rows.length) {
            return res.status(404).json({
                message: 'Yêu cầu micro không tồn tại hoặc đã xử lý.'
            });
        }

        const request = rows[0];

        await pool.execute(
            `UPDATE mic_requests
             SET status = ?
             WHERE id = ?`,
            [status, requestId]
        );

        io.to(userChannel(request.user_id)).emit(
            'mic:decision',
            {
                roomId,
                status
            }
        );

        res.json({
            message: status === 'approved'
                ? 'Đã cho phép bật micro.'
                : 'Đã từ chối yêu cầu micro.',
            status
        });
    })
);

// ==========================================
// 23. SOCKET.IO - XÁC THỰC NGƯỜI DÙNG
// ==========================================

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error('Chưa đăng nhập.'));
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        socket.data.userId = decoded.id;

        next();

    } catch (error) {
        next(new Error('Token không hợp lệ.'));
    }
});

// Danh sách socket đang tham gia phát âm thanh
const audioPeers = new Map();

// ==========================================
// 24. SOCKET.IO - KẾT NỐI
// ==========================================

io.on('connection', async socket => {
    const userId = socket.data.userId;

    socket.join(userChannel(userId));

    console.log('Người dùng kết nối:', userId);

    // --------------------------------------
    // THAM GIA KÊNH PHÒNG
    // --------------------------------------

    socket.on('room:join', async roomId => {
        try {
            roomId = Number(roomId);

            if (!await isMember(roomId, userId)) {
                return;
            }

            socket.join(roomChannel(roomId));

        } catch (error) {
            console.error('room:join:', error.message);
        }
    });

    // --------------------------------------
    // RỜI KÊNH PHÒNG
    // --------------------------------------

    socket.on('room:leave', roomId => {
        roomId = Number(roomId);

        socket.leave(roomChannel(roomId));

        removeAudioPeer(socket, roomId);
    });

    // --------------------------------------
    // BẮT ĐẦU PHÁT LIVE AUDIO
    // --------------------------------------

    socket.on('audio:start', async data => {
        try {
            const roomId = Number(data.roomId);

            if (!await isMember(roomId, userId)) {
                return;
            }

            if (!await hasMicPermission(roomId, userId)) {
                socket.emit('audio:error', {
                    message: 'Bạn chưa được chủ phòng cho phép bật micro.'
                });

                return;
            }

            if (!audioPeers.has(roomId)) {
                audioPeers.set(roomId, new Map());
            }

            const peers = audioPeers.get(roomId);

            if (peers.has(socket.id)) {
                return;
            }

            // Lấy danh sách người đang phát âm thanh
            const existingPeers = [...peers.keys()];

            // Đăng ký người phát âm thanh
            peers.set(socket.id, userId);

            // Gửi danh sách peer hiện tại cho người mới
            socket.emit('audio:existing-peers', {
                peers: existingPeers
            });

            // Báo cho những người cũ biết có người mới
            existingPeers.forEach(peerId => {
                io.to(peerId).emit('audio:peer-ready', {
                    from: socket.id,
                    userId
                });
            });

            console.log(
                'Audio bắt đầu:',
                userId,
                'phòng:',
                roomId
            );

        } catch (error) {
            console.error('audio:start:', error.message);
        }
    });

    // --------------------------------------
    // GỬI OFFER WEBRTC
    // --------------------------------------

    socket.on('audio:offer', async data => {
        try {
            const roomId = Number(data.roomId);
            const target = data.to;

            const peers = audioPeers.get(roomId);

            if (!peers || !peers.has(socket.id)) {
                return;
            }

            if (!peers.has(target)) {
                return;
            }

            if (!await hasMicPermission(roomId, userId)) {
                return;
            }

            io.to(target).emit('audio:offer', {
                from: socket.id,
                offer: data.offer,
                roomId
            });

        } catch (error) {
            console.error('audio:offer:', error.message);
        }
    });

    // --------------------------------------
    // GỬI ANSWER WEBRTC
    // --------------------------------------

    socket.on('audio:answer', data => {
        const roomId = Number(data.roomId);
        const target = data.to;

        const peers = audioPeers.get(roomId);

        if (!peers) return;
        if (!peers.has(socket.id)) return;
        if (!peers.has(target)) return;

        io.to(target).emit('audio:answer', {
            from: socket.id,
            answer: data.answer,
            roomId
        });
    });

    // --------------------------------------
    // GỬI ICE CANDIDATE
    // --------------------------------------

    socket.on('audio:ice-candidate', data => {
        const roomId = Number(data.roomId);
        const target = data.to;

        const peers = audioPeers.get(roomId);

        if (!peers) return;
        if (!peers.has(socket.id)) return;
        if (!peers.has(target)) return;

        io.to(target).emit('audio:ice-candidate', {
            from: socket.id,
            candidate: data.candidate,
            roomId
        });
    });

    // --------------------------------------
    // DỪNG PHÁT AUDIO
    // --------------------------------------

    socket.on('audio:stop', data => {
        const roomId = Number(data.roomId);

        removeAudioPeer(socket, roomId);
    });

    // --------------------------------------
    // NGẮT KẾT NỐI
    // --------------------------------------

    socket.on('disconnect', () => {
        for (const roomId of audioPeers.keys()) {
            removeAudioPeer(socket, roomId);
        }

        console.log('Người dùng ngắt kết nối:', userId);
    });
});

// ==========================================
// 25. XÓA NGƯỜI PHÁT AUDIO KHỎI DANH SÁCH
// ==========================================

function removeAudioPeer(socket, roomId) {
    const peers = audioPeers.get(Number(roomId));

    if (!peers || !peers.has(socket.id)) {
        return;
    }

    peers.delete(socket.id);

    // Thông báo các peer còn lại
    for (const peerId of peers.keys()) {
        io.to(peerId).emit('audio:peer-left', {
            from: socket.id,
            roomId: Number(roomId)
        });
    }

    if (peers.size === 0) {
        audioPeers.delete(Number(roomId));
    }
}

// ==========================================
// 26. XỬ LÝ LỖI
// ==========================================

app.use((err, req, res, next) => {
    console.error(err);

    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            message: err.code === 'LIMIT_FILE_SIZE'
                ? 'Hình ảnh tối đa 5MB.'
                : 'Không thể tải hình ảnh.'
        });
    }

    res.status(500).json({
        message: err.message || 'Lỗi máy chủ.'
    });
});

// ==========================================
// 27. TRANG CHỦ
// ==========================================

app.get('/', (req, res) => {
    res.sendFile(
        path.join(publicDir, 'index.html')
    );
});

// ==========================================
// 28. KHỞI ĐỘNG SERVER
// ==========================================

async function startServer() {
    try {
        await pool.query('SELECT 1');

        console.log('MySQL kết nối thành công.');

        await ensureTables();

        console.log('Kiểm tra bảng dữ liệu thành công.');

        server.listen(PORT, () => {
            console.log('================================');
            console.log('       VHB CONNECT SERVER       ');
            console.log('================================');
            console.log(`Địa chỉ: http://localhost:${PORT}`);
            console.log('Socket.IO: Đang hoạt động');
            console.log('WebRTC Signaling: Sẵn sàng');
            console.log('================================');
        });

    } catch (error) {
        console.error('Không thể khởi động server:', error);
        process.exit(1);
    }
}

startServer();
