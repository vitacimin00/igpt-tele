import fs from 'fs';
import path from 'path';

class UserManager {
    constructor() {
        this.usersFile = 'data/users.json';
        this.ensureFile();
        this.migrateIfNeeded();
    }

    /**
     * Get today's date in WIB (UTC+7) timezone — YYYY-MM-DD
     */
    getTodayWIB() {
        const now = new Date();
        const wib = new Date(now.getTime() + (7 * 60 * 60 * 1000));
        return wib.toISOString().split('T')[0];
    }

    ensureFile() {
        if (!fs.existsSync('data')) {
            fs.mkdirSync('data', { recursive: true });
        }

        if (!fs.existsSync(this.usersFile)) {
            fs.writeFileSync(this.usersFile, JSON.stringify({ users: [] }, null, 2));
        }
    }

    /**
     * Migrate old WA format (phone: "tg_xxx", pushName) to Telegram format (telegramId, name)
     */
    migrateIfNeeded() {
        try {
            const raw = fs.readFileSync(this.usersFile, 'utf8');
            const data = JSON.parse(raw);
            if (!data.users || data.users.length === 0) return;

            // Check if migration needed (first user has 'phone' field)
            if (!data.users[0].phone) return;

            console.log('🔄 Migrasi database user: phone → telegramId...');
            data.users = data.users.map(user => {
                const telegramId = String(user.phone || '').replace('tg_', '');
                return {
                    telegramId,
                    name: user.pushName || user.name || 'Unknown',
                    username: user.username || null,
                    type: user.type || 'free',
                    dailyLimit: user.dailyLimit || 1,
                    usedToday: user.usedToday || 0,
                    totalInvites: user.totalInvites || 0,
                    lastReset: user.lastReset || this.getTodayWIB(),
                    createdAt: user.createdAt || new Date().toISOString(),
                    expiresAt: user.expiresAt || null
                };
            });

            fs.writeFileSync(this.usersFile, JSON.stringify(data, null, 2));
            console.log(`✅ Migrasi selesai: ${data.users.length} users`);
        } catch (e) {
            console.error('❌ Migrasi gagal:', e.message);
        }
    }

    loadUsers() {
        try {
            const data = fs.readFileSync(this.usersFile, 'utf8');
            const parsed = JSON.parse(data);
            // Deduplicate by telegramId
            const byId = new Map();
            let changed = false;
            for (const user of (parsed.users || [])) {
                if (!user || !user.telegramId) { changed = true; continue; }
                if (byId.has(user.telegramId)) { changed = true; continue; }
                byId.set(user.telegramId, user);
            }
            const result = { users: Array.from(byId.values()) };
            if (changed) this.saveUsers(result);
            return result;
        } catch (error) {
            return { users: [] };
        }
    }

    saveUsers(data) {
        fs.writeFileSync(this.usersFile, JSON.stringify(data, null, 2));
    }

    getUser(telegramId) {
        telegramId = String(telegramId);
        const data = this.loadUsers();
        let user = data.users.find(u => u.telegramId === telegramId);

        // Auto create user if not exists
        if (!user) {
            user = {
                telegramId,
                name: 'Unknown',
                username: null,
                type: 'free',
                dailyLimit: 1,
                usedToday: 0,
                totalInvites: 0,
                lastReset: this.getTodayWIB(),
                createdAt: new Date().toISOString(),
                expiresAt: null
            };
            data.users.push(user);
            this.saveUsers(data);
        }

        // Daily reset ONLY for premium
        const todayWIB = this.getTodayWIB();
        if (user.type === 'premium' && user.lastReset !== todayWIB) {
            user.usedToday = 0;
            user.lastReset = todayWIB;
            this.updateUser(telegramId, user);
        }

        // Check premium expiry
        if (user.type === 'premium' && user.expiresAt) {
            const now = new Date();
            const expiry = new Date(user.expiresAt);
            if (now > expiry) {
                user.type = 'free';
                user.dailyLimit = 1;
                user.expiresAt = null;
                this.updateUser(telegramId, user);
            }
        }

        return user;
    }

    updateUser(telegramId, updates) {
        telegramId = String(telegramId);
        const data = this.loadUsers();
        const index = data.users.findIndex(u => u.telegramId === telegramId);

        if (index !== -1) {
            data.users[index] = { ...data.users[index], ...updates };
            this.saveUsers(data);
            return true;
        }
        return false;
    }

    updateName(telegramId, name, username = null) {
        if (!name || name === 'Unknown') return;
        const data = this.loadUsers();
        const user = data.users.find(u => u.telegramId === String(telegramId));
        if (user) {
            let changed = false;
            if (user.name !== name) { user.name = name; changed = true; }
            if (username && user.username !== username) { user.username = username; changed = true; }
            if (changed) this.saveUsers(data);
        }
    }

    incrementUsage(telegramId) {
        const user = this.getUser(telegramId);
        user.usedToday++;
        user.totalInvites++;
        this.updateUser(telegramId, user);
        return user;
    }

    canInvite(telegramId) {
        const user = this.getUser(telegramId);
        return user.usedToday < user.dailyLimit;
    }

    getRemainingInvites(telegramId) {
        const user = this.getUser(telegramId);
        return Math.max(0, user.dailyLimit - user.usedToday);
    }

    getUserStats(telegramId) {
        const user = this.getUser(telegramId);
        const remaining = this.getRemainingInvites(telegramId);

        return {
            telegramId: user.telegramId,
            type: user.type,
            usedToday: user.usedToday,
            dailyLimit: user.dailyLimit,
            remaining,
            totalInvites: user.totalInvites,
            expiresAt: user.expiresAt,
            createdAt: user.createdAt
        };
    }

    getAllStats() {
        const data = this.loadUsers();
        const totalUsers = data.users.length;
        const freeUsers = data.users.filter(u => u.type === 'free').length;
        const premiumUsers = data.users.filter(u => u.type === 'premium').length;
        const totalInvitesToday = data.users.reduce((sum, u) => sum + u.usedToday, 0);
        const totalInvitesAll = data.users.reduce((sum, u) => sum + u.totalInvites, 0);

        return { totalUsers, freeUsers, premiumUsers, totalInvitesToday, totalInvitesAll };
    }

    listUsers(filterType = null) {
        const data = this.loadUsers();
        if (filterType) {
            return data.users.filter(u => u.type === filterType);
        }
        return data.users;
    }

    setPremium(telegramId, durationDays = null) {
        const user = this.getUser(telegramId);
        user.type = 'premium';
        user.dailyLimit = 5;
        user.usedToday = 0;
        user.lastReset = this.getTodayWIB();

        if (durationDays) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + durationDays);
            user.expiresAt = expiry.toISOString();
        } else {
            user.expiresAt = null;
        }

        this.updateUser(telegramId, user);
        return user;
    }

    setFree(telegramId) {
        const user = this.getUser(telegramId);
        user.type = 'free';
        user.dailyLimit = 1;
        user.usedToday = 0;
        user.expiresAt = null;
        this.updateUser(telegramId, user);
        return user;
    }

    deleteUser(telegramId) {
        const data = this.loadUsers();
        const index = data.users.findIndex(u => u.telegramId === String(telegramId));

        if (index !== -1) {
            const user = data.users[index];
            data.users.splice(index, 1);
            this.saveUsers(data);
            return { success: true, user };
        }
        return { success: false, message: 'User tidak ditemukan' };
    }
}

export default UserManager;
